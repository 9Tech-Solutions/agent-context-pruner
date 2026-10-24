import { err, ok, type Result } from "@9tech.solutions/pruner-domain";
import type { Message, ToolResult, ToolUse } from "@9tech.solutions/pruner-domain";

export interface PruneRequest {
  readonly messages: readonly Message[];
  readonly instructions?: string;
}

export interface ParseError {
  readonly kind: "invalid_input";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolUse(value: unknown): value is ToolUse {
  return (
    isRecord(value) &&
    typeof value["tool_use_id"] === "string" &&
    typeof value["tool"] === "string" &&
    isRecord(value["input"]) &&
    (value["text"] === undefined || typeof value["text"] === "string") &&
    (value["isError"] === undefined || typeof value["isError"] === "boolean")
  );
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    isRecord(value) &&
    typeof value["tool_use_id"] === "string" &&
    typeof value["text"] === "string" &&
    (value["isError"] === undefined || typeof value["isError"] === "boolean")
  );
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value["role"] === "user" || value["role"] === "assistant") &&
    typeof value["text"] === "string" &&
    Array.isArray(value["toolUses"]) &&
    value["toolUses"].every(isToolUse) &&
    (value["toolResults"] === undefined ||
      (Array.isArray(value["toolResults"]) && value["toolResults"].every(isToolResult)))
  );
}

function isRequest(value: unknown): value is PruneRequest {
  return (
    isRecord(value) &&
    Array.isArray(value["messages"]) &&
    value["messages"].every(isMessage) &&
    (value["instructions"] === undefined || typeof value["instructions"] === "string")
  );
}

/** Parse and validate the entire host-neutral transcript before compaction. */
export function parseRequest(input: string): Result<PruneRequest, ParseError> {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return err({ kind: "invalid_input" });
  }
  return isRequest(value) ? ok(value) : err({ kind: "invalid_input" });
}
