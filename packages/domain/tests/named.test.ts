import { describe, expect, it } from "vite-plus/test";
import {
  callPath,
  collectToolCalls,
  compact,
  isNamed,
  namedPaths,
  pinNamed,
  type ScoreRequest,
} from "../src/index.ts";
import { fakeModel, transcript, unwrap } from "./fixtures.ts";

describe("files named in the instructions", () => {
  it("finds path-like words and matches them by full path or by ending", () => {
    expect(namedPaths("keep worker-prompt-rules.md, and src\\Auth.ts. Thanks")).toEqual([
      "worker-prompt-rules.md",
      "src/auth.ts",
    ]);
    expect(namedPaths("keep the login flow")).toEqual([]);
    expect(isNamed("C:/Users/x/.claude/worker-prompt-rules.md", ["worker-prompt-rules.md"])).toBe(
      true,
    );
    expect(isNamed("C:/repo/src/Auth.ts", ["src/auth.ts"])).toBe(true);
    expect(isNamed("C:/repo/src/other-auth.ts", ["auth.ts"])).toBe(false);
    expect(callPath({ file_path: "C:\\repo\\a.ts" })).toBe("C:/repo/a.ts");
    expect(callPath({ command: "ls" })).toBeUndefined();
  });

  it("pins the calls on named files and leaves the rest", () => {
    const calls = collectToolCalls(transcript(), 0);
    expect(pinNamed(calls, "keep src/b.ts").map((c) => [c.id, c.pinned])).toEqual([
      ["t1", false],
      ["t2", true],
      ["t3", false],
    ]);
    expect(pinNamed(calls, "")).toEqual(calls);
  });

  it("keeps a named file whole whatever the model scores, and never asks about it", async () => {
    const seen: ScoreRequest[] = [];
    const model = fakeModel(() => ({ keepCall: 0, keepResult: 0 }), seen);
    const output = unwrap(
      await compact(transcript(), model, { preserveRecentMessages: 1, instructions: "keep b.ts" }),
    );
    expect(seen[0]?.candidates.map((c) => c.id)).toEqual(["t1", "t3"]);
    expect(output.decisions.map((d) => [d.id, d.action, d.reason])).toEqual([
      ["t1", "drop_call", "call_dropped"],
      ["t2", "keep", "pinned"],
      ["t3", "drop_call", "call_dropped"],
    ]);
  });
});
