import {
  callPath,
  estimateTokens,
  ok,
  PATH_KEYS,
  type CallScore,
  type DecisionModel,
  type ToolCall,
} from "@9tech.solutions/pruner-domain";

export interface HeuristicOptions {
  /** Tool names that read a file. Compared case-insensitively. */
  readonly readTools?: readonly string[];
  /** Input keys that hold a file path. */
  readonly pathKeys?: readonly string[];
  /** Messages after which a result's keep score halves. Default 80. */
  readonly halfLifeMessages?: number;
}

interface Rules {
  readonly isRead: (tool: string) => boolean;
  readonly pathOf: (call: ToolCall) => string | undefined;
  readonly halfLife: number;
}

const READ_TOOLS = ["read", "read_file", "view", "notebookread"];
/** Task lists and tool lookups: rarely needed again once the step is done. */
const BOOKKEEPING_TOOLS = new Set([
  "taskcreate",
  "taskupdate",
  "taskstop",
  "tasklist",
  "taskget",
  "todowrite",
  "toolsearch",
]);
/** Searches: their findings usually get read in full right after. */
const SEARCH_TOOLS = new Set(["grep", "glob", "websearch"]);
/** What the model wrote or delegated: reused more often than other output. */
const AUTHORED_TOOLS = new Set(["write", "agent", "task"]);

/**
 * Multipliers measured against what sessions reused later (76 recorded
 * sessions, `agent-context-pruner eval`): a read superseded by a later read of
 * the same file was reused 7% of the time against 18% for other reads, a failed
 * call retried successfully 6%, task bookkeeping 2 to 6%, searches 7%, and
 * writes and subagent reports 25%.
 */
const SUPERSEDED = 0.25;
const RETRIED = 0.3;
const BOOKKEEPING = 0.3;
const SEARCH = 0.6;
const AUTHORED = 1.5;

function rulesOf(options: HeuristicOptions): Rules {
  const reads = new Set((options.readTools ?? READ_TOOLS).map((t) => t.toLowerCase()));
  const keys = options.pathKeys ?? PATH_KEYS;
  const halfLife = options.halfLifeMessages ?? 80;
  return {
    isRead: (tool) => reads.has(tool.toLowerCase()),
    pathOf: (call) => callPath(call.input, keys),
    halfLife: Number.isFinite(halfLife) && halfLife > 0 ? halfLife : 80,
  };
}

function toolFactor(tool: string): number {
  const name = tool.toLowerCase();
  if (BOOKKEEPING_TOOLS.has(name)) return BOOKKEEPING;
  if (SEARCH_TOOLS.has(name)) return SEARCH;
  return AUTHORED_TOOLS.has(name) ? AUTHORED : 1;
}

function laterFactor(call: ToolCall, calls: readonly ToolCall[], rules: Rules): number {
  const later = calls.filter((other) => other.callIndex > call.callIndex);
  const path = rules.pathOf(call);
  const superseded =
    path !== undefined &&
    rules.isRead(call.tool) &&
    later.some((other) => rules.isRead(other.tool) && rules.pathOf(other) === path);
  if (superseded) return SUPERSEDED;
  const retried = call.isError && later.some((o) => o.tool === call.tool && !o.isError);
  return retried ? RETRIED : 1;
}

/**
 * Scores one call by how long ago it ran, the strongest signal of reuse in
 * recorded sessions: the result's score halves every `halfLife` messages,
 * scaled by what kind of tool it was and by what happened to it later. The
 * call's score is the square root of the result's, so a call outlives its
 * result: at a 0.5 threshold an ordinary result stays for `halfLife`
 * messages, is then truncated, and its call goes after twice that.
 */
function scoreCall(
  call: ToolCall,
  calls: readonly ToolCall[],
  total: number,
  rules: Rules,
): CallScore {
  const age = Math.max(0, total - call.callIndex);
  const decay = 0.5 ** (age / rules.halfLife);
  const keepResult = Math.min(1, decay * toolFactor(call.tool) * laterFactor(call, calls, rules));
  return { keepCall: Math.sqrt(keepResult), keepResult };
}

/**
 * A decision model that needs no model at all: deterministic rules over the
 * tool calls. Free, offline, and the fallback when a hosted or local model fails.
 */
export function createHeuristicModel(options: HeuristicOptions = {}): DecisionModel {
  const rules = rulesOf(options);
  return {
    id: "heuristic:v2",
    capabilities: { state: "none", maxStateTokens: 0, estimateTokens, defaultKeepThreshold: 0.5 },
    score: async (request) => {
      const total = request.messages.length;
      const scores = request.candidates.map(
        (call) => [call.id, scoreCall(call, request.calls, total, rules)] as const,
      );
      return ok({ scores: new Map(scores), requests: 0 });
    },
  };
}
