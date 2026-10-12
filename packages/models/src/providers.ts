import {
  ok,
  type DecisionModel,
  type ModelError,
  type Result,
} from "@9tech.solutions/pruner-domain";
import { createHeuristicModel } from "./heuristic/model.ts";
import { createSystemOneModel } from "./systemone/model.ts";
import type { HttpTransport } from "./transport.ts";

export const PROVIDERS = ["typesafe", "cloudflare", "ollama", "custom", "heuristic"] as const;

export type ProviderId = (typeof PROVIDERS)[number];

export function isProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((provider) => provider === value);
}

/** Credentials as every host reads them, from `TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. */
export interface ProviderKeys {
  readonly typesafeApiKey?: string;
  readonly cloudflareApiToken?: string;
  readonly cloudflareAccountId?: string;
}

export interface ProviderSettings {
  readonly model?: string;
  /** Wins over the environment's key for the provider. */
  readonly apiKey?: string;
  /** Server root for `ollama` and `custom`; the hosted providers never receive it. */
  readonly baseUrl?: string;
  /** Cloudflare account; defaults to `CLOUDFLARE_ACCOUNT_ID`. */
  readonly accountId?: string;
}

/** The credentials in an environment map; empty values count as missing. */
export function keysFromEnv(env: Readonly<Record<string, string | undefined>>): ProviderKeys {
  const value = (name: string) => env[name]?.trim() || undefined;
  return {
    typesafeApiKey: value("TYPESAFE_API_KEY"),
    cloudflareApiToken: value("CLOUDFLARE_API_TOKEN"),
    cloudflareAccountId: value("CLOUDFLARE_ACCOUNT_ID"),
  };
}

function environmentKey(provider: ProviderId, keys: ProviderKeys): string | undefined {
  if (provider === "typesafe") return keys.typesafeApiKey;
  if (provider === "cloudflare") return keys.cloudflareApiToken;
  return undefined;
}

/**
 * The decision model for `provider`, built the same way in every host: an
 * explicit key wins over the environment's, and a base URL reaches only the
 * local profiles, so a hosted provider's key never goes to another server.
 */
export function createProviderModel(
  provider: ProviderId,
  settings: ProviderSettings,
  keys: ProviderKeys,
  transport: HttpTransport,
): Result<DecisionModel, ModelError> {
  if (provider === "heuristic") return ok(createHeuristicModel());
  const local = provider === "ollama" || provider === "custom";
  return createSystemOneModel(
    {
      profile: provider,
      model: settings.model,
      apiKey: settings.apiKey ?? environmentKey(provider, keys),
      baseUrl: local ? settings.baseUrl : undefined,
      accountId: settings.accountId ?? keys.cloudflareAccountId,
    },
    transport,
  );
}
