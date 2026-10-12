import type { HttpTransport } from "@9tech.solutions/pruner-models";
import type {
  Engine,
  SessionCompactInput,
  SessionCompactResult,
  SessionMessage,
} from "claude-code";
import type { HookConfig, Secrets } from "./config.ts";
import { compactSession, type SessionOutcome } from "./run.ts";
import { summarize } from "./summary.ts";

type Next = (e: SessionCompactInput) => Promise<SessionCompactResult>;

type Pruned = Extract<SessionOutcome, { kind: "replaced" }>;

const TOAST_MS = 15_000;
const PROBE_MESSAGES = 4;

/** The answer to a `precompute` dispatch: pruning runs when the compaction itself runs. */
export const PRECOMPUTE_SKIP = "agent-context-pruner prunes when the compaction runs";

function notify($: Engine, text: string): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: TOAST_MS });
}

export function messageOf(error: unknown): string {
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

/**
 * A small stand-in transcript for core: the last few messages with text,
 * rebuilt without handles or tool blocks, so core's own summary of it is cheap.
 */
export function probeOf(messages: readonly SessionMessage[]): SessionMessage[] {
  const texts = messages
    .filter((m) => m.text.trim().length > 0)
    .slice(-PROBE_MESSAGES)
    .map((m): SessionMessage => ({ role: m.role, text: m.text, toolUses: [] }));
  if (texts.length > 0) return texts;
  return [{ role: "user", text: "(compacted by agent-context-pruner)", toolUses: [] }];
}

/**
 * Classic PreCompact hooks run only inside core's compaction, and a plugin
 * cannot raise them itself. So core compacts the stand-in transcript: its
 * PreCompact hooks run as they always do, and its summary is then dropped.
 * Answers core's skip when a hook blocked the compaction, null otherwise.
 */
async function runPreCompactHooks(
  $: Engine,
  e: SessionCompactInput,
  next: Next,
): Promise<{ skip: string } | null> {
  const started = Date.now();
  const core = await next({ ...e, messages: probeOf(e.messages) });
  $.ui.log(`PreCompact hooks ran through core compaction in ${Date.now() - started} ms`);
  return "skip" in core && typeof core.skip === "string" ? { skip: core.skip } : null;
}

async function finish(
  $: Engine,
  e: SessionCompactInput,
  next: Next,
  outcome: Pruned,
  config: HookConfig,
): Promise<SessionCompactResult> {
  if (config.runPreCompactHooks) {
    const skipped = await runPreCompactHooks($, e, next).catch((error: unknown) => {
      $.ui.log(
        `PreCompact hooks through core failed (${messageOf(error)}); keeping the pruned history`,
      );
      return null;
    });
    if (skipped) {
      notify($, `compaction skipped (${skipped.skip})`);
      return skipped;
    }
  }
  const kept = `kept ${outcome.messages.length}/${e.messages.length} messages, no summary`;
  notify($, `${kept} (${summarize(outcome.result)})`);
  return { messages: outcome.messages };
}

/**
 * The `session.compact` hook: prunes with the configured model, lets core run
 * the classic PreCompact hooks, and falls back to core's own summary whenever
 * pruning fails or would remove too little.
 */
export async function handleCompact(
  config: HookConfig,
  $: Engine,
  e: SessionCompactInput,
  next: Next,
): Promise<SessionCompactResult> {
  if (e.trigger === "precompute") return { skip: PRECOMPUTE_SKIP };
  let outcome: SessionOutcome;
  try {
    const secrets = await readSecrets($);
    outcome = await compactSession(e.messages, config, secrets, engineTransport($), e.instructions);
  } catch (error) {
    notify($, `fallback to built-in summary (${messageOf(error)})`);
    return next(e);
  }
  for (const line of outcome.log) $.ui.log(line);
  if (outcome.kind === "fallback") {
    notify($, `fallback to built-in summary (${outcome.reason})`);
    return next(e);
  }
  return finish($, e, next, outcome, config);
}
