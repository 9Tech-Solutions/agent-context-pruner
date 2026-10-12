export interface CompactOptions {
  /** Ongoing task description. Defaults to the latest user prompts. */
  readonly goal?: string;
  /** Minimum keep probability for a call or result to stay. Defaults to the model's calibrated value. */
  readonly keepThreshold?: number;
  /** Newest messages never touched; the first message is always kept. Default 6. */
  readonly preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Defaults to the model's limit. */
  readonly maxStateTokens?: number;
  /** Characters of a dropped tool result kept before its note. Default 300. */
  readonly truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  readonly goal: string;
  readonly keepThreshold: number;
  readonly preserveRecentMessages: number;
  readonly maxStateTokens: number;
  readonly truncateHeadChars: number;
}

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  truncateHeadChars: 300,
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
    keepThreshold: finite(options.keepThreshold, keepThreshold),
    preserveRecentMessages: Math.max(0, Math.floor(preserve)),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, maxStateTokens)),
    truncateHeadChars: Math.max(0, Math.floor(head)),
  };
}
