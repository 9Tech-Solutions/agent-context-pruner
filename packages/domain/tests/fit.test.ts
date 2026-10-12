import { describe, expect, it } from "vite-plus/test";
import {
  collectToolCalls,
  estimateTokens,
  fitState,
  type HistoryToolCall,
  type Message,
} from "../src/index.ts";
import { call, fileA, message, result, transcript, unwrap, unwrapErr } from "./fixtures.ts";

const fit = { maxStateTokens: 25_000, preserveRecentMessages: 0, goal: "fix the test" };

function firstCall(
  entry: { tool_calls?: readonly HistoryToolCall[] | readonly string[] } | undefined,
) {
  return entry?.tool_calls?.[0] as HistoryToolCall;
}

describe("state fitting", () => {
  it("sends the whole history with tool results replaced by a note", () => {
    const messages = transcript();
    const { state, stage } = unwrap(fitState(messages, collectToolCalls(messages, 0), fit));
    expect(stage).toBe("full");
    const json = JSON.stringify(state);
    expect(json).not.toContain("export const a = 1;");
    expect(json).toContain("Never edit anything under src/generated");
    expect(json).toContain("go ahead");
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(firstCall(state.history[1])).toMatchObject({
      id: "t1",
      tool: "Read",
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect(firstCall(state.history[4]).result).toMatch(/^error, /);
  });

  it("defaults the goal to the latest user prompts", () => {
    const { state } = unwrap(fitState(transcript(), [], { ...fit, goal: "" }));
    expect(state.goal).toContain("Fix the failing test");
    expect(state.goal).toContain("go ahead");
  });

  it("truncates tool inputs before touching message text", () => {
    const messages = [
      message("user", "start"),
      call("w", "Write", { file_path: "x.ts", content: "x".repeat(5000) }, "ok"),
      result("w", "ok"),
      message("assistant", "written"),
    ];
    const fitted = unwrap(
      fitState(messages, collectToolCalls(messages, 0), { ...fit, maxStateTokens: 300 }),
    );
    expect(fitted.stage).toBe("inputs<=200");
    expect(fitted.tokens).toBeLessThanOrEqual(300);
    expect(fitted.state.history[0]?.text).toBe("start");
    expect(firstCall(fitted.state.history[1]).input.length).toBeLessThanOrEqual(200);
  });

  it("shrinks old tool calls to one line each, then merges runs of them", () => {
    const messages: Message[] = [message("user", "start")];
    for (let i = 0; i < 40; i += 1) {
      messages.push(
        call(`c${i}`, "Read", { file_path: `/repo/src/module-${i}.ts` }, "x"),
        result(`c${i}`, "x"),
      );
    }
    messages.push(message("assistant", "done"));
    const calls = collectToolCalls(messages, 1);
    const options = { ...fit, preserveRecentMessages: 1 };
    const full = unwrap(fitState(messages, calls, options));

    const compacted = unwrap(
      fitState(messages, calls, { ...options, maxStateTokens: Math.floor(full.tokens * 0.8) }),
    );
    expect(compacted.stage).toBe("old calls compacted");
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(
      estimateTokens(JSON.stringify(compacted.state)),
    );
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      "t1 Read file_path=/repo/src/module-0.ts → ok 1ch",
    );
    expect(compacted.state.history.at(-1)?.text).toBe("done");

    const merged = unwrap(
      fitState(messages, calls, { ...options, maxStateTokens: Math.floor(full.tokens * 0.45) }),
    );
    expect(merged.stage).toBe("old calls merged");
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe("start");
    expect(merged.state.history[2]?.text).toBe("done");
  });

  it("abridges long texts oldest-first and collapses old messages last", () => {
    const long = (n: number) => `${n} ` + "lorem ipsum ".repeat(300);
    const messages = [0, 1, 2, 3].map((n) => message(n % 2 === 0 ? "user" : "assistant", long(n)));
    messages.push(message("user", "latest"));
    const options = { ...fit, preserveRecentMessages: 1 };

    const abridged = unwrap(fitState(messages, [], { ...options, maxStateTokens: 1800 }));
    expect(abridged.stage).toBe("texts abridged");
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain("chars omitted");
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe("latest");

    const collapsed = unwrap(fitState(messages, [], { ...options, maxStateTokens: 420 }));
    expect(collapsed.stage).toBe("old messages collapsed");
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain("lorem");
    expect(collapsed.state.history[4]?.text).toBe("latest");
  });

  it("returns an error when the history cannot be fitted", () => {
    const messages = [message("user", "a".repeat(2000)), message("assistant", "b")];
    const error = unwrapErr(fitState(messages, [], { ...fit, maxStateTokens: 50 }));
    expect(error.kind).toBe("state_too_large");
    expect(error.message).toMatch(/too large/);
    expect(error.limit).toBe(50);
  });

  it("uses the estimator it is given", () => {
    const messages = transcript();
    const doubled = unwrap(
      fitState(messages, collectToolCalls(messages, 0), {
        ...fit,
        estimateTokens: (t) => 2 * estimateTokens(t),
      }),
    );
    const plain = unwrap(fitState(messages, collectToolCalls(messages, 0), fit));
    expect(doubled.tokens).toBeGreaterThan(plain.tokens * 1.9);
  });
});
