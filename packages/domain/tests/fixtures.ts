import type {
  CallScore,
  DecisionModel,
  Message,
  ModelCapabilities,
  Result,
  ScoreRequest,
  ToolCall,
} from "../src/index.ts";
import { estimateTokens, ok } from "../src/index.ts";

export function message(
  role: Message["role"],
  text: string,
  extra: Partial<Message> = {},
): Message {
  return { role, text, toolUses: [], ...extra };
}

export function call(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  text: string,
): Message {
  return message("assistant", "", { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

export function result(id: string, text: string, isError = false): Message {
  return message("user", "", { toolResults: [{ tool_use_id: id, text, isError }] });
}

export const fileA = "export const a = 1;\n".repeat(50);
export const fileB = "export const b = 2;\n".repeat(50);

/** A short coding session: two reads, a failing test run, then the latest prompt. */
export function transcript(bText: string = fileB): Message[] {
  return [
    message("user", "Never edit anything under src/generated. Fix the failing test."),
    call("tool-1", "Read", { file_path: "src/a.ts" }, fileA),
    result("tool-1", fileA),
    message("assistant", "a.ts looks fine; checking b.ts"),
    call("tool-2", "Read", { file_path: "src/b.ts" }, bText),
    result("tool-2", bText),
    call("tool-3", "Bash", { command: "npm test" }, "FAIL b.test.ts"),
    result("tool-3", "FAIL b.test.ts: expected 2 to be 3", true),
    message("assistant", "The failure is in b.test.ts; fixing now."),
    message("user", "go ahead"),
  ];
}

export function unwrap<T, E>(value: Result<T, E>): T {
  if (!value.ok) throw new Error(`expected ok, got ${JSON.stringify(value.error)}`);
  return value.value;
}

export function unwrapErr<T, E>(value: Result<T, E>): E {
  if (value.ok) throw new Error("expected an error result");
  return value.error;
}

/** A decision model that scores every candidate with `score` and records each request. */
export function fakeModel(
  score: (call: ToolCall) => CallScore,
  seen: ScoreRequest[] = [],
  capabilities: Partial<ModelCapabilities> = {},
): DecisionModel {
  return {
    id: "fake",
    capabilities: {
      state: "global",
      maxStateTokens: 25_000,
      estimateTokens,
      defaultKeepThreshold: 0.5,
      ...capabilities,
    },
    score: async (request) => {
      seen.push(request);
      return ok({ scores: new Map(request.candidates.map((c) => [c.id, score(c)])), requests: 1 });
    },
  };
}
