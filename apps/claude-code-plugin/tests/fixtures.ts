import type { HttpTransport } from "@9tech.solutions/pruner-models";
import type { SessionMessage } from "claude-code";

let handles = 0;

/** A session message as the engine hands it to `session.compact`: with a handle. */
export function row(message: Omit<SessionMessage, "handle">): SessionMessage {
  handles += 1;
  return { ...message, handle: `h${handles}` };
}

export function say(role: SessionMessage["role"], text: string): SessionMessage {
  return row({ role, text, toolUses: [] });
}

export function toolCall(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  text: string,
): SessionMessage {
  return row({
    role: "assistant",
    text: "",
    toolUses: [{ tool_use_id: id, tool, input, text, result: { bulk: text } }],
  });
}

export function toolResult(id: string, text: string, isError = false): SessionMessage {
  return row({
    role: "user",
    text: "",
    toolResults: [{ tool_use_id: id, text, isError, result: { bulk: text } }],
    toolUses: [],
  });
}

const big = "export const x = 1;\n".repeat(400);

/** Two reads of the same file and a large grep, then the latest prompt: plenty to prune. */
export function session(): SessionMessage[] {
  return [
    say("user", "Fix the failing test."),
    toolCall("r1", "Read", { file_path: "src/a.ts" }, big),
    toolResult("r1", big),
    toolCall("g1", "Grep", { pattern: "x" }, big),
    toolResult("g1", big),
    toolCall("r2", "Read", { file_path: "src/a.ts" }, big),
    toolResult("r2", big),
    say("assistant", "Found it."),
    say("user", "go ahead"),
  ];
}

/** A SystemOne server answering every question with `answer`. */
export function server(answer: number): HttpTransport {
  return async (request) => {
    const body = JSON.parse(request.body) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((name) => [name, { noul: answer }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

export const offline: HttpTransport = async () => {
  throw new Error("ECONNREFUSED");
};
