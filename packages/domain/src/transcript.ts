export type Role = "user" | "assistant";

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome when the host attaches it to the call (Claude Code does).
 */
export interface ToolUse {
  readonly tool_use_id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly text?: string;
  readonly isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  readonly tool_use_id: string;
  readonly text: string;
  readonly isError?: boolean;
}

/**
 * One transcript message, independent of any host. Host adapters (Claude
 * Code, Codex, ...) map their own message type to and from this one.
 */
export interface Message {
  readonly role: Role;
  readonly text: string;
  readonly toolUses: readonly ToolUse[];
  readonly toolResults?: readonly ToolResult[];
}
