import {
  collectToolCalls,
  compact,
  fitState,
  reductionRatio,
  type Message,
} from "@9tech.solutions/pruner-domain";
import { describe, expect, it } from "vite-plus/test";
import { createSystemOneModel, type HttpRequest } from "../src/index.ts";
import {
  call,
  fakeServer,
  message,
  respond,
  result,
  transcript,
  unwrap,
  unwrapErr,
} from "./helpers.ts";

const jev = { profile: "typesafe" as const, apiKey: "k" };

describe("SystemOne requests", () => {
  it("builds a TypeSafe request with the key, model, state and questions", async () => {
    const seen: HttpRequest[] = [];
    const model = unwrap(
      createSystemOneModel(
        jev,
        fakeServer(() => 0.9, seen),
      ),
    );
    unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));
    expect(model.id).toBe("systemone:typesafe:jev-latest");
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer k");
    const body = JSON.parse(seen[0]!.body);
    expect(body.model).toBe("jev-latest");
    expect(body.state.history).toBeDefined();
    expect(Object.keys(body.questions).sort()).toEqual([
      "call_t1",
      "call_t2",
      "call_t3",
      "result_t1",
      "result_t2",
      "result_t3",
    ]);
  });

  it("targets Cloudflare by account and model, and unwraps its envelope", async () => {
    const seen: HttpRequest[] = [];
    const inner = fakeServer(() => 0.9, seen);
    const wrapped = async (request: HttpRequest) => {
      const response = await inner(request);
      return {
        ...response,
        text: JSON.stringify({ success: true, result: JSON.parse(response.text) }),
      };
    };
    const model = unwrap(
      createSystemOneModel({ profile: "cloudflare", apiKey: "cf", accountId: "acc" }, wrapped),
    );
    unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));
    expect(seen[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef",
    );
  });

  it("talks to a local Ollama without a key", async () => {
    const seen: HttpRequest[] = [];
    const model = unwrap(
      createSystemOneModel(
        { profile: "ollama" },
        fakeServer(() => 0.9, seen),
      ),
    );
    unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));
    expect(seen[0]?.url).toBe("http://localhost:11434/v1/systemone");
    expect(seen[0]?.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(seen[0]!.body).model).toBe("nimble");
  });

  it("never sends the TypeSafe key to a base URL meant for another provider", async () => {
    const seen: HttpRequest[] = [];
    const model = unwrap(
      createSystemOneModel(
        { ...jev, baseUrl: "http://localhost:11434" },
        fakeServer(() => 0.9, seen),
      ),
    );
    unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));
    expect(seen.map((r) => r.url)).toEqual(["https://api.typesafe.ai/v1/systemone"]);
  });

  it("refuses incomplete configuration", () => {
    expect(
      unwrapErr(createSystemOneModel({ profile: "typesafe" }, respond(200, "{}"))).message,
    ).toMatch(/API key/);
    expect(
      unwrapErr(createSystemOneModel({ profile: "cloudflare", apiKey: "k" }, respond(200, "{}")))
        .message,
    ).toMatch(/accountId/);
    expect(
      unwrapErr(createSystemOneModel({ profile: "custom", model: "m" }, respond(200, "{}")))
        .message,
    ).toMatch(/baseUrl/);
    expect(
      unwrapErr(
        createSystemOneModel({ profile: "custom", baseUrl: "http://x" }, respond(200, "{}")),
      ).message,
    ).toMatch(/model name/);
  });
});

describe("SystemOne batching", () => {
  it("resends the full state with every batch and merges the answers", async () => {
    const seen: HttpRequest[] = [];
    const messages = transcript();
    const fitted = unwrap(
      fitState(messages, collectToolCalls(messages, 1), {
        maxStateTokens: 25_000,
        preserveRecentMessages: 1,
        goal: "",
      }),
    );
    const server = fakeServer((name) => (name.startsWith("call_") ? 0.9 : 0.1), seen);
    const model = unwrap(
      createSystemOneModel({ ...jev, maxRequestTokens: fitted.tokens + 150 }, server),
    );
    const output = unwrap(await compact(messages, model, { preserveRecentMessages: 1 }));

    expect(seen.length).toBeGreaterThan(1);
    expect(output.stats.requests).toBe(seen.length);
    const bodies = seen.map((request) => JSON.parse(request.body));
    expect(bodies.flatMap((b) => Object.keys(b.questions)).sort()).toEqual([
      "call_t1",
      "call_t2",
      "call_t3",
      "result_t1",
      "result_t2",
      "result_t3",
    ]);
    expect(new Set(bodies.map((b) => JSON.stringify(b.state))).size).toBe(1);
    expect(output.decisions.map((d) => d.action)).toEqual([
      "drop_result",
      "drop_result",
      "drop_result",
    ]);
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it("respects the per-request question cap", async () => {
    const messages: Message[] = [message("user", "start")];
    for (let i = 0; i < 40; i += 1)
      messages.push(call(`c${i}`, "Read", { file_path: `f${i}.ts` }, "x"), result(`c${i}`, "x"));
    messages.push(message("user", "done"));
    const seen: HttpRequest[] = [];
    const model = unwrap(
      createSystemOneModel(
        { profile: "cloudflare", apiKey: "k", accountId: "a" },
        fakeServer(() => 1, seen),
      ),
    );
    unwrap(await compact(messages, model, { preserveRecentMessages: 1 }));
    const counts = seen.map((request) => Object.keys(JSON.parse(request.body).questions).length);
    expect(counts.every((n) => n <= 64)).toBe(true);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(80);
  });
});

describe("SystemOne failures", () => {
  const run = async (transport: Parameters<typeof createSystemOneModel>[1]) =>
    unwrapErr(
      await compact(transcript(), unwrap(createSystemOneModel(jev, transport)), {
        preserveRecentMessages: 1,
      }),
    );

  it("reports HTTP errors, bad JSON, missing answers and malformed answers", async () => {
    expect(await run(respond(500, "boom"))).toMatchObject({
      kind: "model_failed",
      cause: { kind: "http" },
    });
    expect(await run(respond(200, "not json"))).toMatchObject({
      cause: { kind: "invalid_response" },
    });
    expect(await run(respond(200, "{}"))).toMatchObject({
      cause: { message: expect.stringContaining("missing answers") },
    });
    const partial = respond(200, JSON.stringify({ answers: { call_t1: { noul: 0.5 } } }));
    expect(await run(partial)).toMatchObject({
      cause: { message: "invalid answer for result_t1" },
    });
  });

  it("reports network failures as transport errors", async () => {
    const offline = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await run(offline)).toMatchObject({
      cause: { kind: "transport", message: "ECONNREFUSED" },
    });
  });
});
