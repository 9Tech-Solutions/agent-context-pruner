import { describe, expect, it } from "vite-plus/test";
import {
  collectToolCalls,
  compact,
  fitState,
  INSTRUCTIONS_NOTE,
  STATE_CONTEXT,
  type ScoreRequest,
} from "../src/index.ts";
import { fakeModel, transcript, unwrap } from "./fixtures.ts";

const fit = { maxStateTokens: 25_000, preserveRecentMessages: 0, goal: "fix the test" };

describe("compaction instructions", () => {
  it("adds the person's instructions to the state, with a line saying what they are", () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const { state } = unwrap(
      fitState(messages, calls, { ...fit, instructions: "  keep src/b.ts  " }),
    );
    expect(Object.keys(state)).toEqual(["context", "goal", "instructions", "history"]);
    expect(state.instructions).toBe("keep src/b.ts");
    expect(state.context).toBe(`${STATE_CONTEXT} ${INSTRUCTIONS_NOTE}`);
  });

  it("leaves the state exactly as before when there are none", () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const plain = unwrap(fitState(messages, calls, fit));
    const blank = unwrap(fitState(messages, calls, { ...fit, instructions: "   " }));
    expect(Object.keys(plain.state)).toEqual(["context", "goal", "history"]);
    expect(blank).toEqual(plain);
  });

  it("hands the instructions to the model with the state", async () => {
    const seen: ScoreRequest[] = [];
    const model = fakeModel(() => ({ keepCall: 1, keepResult: 1 }), seen);
    unwrap(
      await compact(transcript(), model, { preserveRecentMessages: 1, instructions: "keep b.ts" }),
    );
    expect(seen[0]?.instructions).toBe("keep b.ts");
    expect(seen[0]?.state?.instructions).toBe("keep b.ts");
    const none: ScoreRequest[] = [];
    unwrap(
      await compact(
        transcript(),
        fakeModel(() => ({ keepCall: 1, keepResult: 1 }), none),
        {
          preserveRecentMessages: 1,
        },
      ),
    );
    expect(none[0]?.instructions).toBe("");
  });
});
