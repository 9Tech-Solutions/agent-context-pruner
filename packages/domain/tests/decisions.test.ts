import { describe, expect, it } from "vite-plus/test";
import { applyDecisions, collectToolCalls, decideCall } from "../src/index.ts";
import { transcript } from "./fixtures.ts";

const options = { keepThreshold: 0.5 };
const note = (cut: number) =>
  `[agent-context-pruner truncated ${cut} chars of this tool result; re-run the tool if needed]`;

describe("decisions", () => {
  const unpinned = { id: "t1", tool: "Read", pinned: false };

  it("keeps, drops the result, or drops the call based on the keep probabilities", () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe("keep");
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe(
      "drop_result",
    );
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe(
      "drop_call",
    );
    expect(
      decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options),
    ).toMatchObject({
      action: "keep",
      reason: "pinned",
    });
  });

  it("removes dropped calls and truncates dropped results", () => {
    const messages = transcript("x".repeat(2000));
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(
      kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id),
    ).toEqual([
      "Never edit anything under src/generated. Fix the failing test.",
      "a.ts looks fine; checking b.ts",
      "tool-2",
      "tool-2",
      "tool-3",
      "tool-3",
      "The failure is in b.test.ts; fixing now.",
      "go ahead",
    ]);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]?.toolUses[0]?.text).toBe(`${"x".repeat(300)}\n${note(1700)}`);
    expect(kept[3]?.toolResults?.[0]?.text).toBe(`${"x".repeat(300)}\n${note(1700)}`);
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain("expected 2 to be 3");

    const short = transcript("y".repeat(100));
    const shortKept = applyDecisions(short, decisions, calls, 300);
    expect(shortKept[2]).toBe(short[4]);
    expect(shortKept[3]).toBe(short[5]);
  });

  it("honours truncateHeadChars, including a zero head", () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, options)];
    const original = messages[2]!.toolResults![0]!.text;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n${note(original.length - 50)}`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(note(original.length));
  });

  it("returns the input messages untouched when every call is kept", () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((c) => decideCall(c, { keepCall: 1, keepResult: 1 }, options));
    const kept = applyDecisions(messages, decisions, calls, 300);
    expect(kept).toEqual(messages);
    kept.forEach((m, i) => expect(m).toBe(messages[i]));
  });
});
