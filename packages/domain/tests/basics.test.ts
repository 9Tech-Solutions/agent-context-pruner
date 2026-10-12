import { describe, expect, it } from "vite-plus/test";
import { collectToolCalls, estimateTokens, resolveOptions } from "../src/index.ts";
import { call, fileA, message, transcript } from "./fixtures.ts";

describe("options", () => {
  it("fills in defaults and ignores non-finite values", () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      truncateHeadChars: 300,
    });
    expect(
      resolveOptions({
        keepThreshold: Number.NaN,
        preserveRecentMessages: 2.7,
        truncateHeadChars: -1.2,
      }),
    ).toMatchObject({ keepThreshold: 0.5, preserveRecentMessages: 2, truncateHeadChars: 0 });
  });

  it("puts caller options over model defaults over the built-in defaults", () => {
    const model = { keepThreshold: 0.7, maxStateTokens: 50_000 };
    expect(resolveOptions({}, model)).toMatchObject({ keepThreshold: 0.7, maxStateTokens: 50_000 });
    expect(resolveOptions({ keepThreshold: 0.3 }, model)).toMatchObject({ keepThreshold: 0.3 });
    expect(resolveOptions({}, { keepThreshold: Number.NaN })).toMatchObject({ keepThreshold: 0.5 });
  });
});

describe("token estimate", () => {
  it("charges words, digits and symbols separately and never undercounts JSON badly", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(2);
    expect(estimateTokens("internationalization")).toBe(4);
    expect(estimateTokens("12345678")).toBe(4);
    const json = JSON.stringify({ file_path: "/Users/x/src/a.ts", old_string: "a = 1;", n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });
});

describe("tool call collection", () => {
  it("pairs each tool call with its result and pins recent ones", () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ["t1", "Read", 1, 2, false],
      ["t2", "Read", 4, 5, false],
      ["t3", "Bash", 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it("ignores calls without a result", () => {
    expect(collectToolCalls([message("user", "hi"), call("x", "Read", {}, "")], 0)).toHaveLength(0);
  });
});
