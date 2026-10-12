import { compact } from "@9tech.solutions/pruner-domain";
import { describe, expect, it } from "vite-plus/test";
import {
  createProviderModel,
  isProviderId,
  keysFromEnv,
  type HttpRequest,
  type ProviderId,
} from "../src/index.ts";
import { fakeServer, transcript, unwrap } from "./helpers.ts";

async function firstRequest(
  provider: ProviderId,
  settings: Parameters<typeof createProviderModel>[1],
  keys: Parameters<typeof createProviderModel>[2],
): Promise<HttpRequest> {
  const seen: HttpRequest[] = [];
  const model = unwrap(
    createProviderModel(
      provider,
      settings,
      keys,
      fakeServer(() => 0.9, seen),
    ),
  );
  unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));
  return seen[0]!;
}

describe("createProviderModel", () => {
  it("reads keys from the environment, treating empty values as missing", () => {
    expect(
      keysFromEnv({ TYPESAFE_API_KEY: " k ", CLOUDFLARE_API_TOKEN: "", PATH: "/bin" }),
    ).toEqual({
      typesafeApiKey: "k",
      cloudflareApiToken: undefined,
      cloudflareAccountId: undefined,
    });
    expect(isProviderId("ollama")).toBe(true);
    expect(isProviderId("auto")).toBe(false);
  });

  it("uses the environment's key, and an explicit key over it", async () => {
    const fromEnv = await firstRequest("typesafe", {}, { typesafeApiKey: "env" });
    expect(fromEnv.headers["authorization"]).toBe("Bearer env");
    const explicit = await firstRequest("typesafe", { apiKey: "mine" }, { typesafeApiKey: "env" });
    expect(explicit.headers["authorization"]).toBe("Bearer mine");
  });

  it("sends a base URL to local servers only", async () => {
    const baseUrl = "http://localhost:8000";
    expect((await firstRequest("custom", { baseUrl, model: "d1" }, {})).url).toBe(
      "http://localhost:8000/v1/systemone",
    );
    expect((await firstRequest("typesafe", { baseUrl }, { typesafeApiKey: "k" })).url).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
  });

  it("takes the Cloudflare account from the environment when none is given", async () => {
    const request = await firstRequest(
      "cloudflare",
      {},
      { cloudflareApiToken: "t", cloudflareAccountId: "acct" },
    );
    expect(request.url).toContain("/accounts/acct/ai/run/@cf/cloudflare/clef");
  });

  it("builds the rules model without any key", () => {
    expect(
      unwrap(
        createProviderModel(
          "heuristic",
          {},
          {},
          fakeServer(() => 1),
        ),
      ).id,
    ).toBe("heuristic:v2");
  });
});
