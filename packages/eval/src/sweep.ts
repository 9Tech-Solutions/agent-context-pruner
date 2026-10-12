import {
  applyDecisions,
  decideCall,
  keptChars,
  messageChars,
  type CallDecision,
  type Message,
} from "@9tech.solutions/pruner-domain";
import type { CutEvaluation } from "./evaluate.ts";
import type { Holder } from "./labels.ts";

/** 0.05, 0.10, ... 0.95. */
export const THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);

/** What one keep threshold would have done across every evaluated compaction point. */
export interface SweepRow {
  readonly threshold: number;
  readonly kept: number;
  readonly truncated: number;
  readonly dropped: number;
  /** Share of characters removed, pooled over every point. */
  readonly reduction: number;
  /** Scored calls holding text the model reused later. */
  readonly needed: number;
  /** Calls to fetch again because this threshold removed every copy of some reused text. */
  readonly lost: number;
  /** `lost / needed`, 0 when nothing was needed. */
  readonly lossRate: number;
  /**
   * Share of characters removed once every lost result is fetched again in
   * full: what a compaction at this threshold saves after the re-reads it causes.
   */
  readonly netReduction: number;
}

const KEEP = { keepCall: 1, keepResult: 1 };

/** Whether a copy of reused text survives `action`: an input stays unless the call goes, a result as far as `keptChars` keeps it. */
export function survives(
  holder: Holder,
  action: CallDecision["action"],
  headChars: number,
): boolean {
  if (!holder.inResult) return action !== "drop_call";
  if (action === "keep") return true;
  if (action === "drop_call") return false;
  return holder.end <= keptChars(holder.cost, headChars);
}

/**
 * The calls to fetch again, with what each costs. A reused fragment whose
 * copies all go needs one of its calls re-run: fragments with the fewest
 * copies choose first, a fragment an already chosen call holds needs nothing
 * more, and otherwise its most recent copy is chosen.
 */
function rereads(
  evaluation: CutEvaluation,
  actions: ReadonlyMap<string, CallDecision["action"]>,
  headChars: number,
): Map<string, number> {
  const action = (h: Holder) => actions.get(h.callId) ?? "keep";
  const lost = evaluation.needed
    .filter((fragment) => !fragment.holders.some((h) => survives(h, action(h), headChars)))
    .sort((a, b) => a.holders.length - b.holders.length);
  const charges = new Map<string, number>();
  for (const fragment of lost) {
    if (fragment.holders.some((h) => charges.has(h.callId))) continue;
    const last = fragment.holders.at(-1);
    if (!last) continue;
    const costs = fragment.holders.filter((h) => h.callId === last.callId).map((h) => h.cost);
    charges.set(last.callId, Math.max(...costs));
  }
  return charges;
}

function decisionsAt(evaluation: CutEvaluation, threshold: number): CallDecision[] {
  const scores = new Map(evaluation.scored.map((call) => [call.id, call] as const));
  return evaluation.calls.map((call) =>
    decideCall(call, scores.get(call.id) ?? KEEP, { keepThreshold: threshold }),
  );
}

function chars(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

interface Tally {
  readonly kept: number;
  readonly truncated: number;
  readonly dropped: number;
  readonly needed: number;
  readonly lost: number;
  readonly lostChars: number;
  readonly before: number;
  readonly after: number;
}

const EMPTY: Tally = {
  kept: 0,
  truncated: 0,
  dropped: 0,
  needed: 0,
  lost: 0,
  lostChars: 0,
  before: 0,
  after: 0,
};

function add(a: Tally, b: Tally): Tally {
  return {
    kept: a.kept + b.kept,
    truncated: a.truncated + b.truncated,
    dropped: a.dropped + b.dropped,
    needed: a.needed + b.needed,
    lost: a.lost + b.lost,
    lostChars: a.lostChars + b.lostChars,
    before: a.before + b.before,
    after: a.after + b.after,
  };
}

function tallyCut(evaluation: CutEvaluation, threshold: number, headChars: number): Tally {
  const decisions = decisionsAt(evaluation, threshold);
  const actions = new Map(decisions.map((d) => [d.id, d.action] as const));
  const counts = { kept: 0, truncated: 0, dropped: 0, needed: 0 };
  for (const call of evaluation.scored) {
    const action = actions.get(call.id) ?? "keep";
    if (action === "keep") counts.kept++;
    else if (action === "drop_result") counts.truncated++;
    else counts.dropped++;
    if (call.label.resultNeeded || call.label.inputNeeded) counts.needed++;
  }
  const charges = rereads(evaluation, actions, headChars);
  const lostChars = [...charges.values()].reduce((sum, cost) => sum + cost, 0);
  const after = applyDecisions(evaluation.history, decisions, evaluation.calls, headChars);
  return {
    ...counts,
    lost: charges.size,
    lostChars,
    before: chars(evaluation.history),
    after: chars(after),
  };
}

/** Replays every point at every threshold: how much each would remove, and how much later-needed output it would lose. */
export function sweep(
  evaluations: readonly CutEvaluation[],
  headChars: number,
  thresholds: readonly number[] = THRESHOLDS,
): SweepRow[] {
  return thresholds.map((threshold) => {
    const tally = evaluations
      .map((evaluation) => tallyCut(evaluation, threshold, headChars))
      .reduce(add, EMPTY);
    const { before, after, needed, lost, lostChars } = tally;
    return {
      threshold,
      kept: tally.kept,
      truncated: tally.truncated,
      dropped: tally.dropped,
      reduction: before === 0 ? 0 : (before - after) / before,
      needed,
      lost,
      lossRate: needed === 0 ? 0 : lost / needed,
      netReduction: before === 0 ? 0 : (before - after - lostChars) / before,
    };
  });
}

/**
 * The threshold that saves the most after re-reads (the lowest one on a tie,
 * as it keeps more), among those whose loss rate stays within `maxLossRate`;
 * null when none does.
 */
export function recommend(rows: readonly SweepRow[], maxLossRate = 1): SweepRow | null {
  const within = rows.filter((row) => row.lossRate <= maxLossRate);
  return within.reduce<SweepRow | null>(
    (best, row) => (best === null || row.netReduction > best.netReduction + 1e-9 ? row : best),
    null,
  );
}
