import { err, type DecisionModel, type Result } from "@9tech.solutions/pruner-domain";
import {
  createHeuristicModel,
  createSystemOneModel,
  type HttpTransport,
  type ProfileId,
} from "@9tech.solutions/pruner-models";

export const PROVIDERS = ["typesafe", "cloudflare", "ollama", "custom", "heuristic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return PROVIDERS.some((provider) => provider === value);
}

export interface ModelFlags {
  readonly model?: string;
  readonly baseUrl?: string;
  readonly accountId?: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

function apiKeyFor(profile: ProfileId, env: Env): string | undefined {
  if (profile === "typesafe") return env["TYPESAFE_API_KEY"];
  if (profile === "cloudflare") return env["CLOUDFLARE_API_TOKEN"];
  return undefined;
}

/**
 * The decision model for `provider`, with keys from the environment as the
 * plugin reads them (`TYPESAFE_API_KEY`, `CLOUDFLARE_API_TOKEN`,
 * `CLOUDFLARE_ACCOUNT_ID`).
 */
export function createModel(
  provider: Provider,
  flags: ModelFlags,
  env: Env,
  transport: HttpTransport,
): Result<DecisionModel, string> {
  if (provider === "heuristic") return { ok: true, value: createHeuristicModel() };
  const model = createSystemOneModel(
    {
      profile: provider,
      model: flags.model,
      apiKey: apiKeyFor(provider, env),
      baseUrl: provider === "ollama" || provider === "custom" ? flags.baseUrl : undefined,
      accountId: flags.accountId ?? env["CLOUDFLARE_ACCOUNT_ID"],
    },
    transport,
  );
  return model.ok ? model : err(model.error.message);
}
