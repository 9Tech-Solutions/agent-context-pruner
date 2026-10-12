import { compact, type Message } from "@9tech.solutions/pruner-domain";
import { describe, expect, it } from "vite-plus/test";
import { createHeuristicModel } from "../src/index.ts";
import { call, message, result, unwrap } from "./helpers.ts";

/** Builds a session from tool calls, ending with a user prompt so the calls are not pinned. */
function session(
  ...steps: [string, string, Record<string, unknown>, string, boolean?][]
): Message[] {
  const messages: Message[] = [message("user", "start")];
  for (const [id, tool, input, text, isError] of steps) {
    messages.push(call(id, tool, input, text), result(id, text, isError ?? false));
  }
  messages.push(message("user", "next"));
  return messages;
}

async function actions(messages: Message[], options = {}) {
  const output = unwrap(
    await compact(messages, createHeuristicModel(options), { preserveRecentMessages: 1 }),
  );
  return output.decisions.map((d) => `${d.id}:${d.action}`);
}

const big = "line\n".repeat(1000);

describe("heuristic model", () => {
  it("drops a read that a later read of the same file supersedes", async () => {
    const messages = session(
      ["a", "Read", { file_path: "src/a.ts" }, big],
      ["b", "Read", { file_path: "src\\a.ts" }, big],
    );
    expect(await actions(messages)).toEqual(["t1:drop_call", "t2:drop_result"]);
  });

  it("keeps the call but truncates a read whose file was edited later", async () => {
    const messages = session(
      ["a", "Read", { file_path: "src/a.ts" }, "short"],
      ["b", "Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }, "ok"],
    );
    expect(await actions(messages)).toEqual(["t1:drop_result", "t2:keep"]);
  });

  it("truncates a failed call once the same tool succeeds", async () => {
    const messages = session(
      ["a", "Bash", { command: "npm tset" }, "command not found", true],
      ["b", "Bash", { command: "npm test" }, "ok"],
    );
    expect(await actions(messages)).toEqual(["t1:drop_result", "t2:keep"]);
  });

  it("truncates large results and keeps everything else", async () => {
    const messages = session(
      ["a", "Grep", { pattern: "x" }, big],
      ["b", "Grep", { pattern: "y" }, "one match"],
    );
    expect(await actions(messages)).toEqual(["t1:drop_result", "t2:keep"]);
    expect(await actions(messages, { largeResultChars: 100_000 })).toEqual(["t1:keep", "t2:keep"]);
  });

  it("matches tool names case-insensitively and accepts custom tool lists", async () => {
    const messages = session(
      ["a", "read_file", { path: "a.py" }, "x"],
      ["b", "READ_FILE", { path: "a.py" }, "x"],
    );
    expect(await actions(messages)).toEqual(["t1:drop_call", "t2:keep"]);
    expect(await actions(messages, { readTools: ["cat"] })).toEqual(["t1:keep", "t2:keep"]);
  });

  it("sends no state and makes no requests", async () => {
    const output = unwrap(
      await compact(session(["a", "Read", { file_path: "a" }, "x"]), createHeuristicModel(), {
        preserveRecentMessages: 1,
      }),
    );
    expect(output.stats).toMatchObject({ model: "heuristic:v1", requests: 0, stateStage: "" });
  });
});
