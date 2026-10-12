import type { Engine, SessionCompactInput, SessionCompactResult } from "claude-code";
import { describe, expect, it } from "vite-plus/test";
import { DISCARD_NOTE, handleCompact, PRECOMPUTE_SKIP, probeOf } from "../src/compact-hook.ts";
import { resolveHookConfig } from "../src/config.ts";
import { session } from "./fixtures.ts";

function engine(log: string[]): Engine {
  return {
    ui: { log: (text) => log.push(text), toast: () => undefined },
    http: {
      fetch: async () => {
        throw new Error("offline");
      },
    },
    env: { get: async () => undefined },
    session: {
      usage: async () => ({ context: {} }),
      compact: async () => ({ skip: "unused" }),
    },
  };
}

/** Stands for core: records what it was asked to compact and answers `answer`. */
function core(answer: SessionCompactResult | Error, seen: SessionCompactInput[]) {
  return async (e: SessionCompactInput): Promise<SessionCompactResult> => {
    seen.push(e);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const base = { provider: "heuristic", preserveRecentMessages: 2 };
const summary: SessionCompactResult = {
  messages: [{ role: "user", text: "summary", toolUses: [] }],
};

async function run(options: Record<string, string | number>, answer: SessionCompactResult | Error) {
  const log: string[] = [];
  const seen: SessionCompactInput[] = [];
  const e: SessionCompactInput = { trigger: "manual", messages: session(), instructions: "keep x" };
  const config = resolveHookConfig({ ...base, ...options });
  const result = await handleCompact(config, engine(log), e, core(answer, seen));
  return { e, log, seen, result };
}

describe("session.compact hook", () => {
  it("lets core run the PreCompact hooks on a stand-in, then answers with the pruned history", async () => {
    const { e, log, seen, result } = await run({}, summary);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.instructions).toBe(`keep x

${DISCARD_NOTE}`);
    expect(seen[0]?.messages).toEqual(probeOf(e.messages));
    expect(seen[0]?.messages.every((m) => m.handle === undefined && m.toolUses.length === 0)).toBe(
      true,
    );
    expect("messages" in result && result.messages).not.toEqual(summary.messages);
    expect(
      "messages" in result && result.messages?.some((m) => m.text.includes("removed tool call")),
    ).toBe(true);
    expect(
      log.some((line) => /^PreCompact hooks ran through core compaction in \d+ ms$/.test(line)),
    ).toBe(true);
  });

  it("tells core its summary is discarded and logs what that summary cost", async () => {
    const usage = {
      input_tokens: 900,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const { log } = await run({}, { ...summary, usage });
    expect(log.some((line) => /in \d+ ms, 12 output tokens$/.test(line))).toBe(true);
  });

  it("respects a PreCompact hook that blocks the compaction", async () => {
    const { result, log } = await run({}, { skip: "PreCompact hook blocked" });
    expect(result).toEqual({ skip: "PreCompact hook blocked" });
    expect(log.at(-1)).toBe("compaction skipped (PreCompact hook blocked)");
  });

  it("never calls core when PreCompact hooks are set to skip", async () => {
    const { seen, result } = await run({ preCompactHooks: "skip" }, summary);
    expect(seen).toHaveLength(0);
    expect("messages" in result && result.messages?.length).toBeGreaterThan(0);
  });

  it("keeps the pruned history when core fails mid-way, without calling it twice", async () => {
    const { seen, result, log } = await run({}, new Error("core broke"));
    expect(seen).toHaveLength(1);
    expect("messages" in result && result.messages?.length).toBeGreaterThan(0);
    expect(log.some((line) => line.includes("core broke"))).toBe(true);
  });

  it("hands core the original transcript when pruning would remove too little", async () => {
    const { e, seen, result } = await run({ minReductionRatio: 0.999 }, summary);
    expect(seen).toEqual([e]);
    expect(result).toBe(summary);
  });

  it("skips precompute dispatches so nothing runs twice", async () => {
    const log: string[] = [];
    const seen: SessionCompactInput[] = [];
    const e: SessionCompactInput = { trigger: "precompute", messages: session() };
    expect(
      await handleCompact(resolveHookConfig(base), engine(log), e, core(summary, seen)),
    ).toEqual({ skip: PRECOMPUTE_SKIP });
    expect(seen).toHaveLength(0);
  });
});

describe("probeOf", () => {
  it("keeps the last four messages with text, without handles or tool blocks", () => {
    const probe = probeOf(session());
    expect(probe.map((m) => m.text)).toEqual(["Fix the failing test.", "Found it.", "go ahead"]);
    expect(probeOf([])).toEqual([
      { role: "user", text: "(compacted by agent-context-pruner)", toolUses: [] },
    ]);
  });
});
