import { describe, expect, it } from "vite-plus/test";
import { resolveHookConfig } from "../src/config.ts";
import { compactSession } from "../src/run.ts";
import { decisionLogLines, summarize } from "../src/summary.ts";
import { offline, server, session } from "./fixtures.ts";

const options = { preserveRecentMessages: 2 };

describe("compactSession", () => {
  it("replaces the history with the rules-based model and keeps untouched messages as the engine's own", async () => {
    const input = session();
    const outcome = await compactSession(
      input,
      resolveHookConfig({ ...options, provider: "heuristic" }),
      {},
      offline,
    );
    if (outcome.kind !== "replaced") throw new Error(outcome.reason);

    expect(outcome.result.decisions.map((d) => d.action)).toEqual([
      "drop_call",
      "drop_result",
      "drop_result",
    ]);
    expect(outcome.messages[0]).toBe(input[0]);
    expect(outcome.messages.at(-1)).toBe(input.at(-1));
    expect(outcome.messages.some((m) => m.toolUses.some((t) => t.tool_use_id === "r1"))).toBe(
      false,
    );
    const grep = outcome.messages.find((m) => m.toolResults?.[0]?.tool_use_id === "g1");
    expect(grep?.handle).toBeUndefined();
    expect(grep?.toolResults?.[0]).toEqual({
      tool_use_id: "g1",
      text: expect.stringContaining("[agent-context-pruner truncated"),
      isError: false,
    });
    const note = outcome.messages.find((m) => m.text.includes("removed tool call Read"));
    expect(note).toMatchObject({ role: "user", toolUses: [] });
    expect(note?.text).toContain("file_path=src/a.ts (8000 chars of output); re-run it if needed");
    expect(outcome.log.at(-1)).toMatch(
      /^decisions: 3 scored, 0 kept, 2 truncated, 1 dropped at threshold 0\.50; keep-call median [\d.]+ \([\d.]+ to [\d.]+\), keep-result median /,
    );
    expect(outcome.log.some((line) => line.includes("t1:Read"))).toBe(false);
  });

  it("uses a SystemOne model when one is configured", async () => {
    const config = resolveHookConfig({ ...options, provider: "typesafe", apiKey: "k" });
    const outcome = await compactSession(session(), config, {}, server(0.1));
    if (outcome.kind !== "replaced") throw new Error(outcome.reason);
    expect(outcome.result.stats.model).toBe("systemone:typesafe:jev-latest");
    expect(outcome.result.decisions.every((d) => d.action === "drop_call")).toBe(true);
  });

  it("retries with the rules when the model fails, and logs why", async () => {
    const config = resolveHookConfig({ ...options, provider: "typesafe", apiKey: "k" });
    const outcome = await compactSession(session(), config, {}, offline);
    expect(outcome.kind).toBe("replaced");
    expect(outcome.log[0]).toMatch(
      /systemone:typesafe:jev-latest failed \(.*ECONNREFUSED\); retrying with heuristic:v1/,
    );
  });

  it("falls back to the built-in summary when the model fails and no fallback is allowed", async () => {
    const config = resolveHookConfig({
      ...options,
      provider: "typesafe",
      apiKey: "k",
      fallbackToHeuristic: false,
    });
    const outcome = await compactSession(session(), config, {}, offline);
    expect(outcome).toMatchObject({
      kind: "fallback",
      reason: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("falls back to the built-in summary when too little would be removed", async () => {
    const config = resolveHookConfig({ ...options, provider: "typesafe", apiKey: "k" });
    const outcome = await compactSession(session(), config, {}, server(0.95));
    expect(outcome).toMatchObject({
      kind: "fallback",
      reason: expect.stringContaining("below the 25% minimum"),
    });
  });
});

describe("summary", () => {
  it("summarizes a result and splits long decision logs", async () => {
    const outcome = await compactSession(
      session(),
      resolveHookConfig({ ...options, provider: "heuristic" }),
      {},
      offline,
    );
    if (outcome.kind !== "replaced") throw new Error(outcome.reason);
    expect(summarize(outcome.result)).toMatch(
      /^\d+% reduction; 2 results truncated, 1 calls dropped; heuristic:v1, 0 request\(s\)$/,
    );
    const many = {
      ...outcome.result,
      decisions: Array.from({ length: 200 }, (_, i) => ({
        ...outcome.result.decisions[0]!,
        id: `t${i}`,
      })),
    };
    expect(decisionLogLines(many)).toHaveLength(1);
    const lines = decisionLogLines(many, true);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toMatch(/^decisions: 200 scored/);
    expect(lines[1]).toMatch(/^decision detail \(1\/\d+\): t0:Read:drop_call\/call=/);
    expect(lines.every((line) => line.length < 2000)).toBe(true);
  });
});
