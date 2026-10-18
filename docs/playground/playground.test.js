import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateReport,
  findRowByThreshold,
  parseHashThreshold,
  formatPercent,
  generateMarkdownSummary,
  generateSvgCard,
} from "./playground-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const realFixturePath = path.resolve(
  __dirname,
  "../../examples/synthetic-session-evaluation/report.json",
);

describe("agent-context-pruner playground core tests", () => {
  it("validates the real repository fixture report.json", () => {
    const rawText = fs.readFileSync(realFixturePath, "utf8");
    const parsed = JSON.parse(rawText);
    const result = validateReport(parsed);

    assert.equal(result.ok, true, `Validation failed: ${result.error}`);
    assert.equal(result.report.model, "heuristic:v2");
    assert.equal(result.report.scoredCalls, 11);
    assert.equal(result.report.requests, 0);
    assert.equal(result.report.rows.length, 19);
  });

  it("rejects malformed and incomplete reports", () => {
    assert.equal(validateReport(null).ok, false);
    assert.equal(validateReport([]).ok, false);
    assert.equal(validateReport({}).ok, false);
    assert.equal(validateReport({ model: "x" }).ok, false);
    assert.equal(validateReport({ model: "x", scoredCalls: 11, rows: [] }).ok, false);
    assert.equal(
      validateReport({
        model: "x",
        scoredCalls: 11,
        rows: [{ threshold: "bad", kept: 1 }],
      }).ok,
      false,
    );
  });

  it("correctly selects discrete threshold rows and real values", () => {
    const rawText = fs.readFileSync(realFixturePath, "utf8");
    const { report } = validateReport(JSON.parse(rawText));

    // Baseline: 0.05
    const row005 = findRowByThreshold(report.rows, 0.05);
    assert.ok(row005, "Row 0.05 must exist");
    assert.equal(row005.threshold, 0.05);
    assert.equal(row005.kept, 11);
    assert.equal(row005.truncated, 0);
    assert.equal(row005.dropped, 0);
    assert.equal(row005.lost, 0);
    assert.equal(row005.reduction, 0);
    assert.equal(row005.netReduction, 0);
    assert.equal(formatPercent(row005.netReduction), "0%");

    // Onset: 0.85
    const row085 = findRowByThreshold(report.rows, 0.85);
    assert.ok(row085);
    assert.equal(row085.kept, 8);
    assert.equal(row085.truncated, 3);
    assert.equal(row085.dropped, 0);
    assert.equal(row085.lost, 0);

    // Failure / net expansion: 0.95
    const row095 = findRowByThreshold(report.rows, 0.95);
    assert.ok(row095, "Row 0.95 must exist");
    assert.equal(row095.threshold, 0.95);
    assert.equal(row095.kept, 1);
    assert.equal(row095.truncated, 3);
    assert.equal(row095.dropped, 7);
    assert.equal(row095.lost, 1);
    assert.equal(formatPercent(row095.netReduction), "-24%");
  });

  it("safely parses URL fragment hashes for thresholds", () => {
    const allowed = [0.05, 0.1, 0.85, 0.95];
    assert.equal(parseHashThreshold("#threshold=0.95", allowed), 0.95);
    assert.equal(parseHashThreshold("#t=0.05", allowed), 0.05);
    assert.equal(parseHashThreshold("#0.85", allowed), 0.85);
    assert.equal(parseHashThreshold("#threshold=0.99", allowed), null);
    assert.equal(parseHashThreshold("#malicious_string", allowed), null);
    assert.equal(parseHashThreshold("", allowed), null);
    assert.equal(parseHashThreshold("#threshold=0.95junk", allowed), null);
    assert.equal(parseHashThreshold("#threshold=0.949", allowed), null);
  });

  it("rejects non-finite metrics and inconsistent action counts", () => {
    const fixture = JSON.parse(fs.readFileSync(realFixturePath, "utf8"));
    const infinite = structuredClone(fixture);
    infinite[0].rows[0].netReduction = Infinity;
    assert.equal(validateReport(infinite).ok, false);
    const inconsistent = structuredClone(fixture);
    inconsistent[0].rows[0].kept = 12;
    assert.equal(validateReport(inconsistent).ok, false);
    const missingLoss = structuredClone(fixture);
    delete missingLoss[0].rows[0].lossRate;
    assert.equal(validateReport(missingLoss).ok, false);
  });

  it("generates SVG result card with persistent synthetic label and XML escaping", () => {
    const rawText = fs.readFileSync(realFixturePath, "utf8");
    const { report } = validateReport(JSON.parse(rawText));
    const row095 = findRowByThreshold(report.rows, 0.95);

    const svg = generateSvgCard(report, row095);
    assert.ok(
      svg.includes("SYNTHETIC / PRECOMPUTED"),
      "SVG must always display SYNTHETIC / PRECOMPUTED badge",
    );
    assert.ok(svg.includes("-24%"), "SVG must display -24% net reduction");
    assert.ok(svg.startsWith("<?xml"), "SVG must have XML declaration");
    assert.ok(svg.includes("</svg>"), "SVG must have closing svg tag");
    assert.ok(svg.includes("modeled re-reads"), "SVG must qualify the retrospective penalty");
    assert.ok(svg.includes("Character reduction"), "SVG must identify the actual measurement unit");

    // Test XML escaping with injected dangerous strings
    const dangerousReport = {
      ...report,
      model: '<script>alert("xss")</script> & "test"',
    };
    const escapedSvg = generateSvgCard(dangerousReport, row095);
    assert.ok(!escapedSvg.includes("<script>"), "Dangerous script tag must be escaped");
    assert.ok(escapedSvg.includes("&lt;script&gt;"), "Dangerous script tag must appear escaped");
    assert.ok(escapedSvg.includes("&amp;"), "Ampersand must be escaped");
  });

  it("generates clean Markdown summary for clipboard sharing", () => {
    const rawText = fs.readFileSync(realFixturePath, "utf8");
    const { report } = validateReport(JSON.parse(rawText));
    const row095 = findRowByThreshold(report.rows, 0.95);

    const markdown = generateMarkdownSummary(report, row095);
    assert.ok(markdown.includes("SYNTHETIC FIXTURE / PRECOMPUTED EVALUATION"));
    assert.ok(markdown.includes("Keep threshold:** 0.95"));
    assert.ok(markdown.includes("1 kept, 3 truncated, 7 dropped"));
    assert.ok(markdown.includes("-24%"));
    assert.ok(markdown.includes("re-reads"));
  });
});
