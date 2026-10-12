import {
  collectToolCalls,
  compact,
  err,
  ok,
  type CallScore,
  type CompactError,
  type DecisionModel,
  type Message,
  type Result,
  type ToolCall,
} from "@9tech.solutions/pruner-domain";
import { labelCut, type HindsightLabel, type NeededFragment } from "./labels.ts";

/** One scored call with what the rest of the session showed about it. */
export interface LabeledCall extends CallScore {
  readonly id: string;
  readonly tool: string;
  readonly resultChars: number;
  readonly label: HindsightLabel;
}

/** The model's verdict on one compaction point, with everything needed to replay it at other thresholds. */
export interface CutEvaluation {
  readonly cut: number;
  readonly history: readonly Message[];
  readonly calls: readonly ToolCall[];
  readonly scored: readonly LabeledCall[];
  /** Text reused after the cut that only droppable calls held, with every call holding it. */
  readonly needed: readonly NeededFragment[];
  readonly requests: number;
  readonly ms: number;
}

function labeled(
  calls: readonly ToolCall[],
  scores: ReadonlyMap<string, CallScore>,
  labels: ReadonlyMap<string, HindsightLabel>,
): Result<LabeledCall[], CompactError> {
  const scored: LabeledCall[] = [];
  for (const call of calls) {
    if (call.pinned) continue;
    const score = scores.get(call.id);
    const label = labels.get(call.id);
    if (!score || !label) {
      return err({ kind: "invalid_score", message: `no score or label for ${call.id}` });
    }
    scored.push({ id: call.id, tool: call.tool, resultChars: call.resultChars, label, ...score });
  }
  return ok(scored);
}

/**
 * Compacts `messages.slice(0, cut)` with `model` as the plugin would, then
 * labels each scored call by what the session did after `cut`.
 */
export async function evaluateCut(
  messages: readonly Message[],
  cut: number,
  model: DecisionModel,
  preserveRecentMessages: number,
): Promise<Result<CutEvaluation, CompactError>> {
  const history = messages.slice(0, cut);
  const outcome = await compact(history, model, { preserveRecentMessages });
  if (!outcome.ok) return outcome;
  const calls = collectToolCalls(history, preserveRecentMessages);
  const scores = new Map(outcome.value.decisions.map((d) => [d.id, d] as const));
  const { labels, needed } = labelCut(messages, cut, calls);
  const scored = labeled(calls, scores, labels);
  if (!scored.ok) return scored;
  const { requests, ms } = outcome.value.stats;
  return ok({ cut, history, calls, scored: scored.value, needed, requests, ms });
}
