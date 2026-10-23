// A stopwatch for attributing wall time across awaits.
//
// Why this works in Workers, which is the part that is easy to get wrong:
// the runtime FREEZES the clock while your code runs and advances it only
// when I/O completes. So a Date.now() delta across an await measures that
// await's I/O and reports 0 for pure computation, which is exactly the
// question being asked of a handler that spent 10.7 seconds of wall time
// against 4 ms of CPU.
//
// The clock is injectable so this is testable without sleeping.

export type Splits = Record<string, number>;

export type Stopwatch = {
  /** Record the time since the previous mark under `name`. */
  mark(name: string): void;
  /** The splits so far, plus `total`. */
  splits(): Splits;
};

export function stopwatch(now: () => number = Date.now): Stopwatch {
  const started = now();
  let last = started;
  const splits: Splits = {};
  return {
    mark(name: string): void {
      const at = now();
      // A repeated name accumulates rather than overwriting, so marking
      // inside a loop reports the total spent there instead of the last pass.
      splits[name] = (splits[name] ?? 0) + (at - last);
      last = at;
    },
    splits(): Splits {
      // io_total, not total: this is the SUM OF MEASURED I/O and it will not
      // match a wall-clock figure from a tail, because compute between the
      // marks is invisible to a frozen clock. Naming it total invites exactly
      // that comparison.
      return { ...splits, io_total: last - started };
    },
  };
}
