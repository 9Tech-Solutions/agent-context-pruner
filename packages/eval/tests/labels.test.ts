import { collectToolCalls, type Message } from "@9tech.solutions/pruner-domain";
import { describe, expect, it } from "vite-plus/test";
import { labelCut, lineFragments, sweep, wordFragments, type CutEvaluation } from "../src/index.ts";
import { AUTH_LINES, call, message, numbered, result, session } from "./helpers.ts";

const CUT = 7;

function labels(messages = session(), cut = CUT) {
  const calls = collectToolCalls(messages.slice(0, cut), 0);
  return labelCut(messages, cut, calls).labels;
}

const NONE = { resultNeeded: false, neededUntil: 0, inputNeeded: false, callNeeded: false };

/** A cut evaluation with fixed scores per call id, for checking loss without a model. */
function evaluation(
  messages: Message[],
  cut: number,
  scores: Record<string, number>,
): CutEvaluation {
  const history = messages.slice(0, cut);
  const calls = collectToolCalls(history, 0);
  const { labels: byId, needed } = labelCut(messages, cut, calls);
  const scored = calls.map((c) => {
    const score = scores[c.id] ?? 1;
    return {
      id: c.id,
      tool: c.tool,
      resultChars: c.resultChars,
      label: byId.get(c.id)!,
      keepCall: score,
      keepResult: score,
    };
  });
  return { cut, history, calls, scored, needed, requests: 0, ms: 0 };
}

const lostAt = (e: CutEvaluation) => sweep([e], 300, [0.5])[0]!.lost;

describe("fragments", () => {
  it("strips cat -n line numbers and skips short lines", () => {
    const fragments = lineFragments(numbered(["}", "  return token.length > 0 && ok;"]));
    expect(fragments.map((f) => f.text)).toEqual(["return token.length > 0 && ok;"]);
    expect(fragments[0]!.end).toBe(numbered(["}", "  return token.length > 0 && ok;"]).length);
  });

  it("skips closing tags and slash commands", () => {
    expect(
      wordFragments("</system-reminder> /reload-plugins /v1/systemone").map((w) => w.text),
    ).toEqual(["/v1/systemone"]);
  });

  it("keeps ids, paths and camelCase names but not plain long words", () => {
    const words = wordFragments(
      "implementation of createHeuristicModel at src/models/x.ts sha 3de1951abc12",
    );
    expect(words.map((w) => w.text)).toEqual([
      "createHeuristicModel",
      "src/models/x.ts",
      "3de1951abc12",
    ]);
  });
});

describe("labelCalls", () => {
  it("marks a read as needed when a later edit copies one of its lines", () => {
    const auth = labels().get("t1")!;
    expect(auth.resultNeeded).toBe(true);
    expect(auth.callNeeded).toBe(true);
    expect(auth.neededUntil).toBe(numbered(AUTH_LINES.slice(0, 2)).length);
  });

  it("leaves unused results unneeded", () => {
    expect(labels().get("t2")).toEqual(NONE);
  });

  it("does not count a later tool result repeating the text as use", () => {
    const messages = [
      ...session().slice(0, CUT),
      call("u9", "Read", { file_path: "docs/notes.md" }),
      result("u9", numbered(["Context compaction for AI coding agents that never summarizes."])),
      message("assistant", "ok"),
    ];
    expect(labels(messages).get("t2")!.resultNeeded).toBe(false);
  });

  it("does not credit a result with lines another message also held", () => {
    const line = "  return token.length > 0 && !revokedTokens.has(token);";
    const messages = [message("user", `Look at this line:\n${line}`), ...session().slice(1)];
    expect(labels(messages).get("t1")!.resultNeeded).toBe(false);
  });

  it("counts a later mention of the file as needing the call", () => {
    const messages = [
      ...session().slice(0, CUT),
      message("assistant", "README.md still describes the old behaviour."),
    ];
    expect(labels(messages).get("t2")).toEqual({ ...NONE, callNeeded: true });
  });

  it("needs only the most recent copy, and loses text only when every copy goes", () => {
    const edit = session().slice(CUT);
    const twice = [
      ...session().slice(0, 3),
      call("u7", "Read", { file_path: "src/auth.ts" }),
      result("u7", numbered(AUTH_LINES)),
      message("user", "Also reject empty tokens explicitly."),
      ...edit.slice(1),
    ];
    const cut = 5;
    expect(labels(twice, cut).get("t1")!.resultNeeded).toBe(false);
    expect(labels(twice, cut).get("t2")!.resultNeeded).toBe(true);
    expect(lostAt(evaluation(twice, cut, { t1: 0.1, t2: 0.1 }))).toBe(1);
    expect(lostAt(evaluation(twice, cut, { t1: 0.9, t2: 0.1 }))).toBe(0);
    expect(lostAt(evaluation(twice, cut, { t1: 0.1, t2: 0.9 }))).toBe(0);
  });

  it("does not charge a read the session repeated after the cut before reusing it", () => {
    const messages = [
      ...session().slice(0, CUT + 2),
      call("u8", "Read", { file_path: "src/auth.ts" }),
      result("u8", numbered(AUTH_LINES)),
      ...session().slice(CUT + 2),
    ];
    expect(labels(messages).get("t1")!.resultNeeded).toBe(false);
    expect(lostAt(evaluation(messages, CUT, { t1: 0.1, t2: 0.1, t3: 0.1 }))).toBe(0);
  });

  it("keeps text two results in one message share while either stays", () => {
    const line = AUTH_LINES[1]!;
    const messages = [
      message("user", "Tighten the session check."),
      message("assistant", "", {
        toolUses: [
          { tool_use_id: "a", tool: "Read", input: { file_path: "src/auth.ts" } },
          { tool_use_id: "b", tool: "Grep", input: { pattern: "revoked" } },
        ],
      }),
      message("user", "", {
        toolResults: [
          { tool_use_id: "a", text: numbered(AUTH_LINES) },
          { tool_use_id: "b", text: `src/auth.ts:2:${line}` },
        ],
      }),
      message("user", "fix it"),
      call("e", "Edit", { file_path: "src/auth.ts", old_string: line }),
    ];
    expect(lostAt(evaluation(messages, 3, { t1: 0.9, t2: 0.1 }))).toBe(0);
    expect(lostAt(evaluation(messages, 3, { t1: 0.1, t2: 0.1 }))).toBe(1);
  });

  it("needs a Write's input when its content is reused, charging the input's size", () => {
    const content = "export const sessionTimeoutMs = 30 * 60 * 1000;";
    const messages = [
      message("user", "Add a timeout constant."),
      call("w", "Write", { file_path: "src/timeout.ts", content }),
      result("w", "File created successfully at: src/timeout.ts"),
      message("user", "make it 20 minutes"),
      call("e", "Edit", { file_path: "src/timeout.ts", old_string: content }),
    ];
    expect(labels(messages, 3).get("t1")).toMatchObject({ inputNeeded: true });
    const row = sweep([evaluation(messages, 3, { t1: 0.1 })], 300, [0.5])[0]!;
    expect(row.lost).toBe(1);
    expect(row.reduction - row.netReduction).toBeGreaterThan(0);
  });

  it("does not take a later file under a searched directory as naming the search", () => {
    const messages = [
      message("user", "Find the helper."),
      call("g", "Grep", { pattern: "unusedHelperXyz", path: "C:/work/repo" }),
      result("g", "No matches found"),
      call("h", "Glob", { pattern: "*.ts", path: "." }),
      result("h", "No files found"),
      message("user", "read args"),
      call("r", "Read", { file_path: "C:/work/repo/apps/cli/src/args.ts" }),
    ];
    expect(labels(messages, 5).get("t1")).toEqual(NONE);
    expect(labels(messages, 5).get("t2")).toEqual(NONE);
  });
});
