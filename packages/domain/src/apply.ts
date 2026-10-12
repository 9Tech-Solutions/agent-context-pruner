import type { CallAction, CallDecision } from "./decision.ts";
import { inputLine } from "./state/history.ts";
import type { ToolCall } from "./tool-call.ts";
import type { Message, ToolResult, ToolUse } from "./transcript.ts";

type DropAction = Exclude<CallAction, "keep">;

interface Planned {
  readonly action: DropAction;
  readonly call: ToolCall;
}

type Actions = ReadonlyMap<string, Planned>;

export interface ApplyOptions {
  /** Leave a one-line note where a dropped call's result was. Default true. */
  readonly noteDroppedCalls?: boolean;
}

interface Settings {
  readonly headChars: number;
  readonly noteDroppedCalls: boolean;
}

/** Results within this many characters of the head are kept whole: the note would not save anything. */
const NOTE_SLACK = 120;
const NOTE_INPUT_CHARS = 160;

/** Leading characters of a result that truncation keeps: all of one too short to be worth a note. */
export function keptChars(resultChars: number, headChars: number): number {
  return resultChars <= headChars + NOTE_SLACK ? resultChars : headChars;
}

/** A dropped result: its first `headChars` characters and a note saying how much was cut. */
export function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (keptChars(text.length, headChars) === text.length) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  const error = isError ? " (error)" : "";
  return `${head}[agent-context-pruner truncated ${text.length - headChars} chars of this tool result${error}; re-run the tool if needed]`;
}

/**
 * The note left where a dropped call's result was: which tool, with which
 * input, and how much it returned, so the model knows what it no longer has
 * and what to re-run. There is no summary, so without it the model cannot tell.
 */
export function droppedCallNote(
  call: Pick<ToolCall, "tool" | "input" | "resultChars" | "isError">,
): string {
  const input = inputLine(call.input, NOTE_INPUT_CHARS);
  const what = input ? `${call.tool} ${input}` : call.tool;
  const output = call.isError
    ? `an error, ${call.resultChars} chars`
    : `${call.resultChars} chars of output`;
  return `[agent-context-pruner removed tool call ${what} (${output}); re-run it if needed]`;
}

function actionsByToolUseId(
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
): Map<string, Planned> {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, Planned>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== "keep") {
      actions.set(call.tool_use_id, { action: decision.action, call });
    }
  }
  return actions;
}

function rebuildToolUse(tool: ToolUse, actions: Actions, headChars: number): ToolUse {
  if (actions.get(tool.tool_use_id)?.action !== "drop_result") return tool;
  const text = truncatedResultText(tool.text ?? "", tool.isError ?? false, headChars);
  if ((tool.text ?? "") === text) return tool;
  const copy: ToolUse = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input, text };
  return tool.isError ? { ...copy, isError: true } : copy;
}

function rebuildToolResult(result: ToolResult, actions: Actions, headChars: number): ToolResult {
  if (actions.get(result.tool_use_id)?.action !== "drop_result") return result;
  const text = truncatedResultText(result.text, result.isError ?? false, headChars);
  if (text === result.text) return result;
  return { tool_use_id: result.tool_use_id, text, isError: result.isError ?? false };
}

/** The message's text with a note for each dropped call whose result it held. */
function withNotes(message: Message, actions: Actions, settings: Settings): string {
  if (!settings.noteDroppedCalls) return message.text;
  const notes = (message.toolResults ?? []).flatMap((result) => {
    const planned = actions.get(result.tool_use_id);
    return planned?.action === "drop_call" ? [droppedCallNote(planned.call)] : [];
  });
  return [message.text, ...notes].filter((part) => part.length > 0).join("\n");
}

/** The message with `actions` applied: the same object when nothing changed, null when nothing is left. */
function rebuildMessage(message: Message, actions: Actions, settings: Settings): Message | null {
  const dropped = (id: string) => actions.get(id)?.action === "drop_call";
  const results = message.toolResults ?? [];
  const toolUses = message.toolUses
    .filter((tool) => !dropped(tool.tool_use_id))
    .map((tool) => rebuildToolUse(tool, actions, settings.headChars));
  const toolResults = results
    .filter((result) => !dropped(result.tool_use_id))
    .map((result) => rebuildToolResult(result, actions, settings.headChars));
  const unchanged =
    toolUses.length === message.toolUses.length &&
    toolResults.length === results.length &&
    toolUses.every((tool, index) => tool === message.toolUses[index]) &&
    toolResults.every((result, index) => result === results[index]);
  if (unchanged) return message;
  const text = withNotes(message, actions, settings);
  if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) return null;
  const rebuilt: Message = { role: message.role, text, toolUses };
  return toolResults.length > 0 ? { ...rebuilt, toolResults } : rebuilt;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result, leaving a one-line note where the result was
 * (unless `noteDroppedCalls` is false); a dropped result keeps a bounded head
 * and a note. Messages left empty are removed. Untouched messages come back as
 * the same objects they came in as, so host adapters can keep their own handles.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  options: ApplyOptions = {},
): Message[] {
  const actions = actionsByToolUseId(decisions, calls);
  if (actions.size === 0) return [...messages];
  const settings: Settings = { headChars, noteDroppedCalls: options.noteDroppedCalls ?? true };
  return messages
    .map((message) => rebuildMessage(message, actions, settings))
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
