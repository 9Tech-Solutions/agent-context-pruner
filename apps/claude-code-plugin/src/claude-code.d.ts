/**
 * The part of Claude Code's function-hook API this plugin uses, written from
 * the declarations Claude Code 2.1.296 generates (`plugin-authoring` types).
 * Type-only: `import type` from "claude-code" is erased from the bundle.
 * `claude plugin validate plugin` checks the module against the real API.
 */
declare module "claude-code" {
  export type PluginOptions = Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;

  export interface ToolUseSummary {
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
    result?: unknown;
    text?: string;
    isError?: true;
  }

  export interface ToolResultSummary {
    tool_use_id: string;
    text: string;
    isError: boolean;
    result?: unknown;
  }

  export interface SessionMessage {
    role: "user" | "assistant";
    text: string;
    toolUses: ToolUseSummary[];
    toolResults?: ToolResultSummary[];
    /** Stamped by the engine on messages it hands a `session.compact` hook. */
    handle?: string;
  }

  export type SessionCompactTrigger = "manual" | "auto" | "plugin" | "precompute";

  export interface SessionCompactInput {
    readonly trigger: SessionCompactTrigger;
    readonly agentId?: string;
    readonly instructions?: string;
    readonly messages: readonly SessionMessage[];
  }

  export type SessionCompactResult =
    | { messages: readonly SessionMessage[]; tokensBefore?: number; tokensAfter?: number }
    | { skip: string; messages?: undefined };

  export interface HttpInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  export interface HttpResponse {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    text: string;
  }

  export interface Engine {
    readonly ui: {
      readonly log: (text: string) => void;
      readonly toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
    readonly http: {
      readonly fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>;
    };
    readonly env: {
      readonly get: (name: string) => Promise<string | undefined>;
    };
    readonly session: {
      readonly usage: () => Promise<{ context: { percent?: number } }>;
      readonly compact: () => Promise<SessionCompactResult>;
    };
  }

  /** `turn.complete` is passed through untouched, so its shapes stay opaque here. */
  export type TurnCompleteInput = Readonly<Record<string, unknown>>;
  export type TurnCompleteResult = unknown;

  export interface Registration {
    readonly catch: (handler: (...args: never[]) => unknown) => Registration;
  }

  export interface On {
    (
      event: "session.compact",
      hook: (
        $: Engine,
        e: SessionCompactInput,
        next: (e: SessionCompactInput) => Promise<SessionCompactResult>,
      ) => Promise<SessionCompactResult>,
    ): Registration;
    (
      event: "turn.complete",
      hook: (
        $: Engine,
        e: TurnCompleteInput,
        next: (e: TurnCompleteInput) => Promise<TurnCompleteResult>,
      ) => Promise<TurnCompleteResult>,
    ): Registration;
  }

  export type Register = (on: On, options: PluginOptions) => unknown;
}
