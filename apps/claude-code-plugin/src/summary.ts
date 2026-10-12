import { reductionRatio, type CompactResult } from "@9tech.solutions/pruner-domain";

/** Room the engine leaves for one `$.ui.log` line, with margin for the prefix. */
const LOG_LINE_CHARS = 1900;

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** One line for the toast: reduction, decision counts, model and state size. */
export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : "",
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : "",
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : "",
    stats.pinned > 0 ? `${stats.pinned} pinned` : "",
  ].filter(Boolean);
  const state = stats.stateStage
    ? `, state ~${stats.stateTokens} tokens (${stats.stateStage})`
    : "";
  return `${percent(reductionRatio(result))} reduction; ${parts.join(", ") || "no tool calls"}; ${stats.model}${state}, ${stats.requests} request(s)`;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** `median 0.22 (0.14 to 0.36)` for a non-empty list of probabilities. */
function spread(values: readonly number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const fixed = (value: number) => value.toFixed(2);
  return `median ${fixed(median(sorted))} (${fixed(sorted[0]!)} to ${fixed(sorted.at(-1)!)})`;
}

/** One line: how many calls were scored, what happened to them, and how the scores spread. */
export function decisionSummary(result: CompactResult): string {
  const scored = result.decisions.filter((d) => d.reason !== "pinned");
  const { stats } = result;
  const pinned = stats.pinned > 0 ? `, ${stats.pinned} pinned` : "";
  if (scored.length === 0) return `decisions: none scored${pinned}`;
  const counts = `${stats.kept} kept, ${stats.resultsDropped} truncated, ${stats.callsDropped} dropped`;
  const call = spread(scored.map((d) => d.keepCall));
  const keepResult = spread(scored.map((d) => d.keepResult));
  return (
    `decisions: ${scored.length} scored, ${counts}${pinned} at threshold ${stats.keepThreshold.toFixed(2)}; ` +
    `keep-call ${call}, keep-result ${keepResult}`
  );
}

function chunk(entries: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > LOG_LINE_CHARS) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * The summary line, followed by every unpinned decision with both
 * probabilities when `eachDecision` is on, split into lines the log can hold.
 */
export function decisionLogLines(result: CompactResult, eachDecision = false): string[] {
  const summary = decisionSummary(result);
  if (!eachDecision) return [summary];
  const entries = result.decisions
    .filter((d) => d.reason !== "pinned")
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    );
  const chunks = chunk(entries);
  return [
    summary,
    ...chunks.map((part, index) => `decision detail (${index + 1}/${chunks.length}): ${part}`),
  ];
}
