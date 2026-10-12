export interface CompactOptions {
  /** Ongoing task description. Defaults to the latest user prompts. */
  readonly goal?: string;
  /** What the person asked this compaction to keep or focus on, such as the text after `/compact`. */
  readonly instructions?: string;
  /** Minimum keep probability for a call or result to stay. Defaults to the model's calibrated value. */
  readonly keepThreshold?: number;
  /** Newest messages never touched; the first message is always kept. Default 6. */
  readonly preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Defaults to the model's limit. */
  readonly maxStateTokens?: number;
  /** Characters of a dropped tool result kept before its note. Default 300. */
  readonly truncateHeadChars?: number;
  /** Leave a one-line note where a dropped call's result was. Default true. */
  readonly noteDroppedCalls?: boolean;
}

export interface ResolvedCompactOptions {
  readonly goal: string;
  readonly instructions: string;
  readonly keepThreshold: number;
  readonly preserveRecentMessages: number;
  readonly maxStateTokens: number;
  readonly truncateHeadChars: number;
  readonly noteDroppedCalls: boolean;
}

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: "",
  instructions: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  truncateHeadChars: 300,
  noteDroppedCalls: true,
};

/** Model-specific defaults that sit between the caller's options and `DEFAULT_OPTIONS`. */
export interface ModelDefaults {
  readonly keepThreshold?: number;
  readonly maxStateTokens?: number;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Caller options first, then the model's defaults, then `DEFAULT_OPTIONS`; non-finite values are ignored. */
export function resolveOptions(
  options: CompactOptions = {},
  model: ModelDefaults = {},
): ResolvedCompactOptions {
  const keepThreshold = finite(model.keepThreshold, DEFAULT_OPTIONS.keepThreshold);
  const maxStateTokens = finite(model.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens);
  const preserve = finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages);
  const head = finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars);
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    instructions: options.instructions?.trim() ?? DEFAULT_OPTIONS.instructions,
    keepThreshold: finite(options.keepThreshold, keepThreshold),
    preserveRecentMessages: Math.max(0, Math.floor(preserve)),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, maxStateTokens)),
    truncateHeadChars: Math.max(0, Math.floor(head)),
    noteDroppedCalls: options.noteDroppedCalls ?? DEFAULT_OPTIONS.noteDroppedCalls,
  };
}
