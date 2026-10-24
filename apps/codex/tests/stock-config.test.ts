import { describe, expect, it } from "vite-plus/test";
import { hasShellPolicy, proxySettings } from "../src/stock-config.ts";

it("accepts nullable credential fields written by stock Codex", () => {
  expect(
    proxySettings(
      "",
      JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: {} }),
      {},
    )?.upstream,
  ).toBe("https://chatgpt.com/backend-api/codex");
  expect(
    proxySettings(
      "",
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-test-key", tokens: null }),
      {},
    )?.upstream,
  ).toBe("https://api.openai.com/v1");
});

const OPENAI = "https://api.openai.com/v1";
const CHATGPT = "https://chatgpt.com/backend-api/codex";
const TOKEN = "CODEX_PRUNER_PROXY_TOKEN";
const DEFAULT_CONFIG = 'model = "gpt-6.1-sol"';

function auth(value: unknown): string {
  return JSON.stringify(value);
}

describe("stock Codex routing", () => {
  it("selects the ChatGPT backend for ChatGPT auth, tokens, and an absent auth file", () => {
    for (const value of [
      { auth_mode: "chatgpt", tokens: { access_token: "synthetic" } },
      { tokens: { access_token: "synthetic" } },
    ]) {
      expect(proxySettings(DEFAULT_CONFIG, auth(value), {})).toEqual({
        upstream: CHATGPT,
        excludes: [TOKEN],
      });
    }
    expect(proxySettings(DEFAULT_CONFIG, undefined, {})).toEqual({
      upstream: CHATGPT,
      excludes: [TOKEN],
    });
  });

  it("selects the OpenAI API for API-key auth", () => {
    for (const value of [{ auth_mode: "apikey" }, { OPENAI_API_KEY: "synthetic-api-key" }]) {
      expect(proxySettings(DEFAULT_CONFIG, auth(value), {})).toEqual({
        upstream: OPENAI,
        excludes: [TOKEN],
      });
    }
    expect(
      proxySettings(DEFAULT_CONFIG, undefined, { OPENAI_API_KEY: "synthetic-api-key" }),
    ).toEqual({
      upstream: OPENAI,
      excludes: [TOKEN],
    });
  });

  it("parses quoted TOML keys and merges the proxy token into existing exclusions", () => {
    const config = [
      "'model_provider' = 'openai'",
      '["shell_environment_policy"]',
      '"exclude" = ["LOCAL_*", "custom_secret"]',
      "set = { 'SAFE_VALUE' = 'kept' }",
    ].join("\n");

    expect(proxySettings(config, auth({ auth_mode: "chatgpt" }), {})).toEqual({
      upstream: CHATGPT,
      excludes: ["LOCAL_*", "custom_secret", TOKEN],
    });
  });

  it("does not duplicate an existing case-insensitive proxy-token exclusion", () => {
    const config = `[shell_environment_policy]\nexclude = ["${TOKEN.toLowerCase()}", "AWS_*"]`;

    expect(proxySettings(config, auth({ auth_mode: "chatgpt" }), {})).toEqual({
      upstream: CHATGPT,
      excludes: [TOKEN.toLowerCase(), "AWS_*"],
    });
  });

  it("bypasses stock routing for custom providers, profiles, and custom base URLs", () => {
    const custom = [
      'model_provider = "anthropic"',
      'profile = "work"',
      'openai_base_url = "https://router.example/v1"',
      'chatgpt_base_url = "https://gateway.example/codex"',
    ];
    for (const line of custom) {
      expect(proxySettings(`${DEFAULT_CONFIG}\n${line}`, auth({ auth_mode: "chatgpt" }), {})).toBe(
        undefined,
      );
    }
  });

  it("bypasses for environment routing overrides but permits an OpenAI API key", () => {
    for (const env of [
      { OPENAI_BASE_URL: "https://router.example/v1" },
      { CODEX_API_KEY: "synthetic-custom-key" },
    ]) {
      expect(proxySettings(DEFAULT_CONFIG, auth({ auth_mode: "apikey" }), env)).toBe(undefined);
    }
  });

  it("bypasses when auth is malformed, unknown, or mixes API and ChatGPT routes", () => {
    const cases: [string | undefined, Readonly<Record<string, string | undefined>>][] = [
      ["{", {}],
      ["null", {}],
      [auth({ auth_mode: "other" }), {}],
      [auth({ auth_mode: "chatgpt", OPENAI_API_KEY: "synthetic-api-key" }), {}],
      [auth({ auth_mode: "apikey", tokens: { access_token: "synthetic" } }), {}],
      [
        auth({ auth_mode: "chatgpt", tokens: { access_token: "synthetic" } }),
        { OPENAI_API_KEY: "synthetic-api-key" },
      ],
    ];

    for (const [authText, env] of cases) {
      expect(proxySettings(DEFAULT_CONFIG, authText, env)).toBe(undefined);
    }
  });

  it("bypasses for malformed config and unsafe shell environment policies", () => {
    const cases = [
      "not = valid = toml",
      `${DEFAULT_CONFIG}\n[shell_environment_policy]\nexclude = "not-an-array"`,
      `${DEFAULT_CONFIG}\n[shell_environment_policy.filters]\n"PATH" = "include"`,
      `${DEFAULT_CONFIG}\n[shell_environment_policy]\nset = { "${TOKEN}" = "override" }`,
    ];
    for (const config of cases) {
      expect(proxySettings(config, auth({ auth_mode: "chatgpt" }), {})).toBe(undefined);
    }
  });

  it("uses an explicit upstream only after config and auth validation", () => {
    const env = { CODEX_PRUNER_UPSTREAM: "http://127.0.0.1:43210/v1" };
    expect(proxySettings(DEFAULT_CONFIG, auth({ auth_mode: "chatgpt" }), env)).toEqual({
      upstream: env.CODEX_PRUNER_UPSTREAM,
      excludes: [TOKEN],
    });
    expect(proxySettings('model_provider = "custom"', auth({ auth_mode: "chatgpt" }), env)).toBe(
      undefined,
    );
    expect(proxySettings("not = valid = toml", auth({ auth_mode: "chatgpt" }), env)).toBe(
      undefined,
    );
  });
});

describe("shell policy detection", () => {
  it("detects a shell policy table, including quoted TOML keys", () => {
    expect(hasShellPolicy('[shell_environment_policy]\nexclude = ["CUSTOM"]')).toBe(true);
    expect(hasShellPolicy('["shell_environment_policy"]\nexclude = []')).toBe(true);
    expect(hasShellPolicy(DEFAULT_CONFIG)).toBe(false);
  });

  it("treats malformed project config as a shell-policy override", () => {
    expect(hasShellPolicy("not = valid = toml")).toBe(true);
  });
});
