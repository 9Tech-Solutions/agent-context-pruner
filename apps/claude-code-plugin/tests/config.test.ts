import { describe, expect, it } from "vite-plus/test";
import { resolveHookConfig } from "../src/config.ts";
import { chooseModels } from "../src/models.ts";
import { offline } from "./fixtures.ts";

describe("resolveHookConfig", () => {
  it("fills in defaults", () => {
    expect(resolveHookConfig({})).toMatchObject({
      provider: "auto",
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      fallbackToHeuristic: true,
      compact: { keepThreshold: undefined, preserveRecentMessages: undefined },
    });
  });

  it("reads typed values and ignores malformed ones", () => {
    const config = resolveHookConfig({
      provider: "ollama",
      model: "  tev1  ",
      baseUrl: "",
      keepThreshold: 0.6,
      preserveRecentMessages: Number.NaN,
      fallbackToHeuristic: false,
    });
    expect(config).toMatchObject({
      provider: "ollama",
      model: "tev1",
      baseUrl: undefined,
      fallbackToHeuristic: false,
    });
    expect(config.compact).toMatchObject({ keepThreshold: 0.6, preserveRecentMessages: undefined });
    expect(resolveHookConfig({ provider: "gpt" }).provider).toBe("auto");
  });
});

describe("chooseModels", () => {
  const choose = (options: Record<string, string | number | boolean>, secrets = {}) => {
    const choice = chooseModels(resolveHookConfig(options), secrets, offline);
    return choice.ok
      ? {
          primary: choice.value.primary.id,
          fallback: choice.value.fallback?.id ?? null,
          notes: choice.value.notes,
        }
      : choice.error;
  };

  it("auto prefers TypeSafe, then Cloudflare, then the rules", () => {
    expect(choose({}, { typesafeApiKey: "k" })).toMatchObject({
      primary: "systemone:typesafe:jev-latest",
      fallback: "heuristic:v1",
    });
    expect(choose({}, { cloudflareApiToken: "t", cloudflareAccountId: "a" })).toMatchObject({
      primary: "systemone:cloudflare:clef",
    });
    expect(choose({}, { cloudflareApiToken: "t" })).toMatchObject({
      primary: "heuristic:v1",
      fallback: null,
    });
    expect(choose({})).toMatchObject({ primary: "heuristic:v1" });
  });

  it("honours an explicit provider and model", () => {
    expect(choose({ provider: "ollama", model: "tev1:0.8b" })).toMatchObject({
      primary: "systemone:ollama:tev1:0.8b",
    });
    expect(choose({ provider: "heuristic" }, { typesafeApiKey: "k" })).toMatchObject({
      primary: "heuristic:v1",
    });
  });

  it("falls back to the rules when the chosen provider is not configured, or refuses when told not to", () => {
    const fallback = choose({ provider: "typesafe" });
    expect(fallback).toMatchObject({
      primary: "heuristic:v1",
      notes: [expect.stringContaining("typesafe unavailable")],
    });
    expect(choose({ provider: "typesafe", fallbackToHeuristic: false })).toMatch(/API key/);
  });
});
