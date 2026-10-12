import {
  estimateTokens,
  ok,
  type CallScore,
  type DecisionModel,
  type Message,
  type ToolCall,
} from "@9tech.solutions/pruner-domain";

export function message(
  role: Message["role"],
  text: string,
  extra: Partial<Message> = {},
): Message {
  return { role, text, toolUses: [], ...extra };
}

export function call(id: string, tool: string, input: Record<string, unknown>): Message {
  return message("assistant", "", { toolUses: [{ tool_use_id: id, tool, input }] });
}

export function result(id: string, text: string): Message {
  return message("user", "", { toolResults: [{ tool_use_id: id, text }] });
}

/** Claude Code's Read output: `cat -n` numbered lines. */
export function numbered(lines: readonly string[]): string {
  return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
}

export const AUTH_LINES = [
  "export function verifySession(token: string): boolean {",
  "  return token.length > 0 && !revokedTokens.has(token);",
  "}",
];

export const README_LINES = [
  "# agent-context-pruner",
  "Context compaction for AI coding agents that never summarizes.",
];

/**
 * Reads auth.ts and README.md, runs a search, then (after the prompt at
 * index 7) edits auth.ts with a line copied from the read. Neither README.md
 * nor the search output is used again.
 */
export function session(): Message[] {
  return [
    message("user", "Tighten the session check."),
    call("u1", "Read", { file_path: "src/auth.ts" }),
    result("u1", numbered(AUTH_LINES)),
    call("u2", "Read", { file_path: "README.md" }),
    result("u2", numbered(README_LINES)),
    call("u3", "Grep", { pattern: "revokedTokens" }),
    result("u3", "src/auth.ts:2: revokedTokens lookup happens in the session_store_v2 module"),
    message("user", "Also reject empty tokens explicitly."),
    message("assistant", "Editing auth.ts."),
    call("u4", "Edit", {
      file_path: "src/auth.ts",
      old_string: "  return token.length > 0 && !revokedTokens.has(token);",
      new_string: "  if (token === '') return false;\n  return !revokedTokens.has(token);",
    }),
    result("u4", "The file src/auth.ts has been updated."),
    message("assistant", "Done."),
  ];
}

/** A model that scores calls by tool name, for predictable sweeps. */
export function scoreByTool(scores: Readonly<Record<string, CallScore>>): DecisionModel {
  const fallback: CallScore = { keepCall: 0.5, keepResult: 0.5 };
  return {
    id: "by-tool",
    capabilities: { state: "none", maxStateTokens: 0, estimateTokens, defaultKeepThreshold: 0.5 },
    score: async (request) =>
      ok({
        scores: new Map(
          request.candidates.map((c: ToolCall) => [c.id, scores[c.tool] ?? fallback] as const),
        ),
        requests: 1,
      }),
  };
}
