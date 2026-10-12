import { err, ok, type Result } from "../result.ts";
import { abridge } from "../text.ts";
import { estimateTokens, type TokenEstimator } from "../tokens.ts";
import { isPinned, type ToolCall } from "../tool-call.ts";
import type { Message } from "../transcript.ts";
import {
  callsByMessage,
  compactCall,
  goalFromMessages,
  historyEntries,
  STATE_CONTEXT,
} from "./history.ts";
import type { CompactionState, FittedState, HistoryEntry } from "./types.ts";

export interface FitOptions {
  readonly maxStateTokens: number;
  readonly preserveRecentMessages: number;
  /** Ongoing task; the latest user prompts are used when empty. */
  readonly goal: string;
  /** Defaults to the built-in estimator. */
  readonly estimateTokens?: TokenEstimator;
}

export interface StateTooLarge {
  readonly kind: "state_too_large";
  readonly message: string;
  readonly tokens: number;
  readonly limit: number;
}

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const COMPACT_INPUT_CHARS = 60;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

interface FitContext {
  readonly messages: readonly Message[];
  readonly calls: readonly ToolCall[];
  readonly goal: string;
  readonly limit: number;
  readonly estimate: TokenEstimator;
  readonly baseTokens: number;
  readonly pinned: (entry: HistoryEntry) => boolean;
}

interface Draft {
  readonly history: readonly HistoryEntry[];
  readonly perEntry: readonly number[];
  readonly tokens: number;
}

/** A stage either produced a state that fits, or hands its smaller draft to the next stage. */
type Step = { readonly fitted: FittedState } | { readonly draft: Draft };

type Stage = (ctx: FitContext, draft: Draft, order: readonly number[]) => Step;

function contextOf(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: FitOptions,
): FitContext {
  const goal = options.goal || goalFromMessages(messages);
  const estimate = options.estimateTokens ?? estimateTokens;
  const empty: CompactionState = { context: STATE_CONTEXT, goal, history: [] };
  return {
    messages,
    calls,
    goal,
    limit: options.maxStateTokens,
    estimate,
    baseTokens: estimate(JSON.stringify(empty)),
    pinned: (entry) => isPinned(entry.i, messages.length, options.preserveRecentMessages),
  };
}

function entryTokens(ctx: FitContext, entry: HistoryEntry): number {
  return ctx.estimate(JSON.stringify(entry)) + 1;
}

function draftOf(ctx: FitContext, history: readonly HistoryEntry[]): Draft {
  const perEntry = history.map((entry) => entryTokens(ctx, entry));
  return { history, perEntry, tokens: ctx.baseTokens + perEntry.reduce((sum, n) => sum + n, 0) };
}

function fits(ctx: FitContext, draft: Draft): boolean {
  return draft.tokens <= ctx.limit;
}

function fitted(ctx: FitContext, draft: Draft, stage: string): Step {
  const state: CompactionState = { context: STATE_CONTEXT, goal: ctx.goal, history: draft.history };
  return { fitted: { state, tokens: draft.tokens, stage } };
}

function replaceEntry(ctx: FitContext, draft: Draft, index: number, entry: HistoryEntry): Draft {
  const tokens = entryTokens(ctx, entry);
  return {
    history: draft.history.with(index, entry),
    perEntry: draft.perEntry.with(index, tokens),
    tokens: draft.tokens - (draft.perEntry[index] ?? 0) + tokens,
  };
}

/** Applies `change` entry by entry in `order`, stopping as soon as the state fits. */
function shrinkEach(
  ctx: FitContext,
  start: Draft,
  order: readonly number[],
  stage: string,
  change: (entry: HistoryEntry) => HistoryEntry | undefined,
): Step {
  let draft = start;
  for (const index of order) {
    const entry = draft.history[index];
    const next = entry && change(entry);
    if (!next) continue;
    draft = replaceEntry(ctx, draft, index, next);
    if (fits(ctx, draft)) return fitted(ctx, draft, stage);
  }
  return { draft };
}

/** Tool inputs truncated to 1000, then 200, then 60 characters. */
function fitInputs(ctx: FitContext): Step {
  let draft = draftOf(ctx, historyEntries(ctx.messages, ctx.calls, INPUT_CHARS[0]));
  if (fits(ctx, draft)) return fitted(ctx, draft, "full");
  for (const limit of INPUT_CHARS.slice(1)) {
    draft = draftOf(ctx, historyEntries(ctx.messages, ctx.calls, limit));
    if (fits(ctx, draft)) return fitted(ctx, draft, `inputs<=${limit}`);
  }
  return { draft };
}

const abridgeTexts: Stage = (ctx, draft, order) =>
  shrinkEach(ctx, draft, order, "texts abridged", (entry) =>
    entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40
      ? undefined
      : { ...entry, text: abridge(entry.text, TEXT_HEAD, TEXT_TAIL) },
  );

const collapseOldTexts: Stage = (ctx, draft, order) =>
  shrinkEach(ctx, draft, order, "old messages collapsed", (entry) => {
    if (ctx.pinned(entry) || entry.text.length === 0) return undefined;
    const original = ctx.messages[entry.i]?.text.length ?? entry.text.length;
    return { ...entry, text: `[… ${original} chars omitted …]` };
  });

const compactOldCalls: Stage = (ctx, draft, order) => {
  const byMessage = callsByMessage(ctx.calls);
  return shrinkEach(ctx, draft, order, "old calls compacted", (entry) => {
    const own = byMessage.get(entry.i);
    if (ctx.pinned(entry) || !own) return undefined;
    return { ...entry, tool_calls: own.map((call) => compactCall(call, COMPACT_INPUT_CHARS)) };
  });
};

/** Old messages that carry no call are left out, oldest first. */
const leaveOutOldMessages: Stage = (ctx, draft, order) => {
  const left = new Set<number>();
  const kept = () => draft.history.filter((_, index) => !left.has(index));
  let tokens = draft.tokens;
  for (const index of order) {
    const entry = draft.history[index];
    if (!entry || ctx.pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= draft.perEntry[index] ?? 0;
    if (tokens <= ctx.limit)
      return fitted(ctx, { history: kept(), perEntry: [], tokens }, "old messages left out");
  }
  return { draft: draftOf(ctx, kept()) };
};

function foldable(ctx: FitContext, entry: HistoryEntry): boolean {
  return !ctx.pinned(entry) && entry.text.length === 0 && typeof entry.tool_calls?.[0] === "string";
}

/** Folds runs of adjacent old call-only entries into one, keeping every call line. */
function mergeCallRuns(ctx: FitContext, history: readonly HistoryEntry[]): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.role === entry.role &&
      foldable(ctx, previous) &&
      foldable(ctx, entry)
    ) {
      const lines = [
        ...(previous.tool_calls as readonly string[]),
        ...(entry.tool_calls as readonly string[]),
      ];
      merged[merged.length - 1] = { ...previous, tool_calls: lines };
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

function shrinkOrder(ctx: FitContext, draft: Draft): number[] {
  const indices = draft.history.map((_, index) => index);
  const pinnedAt = (index: number) => {
    const entry = draft.history[index];
    return entry !== undefined && ctx.pinned(entry);
  };
  return [...indices.filter((index) => !pinnedAt(index)), ...indices.filter(pinnedAt)];
}

const SHRINK_STAGES: readonly Stage[] = [
  abridgeTexts,
  collapseOldTexts,
  compactOldCalls,
  leaveOutOldMessages,
];

/**
 * Builds the state from the whole conversation and shrinks it in stages until
 * it fits `maxStateTokens`: tool inputs are truncated, long texts abridged
 * (oldest first, pinned messages last), old messages collapsed to a note, old
 * tool calls reduced to one line each, old call-less messages left out, and
 * runs of old call-only messages folded together.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: FitOptions,
): Result<FittedState, StateTooLarge> {
  const ctx = contextOf(messages, calls, options);
  const first = fitInputs(ctx);
  if ("fitted" in first) return ok(first.fitted);
  let draft = first.draft;
  const order = shrinkOrder(ctx, draft);
  for (const stage of SHRINK_STAGES) {
    const step = stage(ctx, draft, order);
    if ("fitted" in step) return ok(step.fitted);
    draft = step.draft;
  }
  const merged = draftOf(ctx, mergeCallRuns(ctx, draft.history));
  const last = fitted(ctx, merged, "old calls merged");
  if (fits(ctx, merged) && "fitted" in last) return ok(last.fitted);
  return err({
    kind: "state_too_large",
    message: `history too large for the model (~${merged.tokens} tokens after truncation, limit ${ctx.limit})`,
    tokens: merged.tokens,
    limit: ctx.limit,
  });
}
