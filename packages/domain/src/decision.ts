import type { ToolCall } from "./tool-call.ts";

/** A model's keep probabilities for one tool call. */
export interface CallScore {
  /** Probability that knowing the call was made, with its input, still matters. */
  readonly keepCall: number;
  /** Probability that the full result must stay verbatim. */
  readonly keepResult: number;
}

export type CallAction = "keep" | "drop_result" | "drop_call";

export type DecisionReason = "pinned" | "kept" | "result_dropped" | "call_dropped";

export interface CallDecision extends CallScore {
  readonly id: string;
  readonly tool: string;
  readonly action: CallAction;
  readonly reason: DecisionReason;
}

/**
 * Keep call and result when `keepResult` reaches the threshold, keep only the
 * call when `keepCall` does, otherwise drop both. Pinned calls are always kept.
 */
export function decideCall(
  call: Pick<ToolCall, "id" | "tool" | "pinned">,
  score: CallScore,
  options: { readonly keepThreshold: number },
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...score };
  if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (score.keepResult >= options.keepThreshold) return { ...base, action: "keep", reason: "kept" };
  if (score.keepCall >= options.keepThreshold) {
    return { ...base, action: "drop_result", reason: "result_dropped" };
  }
  return { ...base, action: "drop_call", reason: "call_dropped" };
}
