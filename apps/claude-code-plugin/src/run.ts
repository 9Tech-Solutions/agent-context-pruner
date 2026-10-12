import { compact, reductionRatio, type CompactResult } from "@9tech.solutions/pruner-domain";
import type { HttpTransport } from "@9tech.solutions/pruner-models";
import type { SessionMessage } from "claude-code";
import type { HookConfig, Secrets } from "./config.ts";
import { chooseModels } from "./models.ts";
import { promptGoal, toSessionMessages } from "./session.ts";
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
 * Compacts a session transcript with the configured model, passing on what
 * the person asked the compaction to keep (the text after `/compact`), retries with the
 * rules-based model when that fails, and hands the result back only when it
 * removed enough. Every other outcome is a fallback to the built-in summary.
 */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  secrets: Secrets,
  transport: HttpTransport,
  instructions?: string,
): Promise<SessionOutcome> {
  const choice = chooseModels(config, secrets, transport);
  if (!choice.ok) return { kind: "fallback", reason: choice.error, log: [] };
  const { primary, fallback, notes } = choice.value;
  const log = [...notes];
  const options = { ...config.compact, instructions, goal: promptGoal(messages) };
  let outcome = await compact(messages, primary, options);
  if (!outcome.ok && fallback) {
    log.push(`${primary.id} failed (${outcome.error.message}); retrying with ${fallback.id}`);
    outcome = await compact(messages, fallback, options);
  }
  if (!outcome.ok) return { kind: "fallback", reason: outcome.error.message, log };
  const result = outcome.value;
  log.push(...decisionLogLines(result, config.logEachDecision));
  if (reductionRatio(result) < config.minReductionRatio) {
    const reason = `below the ${percent(config.minReductionRatio)} minimum: ${summarize(result)}`;
    return { kind: "fallback", reason, log };
  }
  return { kind: "replaced", messages: toSessionMessages(messages, result.messages), result, log };
}
