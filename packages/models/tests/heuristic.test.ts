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
    expect(await actions(messages)).toEqual(["t1:drop_call", "t2:keep"]);
  });

  it("keeps a recent read after its file was edited: later edits reuse its unchanged lines", async () => {
    const messages = session(
      ["a", "Read", { file_path: "src/a.ts" }, "short"],
      ["b", "Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" }, "ok"],
    );
    expect(await actions(messages)).toEqual(["t1:keep", "t2:keep"]);
  });

  it("truncates a failed call once the same tool succeeds", async () => {
    const messages = session(
      ["a", "Bash", { command: "npm tset" }, "command not found", true],
      ["b", "Bash", { command: "npm test" }, "ok"],
    );
    expect(await actions(messages)).toEqual(["t1:drop_result", "t2:keep"]);
  });

  it("truncates and then drops results as they age", async () => {
    const messages = session(
      ["a", "Bash", { command: "ls" }, big],
      ["b", "Bash", { command: "pwd" }, big],
      ["c", "Bash", { command: "date" }, big],
      ["d", "Bash", { command: "whoami" }, big],
    );
    expect(await actions(messages, { halfLifeMessages: 2 })).toEqual([
      "t1:drop_call",
      "t2:drop_call",
      "t3:drop_call",
      "t4:drop_result",
    ]);
    expect(await actions(messages)).toEqual(["t1:keep", "t2:keep", "t3:keep", "t4:keep"]);
  });

  it("lets bookkeeping go sooner and keeps what the model wrote longer", async () => {
    const messages: Message[] = [
      message("user", "start"),
      message("assistant", "", {
        toolUses: [
          { tool_use_id: "a", tool: "TaskUpdate", input: { taskId: "1", status: "done" } },
          { tool_use_id: "b", tool: "Write", input: { file_path: "src/b.ts", content: "x" } },
          { tool_use_id: "c", tool: "Bash", input: { command: "ls" } },
        ],
      }),
      message("user", "", {
        toolResults: [
          { tool_use_id: "a", text: "updated" },
          { tool_use_id: "b", text: "created" },
          { tool_use_id: "c", text: big },
        ],
      }),
      message("user", "next"),
    ];
    expect(await actions(messages)).toEqual(["t1:drop_result", "t2:keep", "t3:keep"]);
    expect(await actions(messages, { halfLifeMessages: 2.5 })).toEqual([
      "t1:drop_call",
      "t2:keep",
      "t3:drop_result",
    ]);
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
    expect(output.stats).toMatchObject({ model: "heuristic:v2", requests: 0, stateStage: "" });
  });
});
