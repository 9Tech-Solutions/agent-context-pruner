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

/** Every unpinned decision with both probabilities, split into lines the log can hold. */
export function decisionLogLines(result: CompactResult): string[] {
  const entries = result.decisions
    .filter((d) => d.reason !== "pinned")
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    );
  if (entries.length === 0) return ["decisions: (none)"];
  const chunks: string[] = [];
  let current = "";
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > LOG_LINE_CHARS) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}
