import { describe, expect, it } from "vitest";
import { stopwatch } from "../src/timing";

function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("stopwatch", () => {
  it("attributes the gap between marks, not the absolute time", () => {
    // construction at 1000, then marks read 1100, 1150, 4150
    const watch = stopwatch(fakeClock([1000, 1100, 1150, 4150]));
    watch.mark("catalog");
    watch.mark("pin");
    watch.mark("create");
    expect(watch.splits()).toEqual({ catalog: 100, pin: 50, create: 3000, io_total: 3150 });
  });

  it("accumulates a repeated name instead of overwriting it", () => {
    const watch = stopwatch(fakeClock([0, 10, 25, 30]));
    watch.mark("poll");
    watch.mark("poll");
    watch.mark("done");
    expect(watch.splits()).toEqual({ poll: 25, done: 5, io_total: 30 });
  });

  it("reports zero for work that does no io, which is what Workers clock freezing looks like", () => {
    const watch = stopwatch(fakeClock([500, 500, 500]));
    watch.mark("pure");
    watch.mark("alsoPure");
    expect(watch.splits()).toEqual({ pure: 0, alsoPure: 0, io_total: 0 });
  });

  it("returns a copy, so a caller cannot mutate the splits", () => {
    const watch = stopwatch(fakeClock([0, 5]));
    watch.mark("one");
    const first = watch.splits();
    first.one = 999;
    expect(watch.splits().one).toBe(5);
  });
});
