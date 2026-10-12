import { applyDecisions, messageChars } from "./apply.ts";
import { decideCall, type CallDecision, type CallScore } from "./decision.ts";
import { resolveOptions, type CompactOptions, type ResolvedCompactOptions } from "./options.ts";
import type {
  DecisionModel,
  ModelError,
  ScoreRequest,
  ScoreResponse,
} from "./ports/decision-model.ts";
import { err, ok, type Result } from "./result.ts";
import { fitState, type StateTooLarge } from "./state/fit.ts";
import { goalFromMessages } from "./state/history.ts";
import type { FittedState } from "./state/types.ts";
import { collectToolCalls, type ToolCall } from "./tool-call.ts";
import type { Message } from "./transcript.ts";

export type CompactError =
  | StateTooLarge
  | { readonly kind: "model_failed"; readonly message: string; readonly cause: ModelError }
  | { readonly kind: "invalid_score"; readonly message: string };

export interface CompactStats {
  readonly model: string;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  readonly calls: number;
  readonly kept: number;
  readonly resultsDropped: number;
  readonly callsDropped: number;
  readonly pinned: number;
  readonly stateTokens: number;
  /** Which fitting stage the state needed, '' when no state was built. */
  readonly stateStage: string;
  readonly requests: number;
  readonly ms: number;
}

export interface CompactResult {
  /** The compacted transcript. Untouched messages are the input objects. */
  readonly messages: readonly Message[];
  readonly decisions: readonly CallDecision[];
  readonly stats: CompactStats;
}

interface Scored {
  readonly scores: ReadonlyMap<string, CallScore>;
  readonly requests: number;
  readonly fitted: FittedState | null;
}

const KEEP_ALL: CallScore = { keepCall: 1, keepResult: 1 };

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

async function askModel(
  model: DecisionModel,
  request: ScoreRequest,
): Promise<Result<ScoreResponse, CompactError>> {
  try {
    const response = await model.score(request);
    if (response.ok) return response;
    return err({
      kind: "model_failed",
      message: `${model.id}: ${response.error.message}`,
      cause: response.error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause: ModelError = { kind: "unexpected", message };
    return err({ kind: "model_failed", message: `${model.id} threw: ${message}`, cause });
  }
}

function checkScores(
  candidates: readonly ToolCall[],
  scores: ReadonlyMap<string, CallScore>,
): Result<ReadonlyMap<string, CallScore>, CompactError> {
  for (const call of candidates) {
    const score = scores.get(call.id);
    if (!score || !isProbability(score.keepCall) || !isProbability(score.keepResult)) {
      return err({
        kind: "invalid_score",
        message: `missing or out-of-range score for ${call.id} (${call.tool})`,
      });
    }
  }
  return ok(scores);
}

async function scoreCandidates(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  model: DecisionModel,
  options: ResolvedCompactOptions,
): Promise<Result<Scored, CompactError>> {
  const candidates = calls.filter((call) => !call.pinned);
  if (candidates.length === 0) return ok({ scores: new Map(), requests: 0, fitted: null });
  const goal = options.goal || goalFromMessages(messages);
  const estimateTokens = model.capabilities.estimateTokens;
  const fitted =
    model.capabilities.state === "global"
      ? fitState(messages, calls, { ...options, goal, estimateTokens })
      : ok(null);
  if (!fitted.ok) return fitted;
  const state = fitted.value?.state ?? null;
  const stateTokens = fitted.value?.tokens ?? 0;
  const { instructions } = options;
  const request = { goal, instructions, state, stateTokens, candidates, calls, messages };
  const response = await askModel(model, request);
  if (!response.ok) return response;
  const scores = checkScores(candidates, response.value.scores);
  if (!scores.ok) return scores;
  return ok({ scores: scores.value, requests: response.value.requests, fitted: fitted.value });
}

function count(decisions: readonly CallDecision[], reason: CallDecision["reason"]): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

function chars(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

function statsOf(
  model: DecisionModel,
  before: readonly Message[],
  after: readonly Message[],
  decisions: readonly CallDecision[],
  scored: Scored,
  started: number,
): CompactStats {
  return {
    model: model.id,
    messagesBefore: before.length,
    messagesAfter: after.length,
    charsBefore: chars(before),
    charsAfter: chars(after),
    calls: decisions.length,
    kept: count(decisions, "kept"),
    resultsDropped: count(decisions, "result_dropped"),
    callsDropped: count(decisions, "call_dropped"),
    pinned: count(decisions, "pinned"),
    stateTokens: scored.fitted?.tokens ?? 0,
    stateStage: scored.fitted?.stage ?? "",
    requests: scored.requests,
    ms: Date.now() - started,
  };
}

/**
 * Compacts a transcript by asking `model`, for every tool call outside the
 * pinned first and newest messages, whether the call and whether its result
 * must stay. Text is never rewritten. Returns an error instead of throwing
 * when the model fails or the history cannot be fitted; the caller decides
 * what to fall back to.
 */
export async function compact(
  messages: readonly Message[],
  model: DecisionModel,
  options: CompactOptions = {},
): Promise<Result<CompactResult, CompactError>> {
  const started = Date.now();
  const resolved = resolveOptions(options, {
    keepThreshold: model.capabilities.defaultKeepThreshold,
    maxStateTokens: model.capabilities.maxStateTokens,
  });
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const scored = await scoreCandidates(messages, calls, model, resolved);
  if (!scored.ok) return scored;
  const decisions = calls.map((call) =>
    decideCall(call, scored.value.scores.get(call.id) ?? KEEP_ALL, resolved),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars, {
    noteDroppedCalls: resolved.noteDroppedCalls,
  });
  const stats = statsOf(model, messages, kept, decisions, scored.value, started);
  return ok({ messages: kept, decisions, stats });
}

/** Share of characters removed: 0 when nothing was, 1 when everything was. */
export function reductionRatio(result: Pick<CompactResult, "stats">): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}
