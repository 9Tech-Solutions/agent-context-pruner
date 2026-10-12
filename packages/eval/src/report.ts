import { auc } from "./auc.ts";
import type { CutEvaluation, LabeledCall } from "./evaluate.ts";
import { recommend, sweep, type SweepRow } from "./sweep.ts";

export interface ReportOptions {
  /** Characters a truncated result keeps, as the plugin's `truncateHeadChars`. */
  readonly headChars: number;
  /** Largest share of later-needed results a recommended threshold may remove; 1 sets no limit. */
  readonly maxLossRate: number;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = { headChars: 300, maxLossRate: 1 };

/** Median and range of one score across every scored call. */
export interface Spread {
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

/** How one model did across every evaluated compaction point. Holds scores and labels only, never transcript text. */
export interface ModelReport {
  readonly model: string;
  readonly points: number;
  readonly scoredCalls: number;
  readonly requests: number;
  readonly ms: number;
  /** Share of scored calls holding text the model reused later. */
  readonly neededShare: number;
  /** How well keep-result ranks reused results above the rest (0.5 is chance). */
  readonly aucResult: number | null;
  /** How well keep-call ranks calls named or reused later above the rest. */
  readonly aucCall: number | null;
  readonly keepCall: Spread | null;
  readonly keepResult: Spread | null;
  readonly rows: readonly SweepRow[];
  readonly recommended: SweepRow | null;
  readonly options: ReportOptions;
  /** Points the model could not score, with why. */
  readonly errors: readonly string[];
}

function spreadOf(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { min: sorted[0]!, median, max: sorted.at(-1)! };
}

export function buildReport(
  model: string,
  evaluations: readonly CutEvaluation[],
  errors: readonly string[],
  options: ReportOptions = DEFAULT_REPORT_OPTIONS,
): ModelReport {
  const scored: LabeledCall[] = evaluations.flatMap((evaluation) => [...evaluation.scored]);
  const rows = sweep(evaluations, options.headChars);
  const needed = scored.filter((call) => call.label.resultNeeded || call.label.inputNeeded).length;
  return {
    model,
    points: evaluations.length,
    scoredCalls: scored.length,
    requests: evaluations.reduce((sum, e) => sum + e.requests, 0),
    ms: evaluations.reduce((sum, e) => sum + e.ms, 0),
    neededShare: scored.length === 0 ? 0 : needed / scored.length,
    aucResult: auc(
      scored.map((call) => call.keepResult),
      scored.map((call) => call.label.resultNeeded),
    ),
    aucCall: auc(
      scored.map((call) => call.keepCall),
      scored.map((call) => call.label.callNeeded),
    ),
    keepCall: spreadOf(scored.map((call) => call.keepCall)),
    keepResult: spreadOf(scored.map((call) => call.keepResult)),
    rows,
    recommended: evaluations.length === 0 ? null : recommend(rows, options.maxLossRate),
    options,
    errors,
  };
}
