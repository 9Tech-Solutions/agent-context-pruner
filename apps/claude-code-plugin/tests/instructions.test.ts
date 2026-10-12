import type { HttpRequest, HttpTransport } from "@9tech.solutions/pruner-models";
import { describe, expect, it } from "vite-plus/test";
import { resolveHookConfig } from "../src/config.ts";
import { compactSession } from "../src/run.ts";
import { promptGoal } from "../src/session.ts";
import { say, server, session } from "./fixtures.ts";

function recording(seen: HttpRequest[]): HttpTransport {
  const inner = server(0.1);
  return async (request) => {
    seen.push(request);
    return inner(request);
  };
}

describe("/compact instructions", () => {
  it("reach the model with the state, next to a goal without command rows", async () => {
    const seen: HttpRequest[] = [];
    const messages = [
      say("user", "<command-name>/plugin</command-name>"),
      say("user", "<local-command-stdout>(no content)</local-command-stdout>"),
      ...session(),
    ];
    const config = resolveHookConfig({
      provider: "typesafe",
      apiKey: "k",
      preserveRecentMessages: 2,
    });
    const outcome = await compactSession(messages, config, {}, recording(seen), "keep src/a.ts");
    expect(outcome.kind).toBe("replaced");
    const state = JSON.parse(seen[0]!.body).state;
    expect(state.instructions).toBe("keep src/a.ts");
    expect(state.goal).toBe("Fix the failing test.\ngo ahead");
  });

  it("are left out of the state when /compact had none", async () => {
    const seen: HttpRequest[] = [];
    const config = resolveHookConfig({
      provider: "typesafe",
      apiKey: "k",
      preserveRecentMessages: 2,
    });
    await compactSession(session(), config, {}, recording(seen));
    expect(JSON.parse(seen[0]!.body).state.instructions).toBeUndefined();
  });
});

describe("promptGoal", () => {
  it("keeps the person's last three prompts and skips command and reminder rows", () => {
    const rows = [
      say("user", "one"),
      say("user", "two"),
      say("user", "<system-reminder>ignore me</system-reminder>"),
      say("assistant", "reply"),
      say("user", "three"),
      say("user", "<command-name>/compact</command-name>"),
      say("user", "four"),
    ];
    expect(promptGoal(rows)).toBe("two\nthree\nfour");
  });
});
