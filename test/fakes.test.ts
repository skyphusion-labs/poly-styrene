import { describe, expect, it } from "vitest";
import { deferredGate } from "./fakes";

// deferredGate is test infrastructure, so nothing else asserts on it. Measured:
// removing its explicit release left the whole suite GREEN, because the
// backstop still resolved and the only cost was two seconds per test. That
// makes the release an ergonomic rather than a behaviour, and an ergonomic
// still needs a guard or it rots.
describe("deferredGate", () => {
  // The backstop is pushed far out so this fails on the RELEASE being broken
  // rather than on the backstop quietly covering for it.
  const FAR = 60_000;

  async function settledWithin(promise: Promise<unknown>, ms: number): Promise<string> {
    return Promise.race([
      promise.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), ms)),
    ]);
  }

  it("does not resolve on its own", async () => {
    const gate = deferredGate(FAR);
    expect(await settledWithin(gate.promise, 50)).toBe("still pending");
    gate.release();
  });

  // Races cleanly rather than hanging, because a timeout reports that the
  // suite is broken instead of naming the behaviour that changed.
  it("resolves when the test releases it, without waiting for the backstop", async () => {
    const gate = deferredGate(FAR);
    gate.release();
    expect(await settledWithin(gate.promise, 100)).toBe("settled");
  });

  it("is safe to release more than once", async () => {
    const gate = deferredGate(FAR);
    gate.release();
    gate.release();
    expect(await settledWithin(gate.promise, 100)).toBe("settled");
  });

  // The backstop is the half that turns a regression into a clean failure
  // rather than a hang, so it has to actually fire.
  it("resolves on the backstop even if the test never releases", async () => {
    const gate = deferredGate(20);
    expect(await settledWithin(gate.promise, 500)).toBe("settled");
  });
});
