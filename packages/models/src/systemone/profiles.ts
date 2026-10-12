import { err, ok, type ModelError, type Result } from "@9tech.solutions/pruner-domain";
import { unwrapCloudflare } from "./wire.ts";

export type ProfileId = "typesafe" | "cloudflare" | "ollama" | "custom";

export interface SystemOneConfig {
  readonly profile: ProfileId;
  /** Model name sent in the request body. Defaults per profile. */
  readonly model?: string;
  readonly apiKey?: string;
  /** Server root such as `http://localhost:8000`; the profile appends `/v1/systemone`. */
  readonly baseUrl?: string;
  /** Cloudflare account id, for the `cloudflare` profile. */
  readonly accountId?: string;
  readonly maxRequestTokens?: number;
  readonly maxStateTokens?: number;
  readonly maxQuestionsPerRequest?: number;
  readonly keepThreshold?: number;
  readonly maxConcurrency?: number;
}

export interface SystemOneProfile {
  readonly id: ProfileId;
  readonly defaultModel?: string;
  readonly requiresApiKey: boolean;
  /** Estimated ceiling for state plus one batch of questions. */
  readonly maxRequestTokens: number;
  readonly maxStateTokens: number;
  readonly maxQuestionsPerRequest: number;
  readonly keepThreshold: number;
  readonly endpoint: (config: SystemOneConfig, model: string) => Result<string, ModelError>;
  /** Strips a provider envelope so the body has `answers` at the top. */
  readonly unwrap: (body: unknown) => unknown;
}

const identity = (body: unknown): unknown => body;

function root(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function needs(field: string, profile: ProfileId): Result<never, ModelError> {
  return err({ kind: "config", message: `the ${profile} profile needs ${field}` });
}

/** TypeSafe Jev: 32k-token request limit, so state plus questions stay under 30k. */
const typesafe: SystemOneProfile = {
  id: "typesafe",
  defaultModel: "jev-latest",
  requiresApiKey: true,
  maxRequestTokens: 30_000,
  maxStateTokens: 25_000,
  maxQuestionsPerRequest: Number.POSITIVE_INFINITY,
  keepThreshold: 0.5,
  endpoint: (config) => ok(`${root(config.baseUrl ?? "https://api.typesafe.ai")}/v1/systemone`),
  unwrap: identity,
};

/** Cloudflare Workers AI Clef: 65,536-token window, 1 to 64 questions per request. */
const cloudflare: SystemOneProfile = {
  id: "cloudflare",
  defaultModel: "clef",
  requiresApiKey: true,
  maxRequestTokens: 60_000,
  maxStateTokens: 50_000,
  maxQuestionsPerRequest: 64,
  keepThreshold: 0.5,
  endpoint: (config, model) => {
    if (!config.accountId) return needs("an accountId", "cloudflare");
    const account = encodeURIComponent(config.accountId);
    return ok(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`,
    );
  },
  unwrap: unwrapCloudflare,
};

/** Ollama 0.35+: local, no key. A third-party guide caps the body at 64 KiB and 64 questions. */
const ollama: SystemOneProfile = {
  id: "ollama",
  defaultModel: "nimble",
  requiresApiKey: false,
  maxRequestTokens: 14_000,
  maxStateTokens: 11_000,
  maxQuestionsPerRequest: 64,
  keepThreshold: 0.5,
  endpoint: (config) => ok(`${root(config.baseUrl ?? "http://localhost:11434")}/v1/systemone`),
  unwrap: identity,
};

/** Any other `/v1/systemone` server: SGLang (16,384-token default), laya-serve, the Python shim. */
const custom: SystemOneProfile = {
  id: "custom",
  requiresApiKey: false,
  maxRequestTokens: 15_000,
  maxStateTokens: 12_000,
  maxQuestionsPerRequest: 64,
  keepThreshold: 0.5,
  endpoint: (config) =>
    config.baseUrl ? ok(`${root(config.baseUrl)}/v1/systemone`) : needs("a baseUrl", "custom"),
  unwrap: identity,
};

export const PROFILES: Readonly<Record<ProfileId, SystemOneProfile>> = {
  typesafe,
  cloudflare,
  ollama,
  custom,
};
