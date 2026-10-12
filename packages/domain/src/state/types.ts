import type { Role } from "../transcript.ts";

export interface HistoryToolCall {
  readonly id: string;
  readonly tool: string;
  readonly input: string;
  readonly result: string;
}

export interface HistoryEntry {
  readonly i: number;
  readonly role: Role;
  readonly text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  readonly tool_calls?: readonly HistoryToolCall[] | readonly string[];
}

/** What a model reads: the whole conversation, tool results replaced by a short note. */
export interface CompactionState {
  readonly context: string;
  readonly goal: string;
  /** What the person asked this compaction to keep (the text after `/compact`), when given. */
  readonly instructions?: string;
  readonly history: readonly HistoryEntry[];
}

export interface FittedState {
  readonly state: CompactionState;
  readonly tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  readonly stage: string;
}
