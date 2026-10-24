import {
  collectToolCalls,
  compact,
  err,
  ok,
  type CompactError,
  type DecisionModel,
  type Message,
  type Result,
} from "@9tech.solutions/pruner-domain";

export interface PruneEdit {
  readonly callIndex: number;
  readonly resultIndex: number;
  readonly callId: string;
  readonly action: "drop_call" | "drop_result";
  readonly text?: string;
}

export interface PruneResponse {
  readonly edits: readonly PruneEdit[];
  readonly model: string;
}

export type PlanError = CompactError | { readonly kind: "plan_failed"; readonly message: string };

function resultTexts(messages: readonly Message[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) texts.set(result.tool_use_id, result.text);
  }
  return texts;
}

/** Turn compact's decisions into edits addressed to the host's original item indexes. */
export async function planPruning(
  messages: readonly Message[],
  model: DecisionModel,
  instructions?: string,
): Promise<Result<PruneResponse, PlanError>> {
  const calls = collectToolCalls(messages, 6);
  const compacted = await compact(messages, model, { preserveRecentMessages: 6, instructions });
  if (!compacted.ok) return compacted;
  const texts = resultTexts(compacted.value.messages);
  const edits: PruneEdit[] = [];
  for (const decision of compacted.value.decisions) {
    if (decision.action === "keep") continue;
    const call = calls.find((candidate) => candidate.id === decision.id);
    if (!call) return err({ kind: "plan_failed", message: "decision has no source call" });
    const edit: PruneEdit = {
      callIndex: call.callIndex,
      resultIndex: call.resultIndex,
      callId: call.tool_use_id,
      action: decision.action,
    };
    if (decision.action === "drop_call") {
      edits.push(edit);
      continue;
    }
    const text = texts.get(call.tool_use_id);
    if (text === undefined)
      return err({ kind: "plan_failed", message: "compacted result is missing" });
    if (!text.isWellFormed()) continue;
    edits.push({ ...edit, text });
  }
  return ok({ edits, model: model.id });
}
