import type { CallScore } from "../decision.ts";
import type { Result } from "../result.ts";
import type { CompactionState } from "../state/types.ts";
import type { TokenEstimator } from "../tokens.ts";
import type { ToolCall } from "../tool-call.ts";
import type { Message } from "../transcript.ts";

export interface ModelCapabilities {
  /**
   * `global`: the model reads the whole fitted conversation as state (Jev and
   * other SystemOne models). `none`: it scores from the calls alone (rules).
   */
  readonly state: "global" | "none";
  /** Estimated token ceiling for the state. Ignored when `state` is `none`. */
  readonly maxStateTokens: number;
  readonly estimateTokens: TokenEstimator;
  /** Keep threshold calibrated for this model. A `CompactOptions` value overrides it. */
  readonly defaultKeepThreshold: number;
}

export interface ScoreRequest {
  readonly goal: string;
  /** The fitted conversation, or null for models whose `state` is `none`. */
  readonly state: CompactionState | null;
  readonly stateTokens: number;
  /** The calls to score: every call outside the pinned messages. */
  readonly candidates: readonly ToolCall[];
  /** Every call in the transcript, pinned ones included, for context. */
  readonly calls: readonly ToolCall[];
  readonly messages: readonly Message[];
}

export interface ScoreResponse {
  /** One score per candidate, keyed by `ToolCall.id`. */
  readonly scores: ReadonlyMap<string, CallScore>;
  /** Requests the model needed, for stats. */
  readonly requests: number;
}

export type ModelErrorKind =
  | "config"
  | "transport"
  | "http"
  | "invalid_response"
  | "limit"
  | "unexpected";

export interface ModelError {
  readonly kind: ModelErrorKind;
  readonly message: string;
}

/**
 * The port every decision model plugs into: hosted APIs, local servers, or
 * rules. Implementations return errors as values and never throw.
 */
export interface DecisionModel {
  /** Stable identifier for logs and stats, for example `systemone:typesafe:jev-latest`. */
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  score(request: ScoreRequest): Promise<Result<ScoreResponse, ModelError>>;
}
