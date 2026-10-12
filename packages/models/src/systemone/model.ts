import {
  err,
  estimateTokens,
  ok,
  type CallScore,
  type CompactionState,
  type DecisionModel,
  type ModelError,
  type Result,
  type ScoreRequest,
  type ScoreResponse,
  type ToolCall,
} from "@9tech.solutions/pruner-domain";
import { batchByBudget, mapLimited } from "../batch.ts";
import type { HttpResponse, HttpTransport } from "../transport.ts";
import { PROFILES, type SystemOneConfig, type SystemOneProfile } from "./profiles.ts";
import {
  noulAnswer,
  parseResponse,
  QUESTIONS_PER_CALL,
  questionsFor,
  requestBody,
  type SystemOneQuestions,
} from "./wire.ts";

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;
const DEFAULT_CONCURRENCY = 8;

interface Settings {
  readonly profile: SystemOneProfile;
  readonly model: string;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxRequestTokens: number;
  readonly maxStateTokens: number;
  readonly maxQuestionsPerRequest: number;
  readonly keepThreshold: number;
  readonly maxConcurrency: number;
}

function headersFor(apiKey: string | undefined): Record<string, string> {
  const json = { "content-type": "application/json" };
  return apiKey ? { ...json, authorization: `Bearer ${apiKey}` } : json;
}

function resolveSettings(config: SystemOneConfig): Result<Settings, ModelError> {
  const profile = PROFILES[config.profile];
  if (!profile)
    return err({ kind: "config", message: `unknown SystemOne profile: ${String(config.profile)}` });
  const model = config.model ?? profile.defaultModel;
  if (!model)
    return err({ kind: "config", message: `the ${profile.id} profile needs a model name` });
  if (profile.requiresApiKey && !config.apiKey) {
    return err({ kind: "config", message: `the ${profile.id} profile needs an API key` });
  }
  const endpoint = profile.endpoint(config, model);
  if (!endpoint.ok) return endpoint;
  return ok({
    profile,
    model,
    endpoint: endpoint.value,
    headers: headersFor(config.apiKey),
    maxRequestTokens: config.maxRequestTokens ?? profile.maxRequestTokens,
    maxStateTokens: config.maxStateTokens ?? profile.maxStateTokens,
    maxQuestionsPerRequest: config.maxQuestionsPerRequest ?? profile.maxQuestionsPerRequest,
    keepThreshold: config.keepThreshold ?? profile.keepThreshold,
    maxConcurrency: config.maxConcurrency ?? DEFAULT_CONCURRENCY,
  });
}

function scoresFrom(
  answers: Readonly<Record<string, unknown>>,
  batch: readonly ToolCall[],
): Result<Map<string, CallScore>, ModelError> {
  const scores = new Map<string, CallScore>();
  for (const call of batch) {
    const keepCall = noulAnswer(answers, `call_${call.id}`);
    if (!keepCall.ok) return keepCall;
    const keepResult = noulAnswer(answers, `result_${call.id}`);
    if (!keepResult.ok) return keepResult;
    scores.set(call.id, { keepCall: keepCall.value, keepResult: keepResult.value });
  }
  return ok(scores);
}

async function askBatch(
  settings: Settings,
  transport: HttpTransport,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Result<Map<string, CallScore>, ModelError>> {
  const questions: SystemOneQuestions = Object.fromEntries(
    batch.flatMap((call) => Object.entries(questionsFor(call))),
  );
  let response: HttpResponse;
  try {
    response = await transport({
      url: settings.endpoint,
      method: "POST",
      headers: settings.headers,
      body: requestBody(settings.model, state, questions),
    });
  } catch (error) {
    return err({
      kind: "transport",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const parsed = parseResponse(response, settings.profile.unwrap);
  return parsed.ok ? scoresFrom(parsed.value.answers, batch) : parsed;
}

function merge(
  answered: readonly Result<Map<string, CallScore>, ModelError>[],
): Result<ScoreResponse, ModelError> {
  const scores = new Map<string, CallScore>();
  for (const batch of answered) {
    if (!batch.ok) return batch;
    for (const [id, score] of batch.value) scores.set(id, score);
  }
  return ok({ scores, requests: answered.length });
}

/**
 * Splits the candidates into as many requests as the limits need, resends the
 * full state with every request, runs them concurrently, and merges answers.
 */
async function score(
  settings: Settings,
  transport: HttpTransport,
  request: ScoreRequest,
): Promise<Result<ScoreResponse, ModelError>> {
  const state = request.state;
  if (!state)
    return err({ kind: "config", message: "SystemOne models need the conversation state" });
  const batches = batchByBudget(
    request.candidates,
    (call) => estimateTokens(JSON.stringify(questionsFor(call))),
    {
      budget: settings.maxRequestTokens - request.stateTokens - REQUEST_OVERHEAD_TOKENS,
      maxItems: Math.max(1, Math.floor(settings.maxQuestionsPerRequest / QUESTIONS_PER_CALL)),
    },
  );
  if (!batches.ok) return batches;
  const answered = await mapLimited(batches.value, settings.maxConcurrency, (batch) =>
    askBatch(settings, transport, state, batch),
  );
  return merge(answered);
}

/**
 * A decision model for any server speaking the SystemOne request format:
 * TypeSafe Jev, Cloudflare Clef, Ollama, or a custom `/v1/systemone` server.
 */
export function createSystemOneModel(
  config: SystemOneConfig,
  transport: HttpTransport,
): Result<DecisionModel, ModelError> {
  const settings = resolveSettings(config);
  if (!settings.ok) return settings;
  const s = settings.value;
  return ok({
    id: `systemone:${s.profile.id}:${s.model}`,
    capabilities: {
      state: "global",
      maxStateTokens: s.maxStateTokens,
      estimateTokens,
      defaultKeepThreshold: s.keepThreshold,
    },
    score: (request) => score(s, transport, request),
  });
}
