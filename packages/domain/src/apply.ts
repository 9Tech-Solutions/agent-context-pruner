import type { CallAction, CallDecision } from "./decision.ts";
import type { ToolCall } from "./tool-call.ts";
import type { Message, ToolResult, ToolUse } from "./transcript.ts";

type DropAction = Exclude<CallAction, "keep">;
type Actions = ReadonlyMap<string, DropAction>;

/** Results within this many characters of the head are kept whole: the note would not save anything. */
const NOTE_SLACK = 120;

/** A dropped result: its first `headChars` characters and a note saying how much was cut. */
export function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + NOTE_SLACK) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  const error = isError ? " (error)" : "";
  return `${head}[agent-context-pruner truncated ${text.length - headChars} chars of this tool result${error}; re-run the tool if needed]`;
}

function actionsByToolUseId(
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
): Map<string, DropAction> {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, DropAction>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== "keep") actions.set(call.tool_use_id, decision.action);
  }
  return actions;
}

function rebuildToolUse(tool: ToolUse, actions: Actions, headChars: number): ToolUse {
  if (actions.get(tool.tool_use_id) !== "drop_result") return tool;
  const text = truncatedResultText(tool.text ?? "", tool.isError ?? false, headChars);
  if ((tool.text ?? "") === text) return tool;
  const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input, text };
  return tool.isError ? { ...copy, isError: true } : copy;
}

function rebuildToolResult(result: ToolResult, actions: Actions, headChars: number): ToolResult {
  if (actions.get(result.tool_use_id) !== "drop_result") return result;
  const text = truncatedResultText(result.text, result.isError ?? false, headChars);
  if (text === result.text) return result;
  return { tool_use_id: result.tool_use_id, text, isError: result.isError ?? false };
}

/** The message with `actions` applied: the same object when nothing changed, null when nothing is left. */
function rebuildMessage(message: Message, actions: Actions, headChars: number): Message | null {
  const dropped = (id: string) => actions.get(id) === "drop_call";
  const results = message.toolResults ?? [];
  const toolUses = message.toolUses
    .filter((tool) => !dropped(tool.tool_use_id))
    .map((tool) => rebuildToolUse(tool, actions, headChars));
  const toolResults = results
    .filter((result) => !dropped(result.tool_use_id))
    .map((result) => rebuildToolResult(result, actions, headChars));
  const unchanged =
    toolUses.length === message.toolUses.length &&
    toolResults.length === results.length &&
    toolUses.every((tool, index) => tool === message.toolUses[index]) &&
    toolResults.every((result, index) => result === results[index]);
  if (unchanged) return message;
  if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
    return null;
  }
  const rebuilt: Message = { role: message.role, text: message.text, toolUses };
  return toolResults.length > 0 ? { ...rebuilt, toolResults } : rebuilt;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result, a dropped result keeps a bounded head and a note.
 * Messages left empty are removed. Untouched messages come back as the same
 * objects they came in as, so host adapters can keep their own handles.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const actions = actionsByToolUseId(decisions, calls);
  if (actions.size === 0) return [...messages];
  return messages
    .map((message) => rebuildMessage(message, actions, headChars))
    .filter((message): message is Message => message !== null);
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}
