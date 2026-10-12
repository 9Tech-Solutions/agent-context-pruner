import type { CompactOptions } from "@9tech.solutions/pruner-domain";
import type { PluginOptions } from "claude-code";

export const PROVIDERS = [
  "auto",
  "typesafe",
  "cloudflare",
  "ollama",
  "custom",
  "heuristic",
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** The plugin's `userConfig`, resolved with defaults. */
export interface HookConfig {
  readonly provider: Provider;
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly accountId?: string;
  readonly compact: CompactOptions;
  /** Context percentage at which `turn.complete` asks for a compaction; 0 turns it off. */
  readonly compactAtPercent: number;
  /** Below this share of characters removed, the built-in summary runs instead. */
  readonly minReductionRatio: number;
  /** Retry with the rules-based model when the chosen model is unavailable or fails. */
  readonly fallbackToHeuristic: boolean;
  /** Let core run the classic PreCompact hooks before the pruned history replaces the transcript. */
  readonly runPreCompactHooks: boolean;
  /** Log every scored call's probabilities, not just the summary line. */
  readonly logEachDecision: boolean;
}

/** Credentials read from the environment, never from the plugin's source. */
export interface Secrets {
  readonly typesafeApiKey?: string;
  readonly cloudflareApiToken?: string;
  readonly cloudflareAccountId?: string;
}

export const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  fallbackToHeuristic: true,
  runPreCompactHooks: true,
  logEachDecision: false,
} as const;

function text(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A number from a picker value (`"0.25"`, `"25%"` as 0.25, `"off"` as 0) or
 * from a plain number saved before the field became a picker. Anything else,
 * such as `"model default"`, is unset.
 */
function number(options: PluginOptions, key: string): number | undefined {
  const value = options[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (trimmed === "off") return 0;
  const isPercent = trimmed.endsWith("%");
  const parsed = Number(isPercent ? trimmed.slice(0, -1) : trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return isPercent ? parsed / 100 : parsed;
}

function flag(options: PluginOptions, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === "boolean" ? value : undefined;
}

function isProvider(value: string | undefined): value is Provider {
  return PROVIDERS.some((provider) => provider === value);
}

/** Reads the plugin's options; anything missing or malformed takes the default. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const provider = text(options, "provider");
  return {
    provider: isProvider(provider) ? provider : "auto",
    model: text(options, "model"),
    apiKey: text(options, "apiKey"),
    baseUrl: text(options, "baseUrl"),
    accountId: text(options, "accountId"),
    compact: {
      keepThreshold: number(options, "keepThreshold"),
      preserveRecentMessages: number(options, "preserveRecentMessages"),
      truncateHeadChars: number(options, "truncateHeadChars"),
      noteDroppedCalls: flag(options, "noteDroppedCalls"),
    },
    compactAtPercent: number(options, "compactAtPercent") ?? HOOK_DEFAULTS.compactAtPercent,
    minReductionRatio: number(options, "minReductionRatio") ?? HOOK_DEFAULTS.minReductionRatio,
    fallbackToHeuristic: flag(options, "fallbackToHeuristic") ?? HOOK_DEFAULTS.fallbackToHeuristic,
    runPreCompactHooks: text(options, "preCompactHooks") !== "skip",
    logEachDecision: flag(options, "logEachDecision") ?? HOOK_DEFAULTS.logEachDecision,
  };
}
