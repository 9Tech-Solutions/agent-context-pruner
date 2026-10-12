import { collectToolCalls, type Message } from "@9tech.solutions/pruner-domain";

export interface CutOptions {
  /** How many compaction points to take per transcript. */
  readonly cuts: number;
  /** A point needs at least this many unprotected calls before it. */
  readonly minCalls: number;
  readonly preserveRecentMessages: number;
}

export const DEFAULT_CUT_OPTIONS: CutOptions = { cuts: 3, minCalls: 10, preserveRecentMessages: 6 };

function isPrompt(message: Message): boolean {
  return (
    message.role === "user" &&
    message.text.trim().length > 0 &&
    (message.toolResults ?? []).length === 0
  );
}

function unprotectedCalls(history: readonly Message[], preserve: number): number {
  return collectToolCalls(history, preserve).filter((call) => !call.pinned).length;
}

/** `count` items spread evenly over `items`, always ending with the last one. */
function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from(
    { length: count },
    (_, i) => items[Math.ceil(((i + 1) * items.length) / count) - 1]!,
  );
}

/**
 * Points where a compaction could have happened: just before a user prompt,
 * with enough unprotected calls behind it and the model still at work after
 * it, so the rest of the session shows what was needed.
 */
export function chooseCuts(messages: readonly Message[], options: CutOptions): number[] {
  const candidates: number[] = [];
  messages.forEach((message, index) => {
    if (!isPrompt(message)) return;
    const after = messages.slice(index + 1).some((m) => m.role === "assistant");
    const enough =
      unprotectedCalls(messages.slice(0, index), options.preserveRecentMessages) >=
      options.minCalls;
    if (after && enough) candidates.push(index);
  });
  return spread(candidates, Math.max(0, Math.floor(options.cuts)));
}
