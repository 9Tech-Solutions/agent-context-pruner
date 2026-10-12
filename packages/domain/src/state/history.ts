import { truncate } from "../text.ts";
import type { ToolCall } from "../tool-call.ts";
import type { Message } from "../transcript.ts";
import type { HistoryEntry, HistoryToolCall } from "./types.ts";

export const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";

/** Added to `context` only when the person gave instructions, so other states stay byte-identical. */
export const INSTRUCTIONS_NOTE =
  "`instructions` is what the person asked this compaction to keep or focus on: a tool call it points to should stay.";

export function inputText(input: Readonly<Record<string, unknown>>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable input]";
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}

/** A call's input as `key=value` pairs on one line, cut to `limit` characters. */
export function inputLine(input: Readonly<Record<string, unknown>>, limit: number): string {
  const line = Object.entries(input)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, " ")}`;
    })
    .join(" ");
  return truncate(line, limit);
}

/** One call as a single line, for when the structured form is too costly. */
export function compactCall(call: ToolCall, inputChars: number): string {
  const outcome = call.isError ? "error" : "ok";
  return `${call.id} ${call.tool} ${inputLine(call.input, inputChars)} → ${outcome} ${call.resultChars}ch`;
}

export function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    byMessage.set(call.callIndex, [...(byMessage.get(call.callIndex) ?? []), call]);
  }
  return byMessage;
}

/** The history entries of a state: every message with text or calls, tool inputs capped. */
export function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls: HistoryToolCall[] = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    entries.push(toolCalls.length > 0 ? { ...entry, tool_calls: toolCalls } : entry);
  });
  return entries;
}

/** The last three user prompts, used as the goal when none is given. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join("\n");
}
