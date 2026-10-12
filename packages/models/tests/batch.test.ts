import { describe, expect, it } from "vite-plus/test";
import { batchByBudget, mapLimited } from "../src/index.ts";
import { unwrap, unwrapErr } from "./helpers.ts";

const items = Array.from({ length: 10 }, (_, i) => i);
const cost = () => 50;

describe("batchByBudget", () => {
  it("puts everything in one batch when it fits", () => {
    expect(unwrap(batchByBudget(items, cost, { budget: 1000, maxItems: 100 }))).toEqual([items]);
  });

  it("splits by token budget and keeps the order", () => {
    const batches = unwrap(batchByBudget(items, cost, { budget: 120, maxItems: 100 }));
    expect(batches).toHaveLength(5);
    expect(batches.flat()).toEqual(items);
  });

  it("splits by item cap", () => {
    const batches = unwrap(batchByBudget(items, cost, { budget: 10_000, maxItems: 4 }));
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
  });

  it("returns a limit error when a single item does not fit", () => {
    expect(unwrapErr(batchByBudget(items, cost, { budget: 10, maxItems: 4 }))).toMatchObject({
      kind: "limit",
      message: expect.stringContaining("no room"),
    });
  });
});

describe("mapLimited", () => {
  it("keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimited(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(3);
  });
});
