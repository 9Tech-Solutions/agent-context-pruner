import type { ModelReport, Spread } from "./report.ts";
import type { SweepRow } from "./sweep.ts";

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const two = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
const spreadText = (spread: Spread | null) =>
  spread ? `median ${two(spread.median)} (${two(spread.min)} to ${two(spread.max)})` : "n/a";

function row(cells: readonly string[]): string {
  const widths = [9, 6, 9, 6, 9, 14, 5];
  return cells.map((cell, i) => cell.padStart(widths[i] ?? 8)).join(" ");
}

function sweepTable(rows: readonly SweepRow[], recommended: SweepRow | null): string[] {
  const header = row(["threshold", "kept", "truncated", "drop", "reduction", "needed lost", "net"]);
  const lines = rows.map((r) => {
    const mark = r === recommended ? "  <- recommended" : "";
    const lost = `${r.lost}/${r.needed} (${pct(r.lossRate)})`;
    const cells = [
      two(r.threshold),
      `${r.kept}`,
      `${r.truncated}`,
      `${r.dropped}`,
      pct(r.reduction),
      lost,
      pct(r.netReduction),
    ];
    return row(cells) + mark;
  });
  return [header, ...lines];
}

function verdict(report: ModelReport): string {
  const { maxLossRate } = report.options;
  const limit = maxLossRate < 1 ? `, loss limit ${pct(maxLossRate)}` : "";
  const best = report.recommended;
  if (report.points === 0)
    return "no compaction point could be scored, so there is no recommendation";
  if (!best) return `no threshold keeps lost needed results within ${pct(maxLossRate)}`;
  return (
    `recommended keep threshold: ${two(best.threshold)} ` +
    `(${pct(best.netReduction)} net reduction after re-reads, ` +
    `${pct(best.lossRate)} of needed results lost${limit})`
  );
}

/** A plain-text report for a terminal. */
export function formatReport(report: ModelReport): string {
  const seconds = (report.ms / 1000).toFixed(1);
  return [
    `${report.model}: ${report.points} compaction points, ${report.scoredCalls} scored calls, ${report.requests} requests, ${seconds} s`,
    `  calls holding text reused later: ${pct(report.neededShare)} of scored calls`,
    `  ranking quality (AUC, 0.5 = chance): keep-result ${two(report.aucResult)}, keep-call ${two(report.aucCall)}`,
    `  keep-call ${spreadText(report.keepCall)}, keep-result ${spreadText(report.keepResult)}`,
    ...sweepTable(report.rows, report.recommended).map((line) => `  ${line}`),
    `  ${verdict(report)}`,
    ...report.errors.map((error) => `  skipped: ${error}`),
  ].join("\n");
}
