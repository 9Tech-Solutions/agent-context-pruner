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
} as const;

function text(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function number(options: PluginOptions, key: string): number | undefined {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProvider(value: string | undefined): value is Provider {
  return PROVIDERS.some((provider) => provider === value);
}

/** Reads the plugin's options; anything missing or malformed takes the default. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const provider = text(options, "provider");
  const fallback = options["fallbackToHeuristic"];
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
    },
    compactAtPercent: number(options, "compactAtPercent") ?? HOOK_DEFAULTS.compactAtPercent,
    minReductionRatio: number(options, "minReductionRatio") ?? HOOK_DEFAULTS.minReductionRatio,
    fallbackToHeuristic:
      typeof fallback === "boolean" ? fallback : HOOK_DEFAULTS.fallbackToHeuristic,
  };
}
