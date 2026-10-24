import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  ok,
  type DecisionModel,
  type Message,
  type ScoreRequest,
} from "@9tech.solutions/pruner-domain";
import { createHeuristicModel } from "@9tech.solutions/pruner-models";
import { describe, expect, it } from "vite-plus/test";
import { MAX_INPUT_BYTES, readBoundedInput } from "../src/input.ts";
import { parseRequest } from "../src/protocol.ts";
import { planPruning } from "../src/plan.ts";

function message(role: Message["role"], text = ""): Message {
  return { role, text, toolUses: [] };
}

function pair(id: string, result: string, path = "src/example.ts"): Message[] {
  return [
    {
      role: "assistant",
      text: "",
      toolUses: [{ tool_use_id: id, tool: "Read", input: { file_path: path } }],
    },
    { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: id, text: result }] },
  ];
}

function scoredModel(
  score: { keepCall: number; keepResult: number },
  seen?: ScoreRequest[],
): DecisionModel {
  return {
    id: "test",
    capabilities: {
      state: "none",
      maxStateTokens: 0,
      estimateTokens: (text) => Math.ceil(text.length / 4),
      defaultKeepThreshold: 0.5,
    },
    score: async (request) => {
      seen?.push(request);
      return ok({
        scores: new Map(request.candidates.map((call) => [call.id, score] as const)),
        requests: 1,
      });
    },
  };
}

describe("Codex pruning plan", () => {
  it("retries offline rules when a configured provider fails while scoring", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(503).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("Missing test server address");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
      {
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          PRUNER_PROVIDER: "custom",
          PRUNER_MODEL: "mock",
          PRUNER_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        windowsHide: true,
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    try {
      const ended = once(child, "close");
      child.stdin.end(
        JSON.stringify({
          messages: [
            message("user", "goal"),
            ...pair("old", "x".repeat(900)),
            ...Array.from({ length: 260 }, () => message("assistant", "context")),
          ],
        }),
      );
      const [code] = await ended;
      expect(code).toBe(0);
      expect(requests).toBeGreaterThan(0);
      const result = JSON.parse(stdout) as { model: string; edits: unknown[] };
      expect(result.model).toBe("heuristic:v2");
      expect(result.edits).toHaveLength(1);
    } finally {
      child.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("pairs edits to raw message indexes and leaves first and recent calls pinned", async () => {
    const messages = [
      message("user", "start"),
      ...pair("old", "old output"),
      ...Array.from({ length: 6 }, (_, index) =>
        message(index % 2 ? "assistant" : "user", "context"),
      ),
      ...pair("recent", "recent output"),
    ];
    const seen: ScoreRequest[] = [];
    const result = await planPruning(messages, scoredModel({ keepCall: 0, keepResult: 0 }, seen));

    expect(result.ok && result.value.edits).toEqual([
      { callIndex: 1, resultIndex: 2, callId: "old", action: "drop_call" },
    ]);
    expect(seen[0]?.candidates.map((call) => call.tool_use_id)).toEqual(["old"]);
  });

  it("uses the exact truncated result text returned by compact", async () => {
    const output = "x".repeat(900);
    const messages = [
      message("user", "start"),
      ...pair("large", output),
      ...Array.from({ length: 6 }, () => message("user", "context")),
    ];
    const result = await planPruning(messages, scoredModel({ keepCall: 1, keepResult: 0 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.edits).toEqual([
      {
        callIndex: 1,
        resultIndex: 2,
        callId: "large",
        action: "drop_result",
        text: `${"x".repeat(300)}\n[agent-context-pruner truncated 600 chars of this tool result; re-run the tool if needed]`,
      },
    ]);
  });

  it("skips only a result whose truncation splits an emoji surrogate pair", async () => {
    const splitOutput = `${"x".repeat(299)}😀${"y".repeat(300)}`;
    const validOutput = "z".repeat(900);
    const messages = [
      message("user", "start"),
      ...pair("split", splitOutput),
      ...pair("valid", validOutput),
      ...Array.from({ length: 6 }, () => message("user", "context")),
    ];
    const result = await planPruning(messages, scoredModel({ keepCall: 1, keepResult: 0 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.edits).toHaveLength(1);
    expect(result.value.edits[0]).toMatchObject({
      callIndex: 3,
      resultIndex: 4,
      callId: "valid",
      action: "drop_result",
      text: `${"z".repeat(300)}\n[agent-context-pruner truncated 600 chars of this tool result; re-run the tool if needed]`,
    });
  });

  it("pins a named filename from instructions", async () => {
    const messages = [
      message("user", "start"),
      ...pair("named", "output", "C:\\repo\\src\\Auth.ts"),
      ...Array.from({ length: 6 }, () => message("user", "context")),
    ];
    const result = await planPruning(
      messages,
      scoredModel({ keepCall: 0, keepResult: 0 }),
      "keep src/auth.ts",
    );

    expect(result.ok && result.value.edits).toEqual([]);
  });

  it("reduces an old synthetic transcript with the offline heuristic", async () => {
    const output = "export const value = 1;\n".repeat(500);
    const messages = [
      message("user", "start"),
      ...pair("old-read", output),
      ...Array.from({ length: 120 }, () => message("assistant", "later context")),
    ];
    const result = await planPruning(messages, createHeuristicModel());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("heuristic:v2");
    expect(result.value.edits).toHaveLength(1);
    expect(result.value.edits[0]?.action).toBe("drop_result");
    expect(result.value.edits[0]?.text?.length).toBeLessThan(output.length / 10);
  });
});

describe("Codex request validation", () => {
  it("accepts the JSON contract, including empty placeholder messages", () => {
    const request = parseRequest(
      JSON.stringify({ messages: [message("user"), ...pair("a", "r")] }),
    );

    expect(request.ok && request.value.messages).toHaveLength(3);
  });

  it("rejects invalid JSON and malformed nested message fields", () => {
    expect(parseRequest("{").ok).toBe(false);
    expect(
      parseRequest(JSON.stringify({ messages: [{ role: "user", text: "x", toolUses: [{}] }] })).ok,
    ).toBe(false);
    expect(parseRequest(JSON.stringify({ messages: [message("user")], instructions: 9 })).ok).toBe(
      false,
    );
  });

  it("stops before buffering stdin beyond 32 MiB", async () => {
    const input = Readable.from([Buffer.alloc(MAX_INPUT_BYTES + 1)]);

    expect(await readBoundedInput(input)).toMatchObject({ ok: false, error: "input_too_large" });
  });
});
