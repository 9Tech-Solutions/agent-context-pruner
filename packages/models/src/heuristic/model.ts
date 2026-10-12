import {
  estimateTokens,
  ok,
  type CallScore,
  type DecisionModel,
  type ToolCall,
} from "@9tech.solutions/pruner-domain";

export interface HeuristicOptions {
  /** Tool names that read a file. Compared case-insensitively. */
  readonly readTools?: readonly string[];
  /** Tool names that change a file. Compared case-insensitively. */
  readonly writeTools?: readonly string[];
  /** Input keys that hold a file path. */
  readonly pathKeys?: readonly string[];
  /** Results longer than this are truncated when no other rule applies. Default 4000. */
  readonly largeResultChars?: number;
}

interface Rules {
  readonly isRead: (tool: string) => boolean;
  readonly isWrite: (tool: string) => boolean;
  readonly pathOf: (call: ToolCall) => string | undefined;
  /** Paths the person named in the compaction's instructions: calls on them stay. */
  readonly named: (path: string) => boolean;
  readonly largeResultChars: number;
}

const READ_TOOLS = ["read", "read_file", "view", "notebookread"];
const WRITE_TOOLS = [
  "edit",
  "multiedit",
  "write",
  "notebookedit",
  "write_file",
  "edit_file",
  "apply_patch",
];
const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path"];

const KEEP: CallScore = { keepCall: 1, keepResult: 1 };
const DROP_CALL: CallScore = { keepCall: 0.1, keepResult: 0.1 };
const DROP_RESULT: CallScore = { keepCall: 0.9, keepResult: 0.1 };

/** Path-like words of the instructions (`src/auth.ts`, `README.md`), lower-cased with forward slashes. */
function namedPaths(instructions: string): string[] {
  return (instructions.match(/[\w.@~-]*[./\\][\w./\\@~-]+/g) ?? [])
    .map((word) =>
      word
        .replace(/\\/g, "/")
        .replace(/[.,;:]+$/, "")
        .toLowerCase(),
    )
    .filter((word) => word.length >= 3);
}

function rulesOf(options: HeuristicOptions, instructions: string): Rules {
  const reads = new Set((options.readTools ?? READ_TOOLS).map((t) => t.toLowerCase()));
  const writes = new Set((options.writeTools ?? WRITE_TOOLS).map((t) => t.toLowerCase()));
  const keys = options.pathKeys ?? PATH_KEYS;
  const named = namedPaths(instructions);
  return {
    isRead: (tool) => reads.has(tool.toLowerCase()),
    isWrite: (tool) => writes.has(tool.toLowerCase()),
    pathOf: (call) => {
      const value = keys.map((key) => call.input[key]).find((v) => typeof v === "string");
      return typeof value === "string" ? value.trim().replace(/\\/g, "/") : undefined;
    },
    largeResultChars: options.largeResultChars ?? 4000,
    named: (path) => {
      const lower = path.toLowerCase();
      return named.some((word) => lower === word || lower.endsWith(`/${word}`));
    },
  };
}

/**
 * Scores one call from what happened after it:
 * a file the person named in the compaction's instructions stays,
 * a file read again later is superseded (drop the call),
 * a file changed later has stale contents (keep the call, truncate the result),
 * a failed call retried successfully is settled (truncate the result),
 * and a large result is truncated. Everything else stays.
 */
function scoreCall(call: ToolCall, calls: readonly ToolCall[], rules: Rules): CallScore {
  const later = calls.filter((other) => other.callIndex > call.callIndex);
  const path = rules.pathOf(call);
  if (path && rules.named(path)) return KEEP;
  const touches = (other: ToolCall, kind: (tool: string) => boolean) =>
    kind(other.tool) && rules.pathOf(other) === path;
  if (path && rules.isRead(call.tool)) {
    if (later.some((other) => touches(other, rules.isRead))) return DROP_CALL;
    if (later.some((other) => touches(other, rules.isWrite))) return DROP_RESULT;
  }
  if (call.isError && later.some((other) => other.tool === call.tool && !other.isError))
    return DROP_RESULT;
  if (call.resultChars > rules.largeResultChars) return DROP_RESULT;
  return KEEP;
}

/**
 * A decision model that needs no model at all: deterministic rules over the
 * tool calls. Free, offline, and the fallback when a hosted or local model fails.
 */
export function createHeuristicModel(options: HeuristicOptions = {}): DecisionModel {
  return {
    id: "heuristic:v1",
    capabilities: { state: "none", maxStateTokens: 0, estimateTokens, defaultKeepThreshold: 0.5 },
    score: async (request) => {
      const rules = rulesOf(options, request.instructions);
      const scores = request.candidates.map(
        (call) => [call.id, scoreCall(call, request.calls, rules)] as const,
      );
      return ok({ scores: new Map(scores), requests: 0 });
    },
  };
}
