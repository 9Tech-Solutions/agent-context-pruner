import type { Message, ToolResult } from "./transcript.ts";

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in model requests (`t1`, `t2`, ...). */
  readonly id: string;
  readonly tool_use_id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Index of the message holding the tool_use block. */
  readonly callIndex: number;
  /** Index of the message holding the tool_result block. */
  readonly resultIndex: number;
  readonly resultChars: number;
  readonly isError: boolean;
  /** In the first or the newest preserved messages: never a candidate. */
  readonly pinned: boolean;
}

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

function resultsById(
  messages: readonly Message[],
): Map<string, { readonly index: number; readonly result: ToolResult }> {
  const results = new Map<string, { readonly index: number; readonly result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  return results;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates: there is nothing to drop yet.
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = resultsById(messages);
  const pinned = (index: number) => isPinned(index, messages.length, preserveRecentMessages);
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned: pinned(callIndex) || pinned(found.index),
      });
    }
  });
  return calls;
}
