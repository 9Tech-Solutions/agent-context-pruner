import { compact, reductionRatio, type CompactResult } from "@9tech.solutions/pruner-domain";
import type { HttpTransport } from "@9tech.solutions/pruner-models";
import type { SessionMessage } from "claude-code";
import type { HookConfig, Secrets } from "./config.ts";
import { chooseModels } from "./models.ts";
import { toSessionMessages } from "./session.ts";
import { decisionLogLines, percent, summarize } from "./summary.ts";

export type SessionOutcome =
  | {
      readonly kind: "replaced";
      readonly messages: SessionMessage[];
      readonly result: CompactResult;
      readonly log: readonly string[];
    }
  | { readonly kind: "fallback"; readonly reason: string; readonly log: readonly string[] };

/**
 * Compacts a session transcript with the configured model, retries with the
 * rules-based model when that fails, and hands the result back only when it
 * removed enough. Every other outcome is a fallback to the built-in summary.
 */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  secrets: Secrets,
  transport: HttpTransport,
): Promise<SessionOutcome> {
  const choice = chooseModels(config, secrets, transport);
  if (!choice.ok) return { kind: "fallback", reason: choice.error, log: [] };
  const { primary, fallback, notes } = choice.value;
  const log = [...notes];
  let outcome = await compact(messages, primary, config.compact);
  if (!outcome.ok && fallback) {
    log.push(`${primary.id} failed (${outcome.error.message}); retrying with ${fallback.id}`);
    outcome = await compact(messages, fallback, config.compact);
  }
  if (!outcome.ok) return { kind: "fallback", reason: outcome.error.message, log };
  const result = outcome.value;
  log.push(...decisionLogLines(result));
  if (reductionRatio(result) < config.minReductionRatio) {
    const reason = `below the ${percent(config.minReductionRatio)} minimum: ${summarize(result)}`;
    return { kind: "fallback", reason, log };
  }
  return { kind: "replaced", messages: toSessionMessages(messages, result.messages), result, log };
}
