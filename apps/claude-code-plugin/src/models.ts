import { err, ok, type DecisionModel, type Result } from "@9tech.solutions/pruner-domain";
import {
  createHeuristicModel,
  createSystemOneModel,
  type HttpTransport,
  type ProfileId,
  type SystemOneConfig,
} from "@9tech.solutions/pruner-models";
import type { HookConfig, Provider, Secrets } from "./config.ts";

export interface ModelChoice {
  readonly primary: DecisionModel;
  /** Tried when the primary fails; null when there is none. */
  readonly fallback: DecisionModel | null;
  /** Why the choice differs from what was configured, for the log. */
  readonly notes: readonly string[];
}

/** `auto`: TypeSafe when a key is there, then Cloudflare, then the rules. */
function autoProvider(config: HookConfig, secrets: Secrets): Exclude<Provider, "auto"> {
  if (config.apiKey || secrets.typesafeApiKey) return "typesafe";
  if (secrets.cloudflareApiToken && (config.accountId || secrets.cloudflareAccountId)) {
    return "cloudflare";
  }
  return "heuristic";
}

function apiKeyFor(profile: ProfileId, config: HookConfig, secrets: Secrets): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (profile === "typesafe") return secrets.typesafeApiKey;
  if (profile === "cloudflare") return secrets.cloudflareApiToken;
  return undefined;
}

function systemOneConfig(
  profile: ProfileId,
  config: HookConfig,
  secrets: Secrets,
): SystemOneConfig {
  return {
    profile,
    model: config.model,
    apiKey: apiKeyFor(profile, config, secrets),
    baseUrl: config.baseUrl,
    accountId: config.accountId ?? secrets.cloudflareAccountId,
  };
}

/** Picks the configured decision model and the rules-based fallback behind it. */
export function chooseModels(
  config: HookConfig,
  secrets: Secrets,
  transport: HttpTransport,
): Result<ModelChoice, string> {
  const provider = config.provider === "auto" ? autoProvider(config, secrets) : config.provider;
  const heuristic = createHeuristicModel();
  if (provider === "heuristic") return ok({ primary: heuristic, fallback: null, notes: [] });
  const model = createSystemOneModel(systemOneConfig(provider, config, secrets), transport);
  if (model.ok) {
    const fallback = config.fallbackToHeuristic ? heuristic : null;
    return ok({ primary: model.value, fallback, notes: [] });
  }
  if (!config.fallbackToHeuristic) return err(model.error.message);
  const note = `${provider} unavailable (${model.error.message}); using the rules-based model`;
  return ok({ primary: heuristic, fallback: null, notes: [note] });
}
