import { parse } from "smol-toml";

export interface ProxySettings {
  readonly upstream: string;
  readonly excludes: readonly string[];
}

type RecordValue = Record<string, unknown>;

const OPENAI_UPSTREAM = "https://api.openai.com/v1";
const CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const PROXY_TOKEN_ENV = "CODEX_PRUNER_PROXY_TOKEN";

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseConfig(text: string): RecordValue | undefined {
  try {
    const value: unknown = parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function hasEnvironmentOverride(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(envValue(env, "OPENAI_BASE_URL") || envValue(env, "CODEX_API_KEY"));
}

function shellExcludes(config: RecordValue): string[] | undefined {
  const policy = config["shell_environment_policy"];
  if (policy === undefined) return [];
  if (!isRecord(policy) || hasOwn(policy, "filters")) return undefined;

  const set = policy["set"];
  if (set !== undefined && !isRecord(set)) return undefined;
  if (
    isRecord(set) &&
    Object.keys(set).some((name) => name.toLowerCase() === PROXY_TOKEN_ENV.toLowerCase())
  ) {
    return undefined;
  }

  const exclude = policy["exclude"];
  if (exclude === undefined) return [];
  return Array.isArray(exclude) && exclude.every((item) => typeof item === "string")
    ? [...exclude]
    : undefined;
}

function authUpstream(
  authText: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const envApiKey = envValue(env, "OPENAI_API_KEY") !== undefined;
  if (authText === undefined) return envApiKey ? OPENAI_UPSTREAM : CHATGPT_UPSTREAM;

  let authValue: unknown;
  try {
    authValue = JSON.parse(authText);
  } catch {
    return undefined;
  }
  if (!isRecord(authValue)) return undefined;

  const mode = authValue["auth_mode"];
  const apiMode = mode === "apikey";
  const chatgptMode = mode === "chatgpt";
  if (mode !== undefined && !apiMode && !chatgptMode) return undefined;

  const hasApiKey =
    authValue["OPENAI_API_KEY"] !== undefined && authValue["OPENAI_API_KEY"] !== null;
  if (hasApiKey && typeof authValue["OPENAI_API_KEY"] !== "string") return undefined;
  const authApiKey =
    typeof authValue["OPENAI_API_KEY"] === "string" &&
    authValue["OPENAI_API_KEY"].trim().length > 0;
  const hasTokens = authValue["tokens"] !== undefined && authValue["tokens"] !== null;
  if (hasTokens && !isRecord(authValue["tokens"])) return undefined;

  const useOpenAi = apiMode || authApiKey || envApiKey;
  const useChatGpt = chatgptMode || hasTokens;
  if (useOpenAi && useChatGpt) return undefined;
  if (useOpenAi) return OPENAI_UPSTREAM;
  if (useChatGpt) return CHATGPT_UPSTREAM;
  return undefined;
}

/** Select a safe stock upstream and preserve the configured tool-environment exclusions. */
export function proxySettings(
  configText: string,
  authText: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ProxySettings | undefined {
  const config = parseConfig(configText);
  if (!config || hasEnvironmentOverride(env)) return undefined;
  if (
    hasOwn(config, "profile") ||
    hasOwn(config, "openai_base_url") ||
    hasOwn(config, "chatgpt_base_url") ||
    (config["model_provider"] !== undefined && config["model_provider"] !== "openai")
  ) {
    return undefined;
  }

  const excludes = shellExcludes(config);
  const selectedUpstream = authUpstream(authText, env);
  if (!excludes || !selectedUpstream) return undefined;

  const existingTokenExclusion = excludes.some(
    (item) => item.toLowerCase() === PROXY_TOKEN_ENV.toLowerCase(),
  );
  const upstream = envValue(env, "CODEX_PRUNER_UPSTREAM") ?? selectedUpstream;
  return {
    upstream,
    excludes: existingTokenExclusion ? excludes : [...excludes, PROXY_TOKEN_ENV],
  };
}

/** Malformed project config is treated as a possible shell-policy override. */
export function hasShellPolicy(configText: string): boolean {
  const config = parseConfig(configText);
  return config === undefined || hasOwn(config, "shell_environment_policy");
}
