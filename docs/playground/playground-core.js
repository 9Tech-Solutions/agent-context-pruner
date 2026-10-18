/**
 * Core validation, computation, and export utilities for the agent-context-pruner playground.
 * Zero external dependencies. Works in browser ES modules and Node.js test runners.
 */

export function escapeXml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function validateReport(raw) {
  if (!raw) {
    return { ok: false, error: "Empty evaluation data payload" };
  }

  let report = raw;
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { ok: false, error: "Evaluation report array is empty" };
    }
    report = raw[0];
  }

  if (typeof report !== "object" || report === null) {
    return { ok: false, error: "Evaluation report must be a JSON object" };
  }

  if (typeof report.model !== "string" || report.model.trim() === "") {
    return { ok: false, error: 'Report is missing valid "model" identifier' };
  }

  if (!Number.isInteger(report.scoredCalls) || report.scoredCalls <= 0 || report.requests !== 0) {
    return { ok: false, error: 'Report is missing valid positive "scoredCalls" count' };
  }

  if (!Array.isArray(report.rows) || report.rows.length === 0) {
    return { ok: false, error: 'Report is missing recorded threshold "rows"' };
  }

  for (let i = 0; i < report.rows.length; i++) {
    const row = report.rows[i];
    if (typeof row !== "object" || row === null) {
      return { ok: false, error: `Invalid threshold row at index ${i}` };
    }
    const requiredNumbers = [
      "threshold",
      "kept",
      "truncated",
      "dropped",
      "needed",
      "lost",
      "lossRate",
      "reduction",
      "netReduction",
    ];
    for (const key of requiredNumbers) {
      if (!Number.isFinite(row[key])) {
        return { ok: false, error: `Row ${i} missing valid numeric "${key}"` };
      }
    }
    const counts = ["kept", "truncated", "dropped", "needed", "lost"];
    if (
      counts.some((key) => !Number.isInteger(row[key]) || row[key] < 0) ||
      row.kept + row.truncated + row.dropped !== report.scoredCalls ||
      row.needed > report.scoredCalls ||
      row.lost > row.needed ||
      row.threshold <= 0 ||
      row.threshold >= 1 ||
      row.lossRate < 0 ||
      row.lossRate > 1
    ) {
      return { ok: false, error: `Row ${i} has inconsistent counts or rates` };
    }
  }

  return { ok: true, report };
}

export function findRowByThreshold(rows, targetThreshold) {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isFinite(targetThreshold)) return null;

  const targetCents = Math.round(Number(targetThreshold) * 100);
  const exact = rows.find((r) => Math.round(r.threshold * 100) === targetCents);
  if (exact) return exact;

  let closest = rows[0];
  let minDiff = Math.abs(rows[0].threshold - targetThreshold);
  for (let i = 1; i < rows.length; i++) {
    const diff = Math.abs(rows[i].threshold - targetThreshold);
    if (diff < minDiff) {
      minDiff = diff;
      closest = rows[i];
    }
  }
  return closest;
}

export function parseHashThreshold(hash, allowedThresholds = null) {
  if (!hash || typeof hash !== "string") return null;

  const clean = hash.replace(/^[#?]+/, "").trim();
  if (!clean) return null;

  let rawValue = null;
  const match = clean.match(/^(?:threshold|t)=(0\.\d{1,2})$/i);
  if (match) {
    rawValue = match[1];
  } else if (/^0\.\d{1,2}$/.test(clean)) {
    rawValue = clean;
  }

  if (rawValue === null) return null;

  const num = parseFloat(rawValue);
  if (Number.isNaN(num)) return null;

  if (Array.isArray(allowedThresholds) && allowedThresholds.length > 0) {
    const roundedCents = Math.round(num * 100);
    const matched = allowedThresholds.find((t) => Math.round(t * 100) === roundedCents);
    return matched !== undefined ? matched : null;
  }

  return num;
}

export function formatPercent(val, includeSign = false) {
  if (typeof val !== "number" || Number.isNaN(val)) return "0%";
  const rounded = Math.round(val * 100);
  if (rounded === 0) return "0%";
  if (includeSign && rounded > 0) return `+${rounded}%`;
  return `${rounded}%`;
}

export function generateMarkdownSummary(report, row) {
  const model = report.model || "heuristic:v2";
  const calls = report.scoredCalls || 11;
  const th = row.threshold.toFixed(2);
  const net = formatPercent(row.netReduction);
  const gross = formatPercent(row.reduction);
  const lossRate = formatPercent(row.lossRate);

  return [
    `### agent-context-pruner evaluation: ${model}`,
    "",
    `> SYNTHETIC FIXTURE / PRECOMPUTED EVALUATION`,
    `> Evaluated on synthetic session.jsonl with ${calls} scored tool calls.`,
    `> This is a synthetic evaluation, not live session pruning or real-world savings.`,
    "",
    `- **Keep threshold:** ${th}`,
    `- **Actions taken:** ${row.kept} kept, ${row.truncated} truncated, ${row.dropped} dropped (total ${calls})`,
    `- **Call necessity:** ${row.needed} needed later, ${row.lost} lost (loss rate: ${lossRate})`,
    `- **Character reduction:** ${gross}`,
    `- **Net reduction after modeled re-reads:** ${net}`,
    "",
    `The evaluator charges an estimated full re-read for each lost result. Reduction is measured in characters. Negative net reduction means expansion, not a measured billing or subscription-usage change.`,
    "",
    "Reproduce: https://github.com/9Tech-Solutions/agent-context-pruner/tree/main/examples/synthetic-session-evaluation",
  ].join("\n");
}

export function generateSvgCard(report, row) {
  const model = escapeXml(report.model || "heuristic:v2");
  const calls = report.scoredCalls || 11;
  const th = row.threshold.toFixed(2);
  const net = formatPercent(row.netReduction);
  const gross = formatPercent(row.reduction);
  const kept = row.kept;
  const truncated = row.truncated;
  const dropped = row.dropped;
  const lost = row.lost;
  const needed = row.needed;

  const barTotalWidth = 592;
  const keptWidth = Math.round((kept / calls) * barTotalWidth);
  const truncWidth = Math.round((truncated / calls) * barTotalWidth);
  const dropWidth = barTotalWidth - keptWidth - truncWidth;

  const netColor = row.netReduction < 0 ? "#ff7b72" : row.netReduction > 0 ? "#cff76a" : "#eae7dc";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 440" width="720" height="440" role="img" aria-label="Evaluation Result Card">
  <defs>
    <style>
      .bg { fill: #f4f3ed; }
      .ink { fill: #17231f; }
      .ink-muted { fill: #536b63; }
      .card-dark { fill: #17231f; rx: 8px; }
      .text-light { fill: #f4f3ed; }
      .accent-lime { fill: #cff76a; }
      .badge-bg { fill: #17231f; rx: 4px; }
      .badge-text { fill: #cff76a; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
      .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .display-stat { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 44px; font-weight: 800; }
      .sublabel { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
      .bar-kept { fill: #cff76a; }
      .bar-trunc { fill: #f59e0b; }
      .bar-drop { fill: #536b63; }
    </style>
  </defs>

  <!-- Background -->
  <rect width="720" height="440" class="bg" />
  <rect x="20" y="20" width="680" height="410" fill="none" stroke="#d3cfc2" stroke-width="1" rx="8" />

  <!-- Persistent Synthetic Badges -->
  <g transform="translate(40, 42)">
    <rect width="210" height="24" class="badge-bg" />
    <text x="10" y="16" class="badge-text">SYNTHETIC / PRECOMPUTED</text>
  </g>
  <text x="260" y="58" class="mono ink-muted" font-size="12">offline fixture: session.jsonl</text>
  <text x="680" y="58" class="mono ink-muted" font-size="12" text-anchor="end">model: ${model}</text>

  <!-- Title -->
  <text x="40" y="100" class="sans ink" font-size="20" font-weight="700">agent-context-pruner: evaluation</text>
  <text x="40" y="122" class="sans ink-muted" font-size="13">Aggregate evaluation at threshold ${th} across ${calls} tool calls</text>

  <!-- Dark Result Band -->
  <rect x="40" y="142" width="640" height="150" class="card-dark" />

  <!-- Column 1: Net Reduction -->
  <g transform="translate(64, 172)">
    <text x="0" y="0" class="sublabel" fill="#a0b0aa">Net, modeled re-reads</text>
    <text x="0" y="44" class="display-stat" fill="${netColor}">${net}</text>
    <text x="0" y="66" class="mono" font-size="11" fill="#a0b0aa">Character reduction: ${gross}</text>
  </g>

  <!-- Column 2: Calls Breakdown -->
  <g transform="translate(300, 172)">
    <text x="0" y="0" class="sublabel" fill="#a0b0aa">Scored Actions</text>
    <text x="0" y="32" class="sans text-light" font-size="22" font-weight="700">${kept} Kept</text>
    <text x="0" y="54" class="sans" font-size="14" fill="#a0b0aa">${truncated} Truncated / ${dropped} Dropped</text>
  </g>

  <!-- Column 3: Loss -->
  <g transform="translate(510, 172)">
    <text x="0" y="0" class="sublabel" fill="#a0b0aa">Needed results</text>
    <text x="0" y="32" class="sans" font-size="22" font-weight="700" fill="${lost > 0 ? "#ff7b72" : "#cff76a"}">${lost} Lost</text>
    <text x="0" y="54" class="mono" font-size="13" fill="#a0b0aa">out of ${needed} needed</text>
  </g>

  <!-- Visual segmented bar inside dark band -->
  <g transform="translate(64, 256)">
    <rect x="0" y="0" width="${keptWidth}" height="10" class="bar-kept" rx="2" />
    <rect x="${keptWidth}" y="0" width="${truncWidth}" height="10" class="bar-trunc" rx="2" />
    <rect x="${keptWidth + truncWidth}" y="0" width="${dropWidth}" height="10" class="bar-drop" rx="2" />
  </g>

  <!-- Legend & Tradeoff note -->
  <g transform="translate(40, 320)">
    <circle cx="6" cy="6" r="5" class="bar-kept" />
    <text x="18" y="10" class="mono ink" font-size="11">Kept (${kept})</text>

    <circle cx="110" cy="6" r="5" class="bar-trunc" />
    <text x="122" y="10" class="mono ink" font-size="11">Truncated (${truncated})</text>

    <circle cx="230" cy="6" r="5" class="bar-drop" />
    <text x="242" y="10" class="mono ink" font-size="11">Dropped (${dropped})</text>
  </g>

  <!-- Warning / Explanation Footer inside Card -->
  <text x="40" y="360" class="sans ink" font-size="12" font-weight="600">Threshold ${th} Tradeoff:</text>
  <text x="40" y="380" class="sans ink-muted" font-size="12">${lost > 0 ? "A later-reused result was lost. The estimate includes a full re-read penalty." : "No later-reused result was lost at this recorded threshold."}</text>
  <text x="40" y="405" class="mono ink-muted" font-size="10">SYNTHETIC / PRECOMPUTED / CHARACTERS, NOT TOKEN OR PLAN SAVINGS</text>
  <text x="40" y="423" class="mono ink-muted" font-size="10">github.com/9Tech-Solutions/agent-context-pruner</text>
</svg>`;
}
