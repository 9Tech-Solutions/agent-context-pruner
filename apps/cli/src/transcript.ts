import type { Message, ToolResult, ToolUse } from "@9tech.solutions/pruner-domain";

/** A Claude Code session file, split where a compaction rewrote the context. */
export interface ParsedTranscript {
  readonly segments: readonly (readonly Message[])[];
  /** Lines that were not JSON. */
  readonly badLines: number;
}

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A block list's text; images become a marker so their size is not counted as text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isFields)
    .map((block) =>
      block["type"] === "text" ? text(block["text"]) : block["type"] === "image" ? "[image]" : "",
    )
    .filter((part) => part.length > 0)
    .join("\n");
}

function toolUse(block: Fields): ToolUse {
  const input = isFields(block["input"]) ? block["input"] : {};
  return { tool_use_id: text(block["id"]), tool: text(block["name"]), input };
}

function toolResult(block: Fields): ToolResult {
  return {
    tool_use_id: text(block["tool_use_id"]),
    text: contentText(block["content"]),
    isError: block["is_error"] === true,
  };
}

function toMessage(row: Fields): Message | null {
  const message = isFields(row["message"]) ? row["message"] : {};
  const role = row["type"] === "assistant" ? "assistant" : "user";
  const content = message["content"];
  const blocks = Array.isArray(content) ? content.filter(isFields) : [];
  const parsed: Message = {
    role,
    text: typeof content === "string" ? content : contentText(blocks),
    toolUses: blocks.filter((b) => b["type"] === "tool_use").map(toolUse),
    toolResults: blocks.filter((b) => b["type"] === "tool_result").map(toolResult),
  };
  const empty = !parsed.text.trim() && !parsed.toolUses.length && !parsed.toolResults?.length;
  return empty ? null : parsed;
}

function isConversation(row: Fields): boolean {
  return (
    (row["type"] === "user" || row["type"] === "assistant") &&
    row["isSidechain"] !== true &&
    row["isMeta"] !== true
  );
}

/**
 * Reads a Claude Code `.jsonl` session: main-thread user and assistant rows
 * only (no subagent or injected rows, no thinking), split into segments at
 * each `compact_boundary`, since what follows a compaction saw a different context.
 */
export function parseClaudeTranscript(jsonl: string): ParsedTranscript {
  const segments: Message[][] = [[]];
  let badLines = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!isFields(row)) continue;
    if (row["type"] === "system" && row["subtype"] === "compact_boundary") segments.push([]);
    else if (isConversation(row)) {
      const message = toMessage(row);
      if (message) segments.at(-1)!.push(message);
    }
  }
  return { segments: segments.filter((segment) => segment.length > 0), badLines };
}
