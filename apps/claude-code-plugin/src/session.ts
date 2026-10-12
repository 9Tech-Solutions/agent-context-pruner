import type { Message, ToolResult, ToolUse } from "@9tech.solutions/pruner-domain";
import type { SessionMessage, ToolResultSummary, ToolUseSummary } from "claude-code";

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: { ...tool.input },
  };
  const withText = tool.text === undefined ? summary : { ...summary, text: tool.text };
  return tool.isError ? { ...withText, isError: true } : withText;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError ?? false };
}

/**
 * Maps the compacted transcript back onto session messages. Whatever came
 * back unchanged (a message, a tool use, a tool result) is the engine's own
 * object, handle included, so the engine keeps it whole. Anything rebuilt is a
 * fresh message without a handle, which the engine reads as built: its stored
 * tool record (`result`) is left behind with the bulk that was cut.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<object, SessionMessage>(input.map((m) => [m, m]));
  const uses = new Map<object, ToolUseSummary>(
    input.flatMap((m) => m.toolUses.map((tool) => [tool, tool] as const)),
  );
  const results = new Map<object, ToolResultSummary>(
    input.flatMap((m) => (m.toolResults ?? []).map((result) => [result, result] as const)),
  );
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    const toolResults = (message.toolResults ?? []).map(
      (result) => results.get(result) ?? toolResultSummary(result),
    );
    return toolResults.length > 0 ? { ...rebuilt, toolResults } : rebuilt;
  });
}
