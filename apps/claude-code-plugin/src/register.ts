import type { HttpTransport } from "@9tech.solutions/pruner-models";
import type { Engine, On, PluginOptions, Register } from "claude-code";
import { resolveHookConfig, type Secrets } from "./config.ts";
import { compactSession } from "./run.ts";
import { summarize } from "./summary.ts";

const TOAST_MS = 15_000;

function notify($: Engine, text: string): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: TOAST_MS });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** HTTP through the engine: a hooks module has no Node and no global network. */
function engineTransport($: Engine): HttpTransport {
  return async (request) => {
    const response = await $.http.fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
    });
    return { status: response.status, ok: response.ok, text: response.text };
  };
}

async function readSecrets($: Engine): Promise<Secrets> {
  const [typesafeApiKey, cloudflareApiToken, cloudflareAccountId] = await Promise.all([
    $.env.get("TYPESAFE_API_KEY"),
    $.env.get("CLOUDFLARE_API_TOKEN"),
    $.env.get("CLOUDFLARE_ACCOUNT_ID"),
  ]);
  return { typesafeApiKey, cloudflareApiToken, cloudflareAccountId };
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  on("session.compact", async ($, e, next) => {
    try {
      const outcome = await compactSession(
        e.messages,
        config,
        await readSecrets($),
        engineTransport($),
        e.instructions,
      );
      for (const line of outcome.log) $.ui.log(line);
      if (outcome.kind === "fallback") {
        notify($, `fallback to built-in summary (${outcome.reason})`);
        return next(e);
      }
      const kept = `kept ${outcome.messages.length}/${e.messages.length} messages, no summary`;
      notify($, `${kept} (${summarize(outcome.result)})`);
      return { messages: outcome.messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${messageOf(error)})`);
      return next(e);
    }
  });

  on("turn.complete", async ($, e, next) => {
    if (compacting || config.compactAtPercent <= 0) return next(e);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(e);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`auto-compact skipped (${messageOf(error)})`);
    } finally {
      compacting = false;
    }
    return next(e);
  });
};
