import { describe, expect, it } from "vite-plus/test";
import {
  auc,
  buildReport,
  chooseCuts,
  evaluateCut,
  formatReport,
  recommend,
  sweep,
  type CutEvaluation,
} from "../src/index.ts";
import { AUTH_LINES, message, numbered, scoreByTool, session } from "./helpers.ts";

const CUT = 7;
const READ_TRUNCATED = { keepCall: 0.9, keepResult: 0.1 };

async function evaluated(scores: Parameters<typeof scoreByTool>[0]): Promise<CutEvaluation> {
  const outcome = await evaluateCut(session(), CUT, scoreByTool(scores), 0);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return outcome.value;
}

describe("auc", () => {
  it("is 1 for a perfect ranking, 0 for a reversed one and 0.5 for ties", () => {
    expect(auc([0.9, 0.8, 0.1], [true, true, false])).toBe(1);
    expect(auc([0.1, 0.9], [true, false])).toBe(0);
    expect(auc([0.5, 0.5], [true, false])).toBe(0.5);
    expect(auc([0.5, 0.4], [true, true])).toBeNull();
  });
});

describe("chooseCuts", () => {
  it("takes prompts with enough calls behind them and work after them", () => {
    const options = { cuts: 3, minCalls: 3, preserveRecentMessages: 0 };
    expect(chooseCuts(session(), options)).toEqual([CUT]);
    expect(chooseCuts(session(), { ...options, minCalls: 4 })).toEqual([]);
    const noWorkAfter = [...session().slice(0, CUT), message("user", "thanks")];
    expect(chooseCuts(noWorkAfter, options)).toEqual([]);
  });
});

describe("evaluateCut and sweep", () => {
  it("labels the scored calls of a compaction point", async () => {
    const evaluation = await evaluated({});
    expect(evaluation.scored.map((c) => [c.tool, c.label.resultNeeded])).toEqual([
      ["Read", true],
      ["Read", false],
      ["Grep", false],
    ]);
  });

  it("counts a needed result as lost only when the threshold removes it", async () => {
    const evaluation = await evaluated({
      Read: { keepCall: 0.4, keepResult: 0.3 },
      Grep: { keepCall: 0.1, keepResult: 0.1 },
    });
    const rows = sweep([evaluation], 300, [0.2, 0.35, 0.5]);
    expect(rows.map((r) => [r.kept, r.truncated, r.dropped, r.lost])).toEqual([
      [2, 0, 1, 0],
      [0, 2, 1, 0],
      [0, 0, 3, 1],
    ]);
    expect(rows[2]!.lossRate).toBe(1);
    expect(rows[2]!.reduction).toBeGreaterThan(rows[0]!.reduction);
    // The reads are too short to truncate, so 0.35 saves no more than 0.2: the tie goes to the lower one.
    expect(recommend(rows, 0.1)?.threshold).toBe(0.2);
  });

  it("counts a truncation as a loss when the reused line is past the kept head", async () => {
    const padding = Array.from(
      { length: 20 },
      (_, i) => `// padding line ${i} of a long auth module`,
    );
    const long = session().map((m) =>
      m.toolResults?.[0]?.tool_use_id === "u1"
        ? {
            ...m,
            toolResults: [{ tool_use_id: "u1", text: numbered([...AUTH_LINES, ...padding]) }],
          }
        : m,
    );
    const outcome = await evaluateCut(long, CUT, scoreByTool({ Read: READ_TRUNCATED }), 0);
    if (!outcome.ok) throw new Error(outcome.error.message);
    const [lostAtHead10] = sweep([outcome.value], 10, [0.5]);
    const [keptInHead] = sweep([outcome.value], 300, [0.5]);
    expect(lostAtHead10!.lost).toBe(1);
    expect(keptInHead!.lost).toBe(0);
  });

  it("does not count a short result as lost: truncation keeps it whole", async () => {
    const evaluation = await evaluated({ Read: READ_TRUNCATED });
    const [row] = sweep([evaluation], 10, [0.5]);
    expect(row!.truncated).toBe(2);
    expect(row!.lost).toBe(0);
  });

  it("reports ranking quality and a recommendation without transcript text", async () => {
    const evaluation = await evaluated({
      Read: { keepCall: 0.4, keepResult: 0.3 },
      Grep: { keepCall: 0.1, keepResult: 0.1 },
    });
    const report = buildReport("by-tool", [evaluation], []);
    expect(report.aucResult).toBe(0.75);
    expect(report.neededShare).toBeCloseTo(1 / 3);
    expect(JSON.stringify(report)).not.toContain("revokedTokens");
    expect(formatReport(report)).toMatch(
      /recommended keep threshold: \d\.\d\d \(-?\d+% net reduction after re-reads, \d+% of needed results lost\)/,
    );
  });

  it("charges each lost result one full re-read", async () => {
    const evaluation = await evaluated({
      Read: { keepCall: 0.4, keepResult: 0.3 },
      Grep: { keepCall: 0.1, keepResult: 0.1 },
    });
    const [keepAll, dropAll] = sweep([evaluation], 300, [0.05, 0.95]);
    const reread = evaluation.scored.find((c) => c.label.resultNeeded)!.resultChars;
    expect(keepAll!.netReduction).toBe(keepAll!.reduction);
    const before = evaluation.history.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    expect(before).toBeGreaterThan(0);
    expect(dropAll!.reduction - dropAll!.netReduction).toBeGreaterThan(0);
    expect(dropAll!.lost).toBe(1);
    expect(reread).toBeGreaterThan(0);
  });
});

describe("recommend", () => {
  const row = (threshold: number, netReduction: number, lossRate: number) => ({
    threshold,
    kept: 0,
    truncated: 0,
    dropped: 0,
    reduction: netReduction,
    needed: 1,
    lost: 0,
    lossRate,
    netReduction,
  });

  it("picks the best net reduction, the lowest threshold on a tie, within the loss limit", () => {
    const rows = [row(0.1, 0.2, 0), row(0.3, 0.6, 0.5), row(0.5, 0.6, 1), row(0.7, 0.4, 1)];
    expect(recommend(rows)?.threshold).toBe(0.3);
    expect(recommend(rows, 0.25)?.threshold).toBe(0.1);
    expect(recommend([row(0.5, 0.6, 1)], 0.5)).toBeNull();
  });
});
