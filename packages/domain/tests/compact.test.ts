import { describe, expect, it } from "vite-plus/test";
import {
  compact,
  err,
  reductionRatio,
  type DecisionModel,
  type ScoreRequest,
} from "../src/index.ts";
import { fakeModel, message, transcript, unwrap, unwrapErr } from "./fixtures.ts";

describe("compact", () => {
  it("drops what the model lets go and keeps text verbatim", async () => {
    const seen: ScoreRequest[] = [];
    const model = fakeModel(() => ({ keepCall: 0.9, keepResult: 0.1 }), seen);
    const output = unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.candidates.map((c) => c.id)).toEqual(["t1", "t2", "t3"]);
    expect(seen[0]?.calls).toHaveLength(3);
    expect(seen[0]?.state?.goal).toContain("go ahead");
    expect(output.decisions.map((d) => d.action)).toEqual([
      "drop_result",
      "drop_result",
      "drop_result",
    ]);
    expect(output.stats).toMatchObject({
      model: "fake",
      resultsDropped: 3,
      kept: 0,
      requests: 1,
      stateStage: "full",
    });
    expect(reductionRatio(output)).toBeGreaterThan(0);
    expect(output.messages.filter((m) => m.text).map((m) => m.text)).toEqual(
      transcript()
        .filter((m) => m.text)
        .map((m) => m.text),
    );
  });

  it("never asks about pinned calls", async () => {
    const seen: ScoreRequest[] = [];
    const model = fakeModel(() => ({ keepCall: 0, keepResult: 0 }), seen);
    const output = unwrap(await compact(transcript(), model, { preserveRecentMessages: 9 }));
    expect(seen).toHaveLength(0);
    expect(output.decisions.every((d) => d.reason === "pinned")).toBe(true);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: "", pinned: 3 });
  });

  it("keeps everything without asking when there is no tool call", async () => {
    const seen: ScoreRequest[] = [];
    const messages = [message("user", "hello"), message("assistant", "hi")];
    const output = unwrap(
      await compact(
        messages,
        fakeModel(() => ({ keepCall: 0, keepResult: 0 }), seen),
      ),
    );
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: "", calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it("reports no reduction when the model wants everything kept", async () => {
    const output = unwrap(
      await compact(
        transcript(),
        fakeModel(() => ({ keepCall: 0.95, keepResult: 0.95 })),
        { preserveRecentMessages: 1 },
      ),
    );
    expect(output.decisions.every((d) => d.action === "keep")).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it("uses the model's calibrated threshold unless the caller overrides it", async () => {
    const strict = fakeModel(() => ({ keepCall: 0.9, keepResult: 0.6 }), [], {
      defaultKeepThreshold: 0.7,
    });
    const byModel = unwrap(await compact(transcript(), strict, { preserveRecentMessages: 1 }));
    expect(byModel.decisions.map((d) => d.action)).toEqual([
      "drop_result",
      "drop_result",
      "drop_result",
    ]);
    const byCaller = unwrap(
      await compact(transcript(), strict, { preserveRecentMessages: 1, keepThreshold: 0.5 }),
    );
    expect(byCaller.decisions.map((d) => d.action)).toEqual(["keep", "keep", "keep"]);
  });

  it("sends no state to models that do not read one", async () => {
    const seen: ScoreRequest[] = [];
    const model = fakeModel(() => ({ keepCall: 1, keepResult: 1 }), seen, { state: "none" });
    const output = unwrap(await compact(transcript(), model, { preserveRecentMessages: 1 }));
    expect(seen[0]?.state).toBeNull();
    expect(output.stats.stateStage).toBe("");
  });

  it("rejects missing and out-of-range scores", async () => {
    const missing: DecisionModel = { ...fakeModel(() => ({ keepCall: 1, keepResult: 1 })) };
    const partial: DecisionModel = {
      ...missing,
      score: async (request) => ({
        ok: true,
        value: {
          scores: new Map([[request.candidates[0]!.id, { keepCall: 1, keepResult: 1 }]]),
          requests: 1,
        },
      }),
    };
    expect(
      unwrapErr(await compact(transcript(), partial, { preserveRecentMessages: 1 })).kind,
    ).toBe("invalid_score");
    const outOfRange = fakeModel(() => ({ keepCall: 1.5, keepResult: Number.NaN }));
    const error = unwrapErr(await compact(transcript(), outOfRange, { preserveRecentMessages: 1 }));
    expect(error).toMatchObject({ kind: "invalid_score", message: expect.stringContaining("t1") });
  });

  it("returns model failures as errors, including adapters that throw", async () => {
    const failing: DecisionModel = {
      ...fakeModel(() => ({ keepCall: 1, keepResult: 1 })),
      score: async () => err({ kind: "http", message: "request failed (500)" }),
    };
    expect(
      unwrapErr(await compact(transcript(), failing, { preserveRecentMessages: 1 })),
    ).toMatchObject({
      kind: "model_failed",
      cause: { kind: "http" },
    });
    const throwing: DecisionModel = {
      ...failing,
      score: async () => {
        throw new Error("boom");
      },
    };
    expect(
      unwrapErr(await compact(transcript(), throwing, { preserveRecentMessages: 1 })),
    ).toMatchObject({
      kind: "model_failed",
      cause: { kind: "unexpected", message: "boom" },
    });
  });

  it("returns state_too_large when the history cannot be fitted", async () => {
    const model = fakeModel(() => ({ keepCall: 1, keepResult: 1 }), [], { maxStateTokens: 10 });
    expect(unwrapErr(await compact(transcript(), model, { preserveRecentMessages: 1 })).kind).toBe(
      "state_too_large",
    );
  });
});
