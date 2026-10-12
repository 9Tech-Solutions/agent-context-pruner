import {
  err,
  ok,
  type ModelError,
  type Result,
  type ToolCall,
} from "@9tech.solutions/pruner-domain";
import type { HttpResponse } from "../transport.ts";

/** A SystemOne yes/no question; the answer is the probability of true. */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export type SystemOneQuestions = Readonly<Record<string, NoulQuestion>>;

export interface SystemOneAnswers {
  readonly answers: Readonly<Record<string, unknown>>;
}

/** Questions asked about each tool call. */
export const QUESTIONS_PER_CALL = 2;

/** The two questions asked about one call: keep the call, keep its full result. */
export function questionsFor(call: ToolCall): SystemOneQuestions {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

export function requestBody(model: string, state: unknown, questions: SystemOneQuestions): string {
  return JSON.stringify({ model, state, questions });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a SystemOne response; `unwrap` strips a provider envelope first. */
export function parseResponse(
  response: HttpResponse,
  unwrap: (body: unknown) => unknown,
): Result<SystemOneAnswers, ModelError> {
  if (!response.ok) {
    return err({
      kind: "http",
      message: `request failed (${response.status}): ${response.text.slice(0, 200)}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    return err({ kind: "invalid_response", message: "response is not valid JSON" });
  }
  const body = unwrap(parsed);
  if (!isRecord(body) || !isRecord(body["answers"])) {
    return err({ kind: "invalid_response", message: "response is missing answers" });
  }
  return ok({ answers: body["answers"] });
}

/** The probability of one `noul` answer. */
export function noulAnswer(
  answers: Readonly<Record<string, unknown>>,
  name: string,
): Result<number, ModelError> {
  const answer = answers[name];
  const value = isRecord(answer) ? answer["noul"] : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return ok(value);
  return err({ kind: "invalid_response", message: `invalid answer for ${name}` });
}

/** Strips Cloudflare's `{ result, success }` REST envelope when present. */
export function unwrapCloudflare(body: unknown): unknown {
  return isRecord(body) && isRecord(body["result"]) && "success" in body ? body["result"] : body;
}
