import { describe, expect, it } from "vitest";
import { compareBundles, normalise, report, tokens } from "../scripts/predeploy-check.mjs";

// The defect this guards is poly-styrene#15: behaviour that exists only in an
// uncommitted tree is invisible to `git status`, to a diff against `main`, to
// the suite and to the deploy, because none of them has anything to compare
// against. The only thing that differs is the artifact already running.
//
// The granularity here was MEASURED against the real historical pair rather
// than chosen. See the PR for the numbers; the short version is that a quoted
// string comparison found ZERO deployed-only entries on the real incident,
// because `allowed_mentions` is an object KEY and keys are unquoted.

describe("tokens", () => {
  it("finds an object key, which is the shape the real defect took", () => {
    const bundle = 'body=JSON.stringify({content,allowed_mentions:{parse:[]}});';
    expect(tokens(bundle).has("allowed_mentions")).toBe(true);
  });

  // This is the measurement that chose the granularity, pinned so nobody
  // "simplifies" it back to matching quoted strings.
  it("would be defeated by only matching quoted strings", () => {
    const bundle = 'body=JSON.stringify({content,allowed_mentions:{parse:[]}});';
    const quotedOnly = bundle.match(/"[^"]*"/g) ?? [];
    expect(quotedOnly.join(" ")).not.toContain("allowed_mentions");
    expect(tokens(bundle).has("allowed_mentions")).toBe(true);
  });

  it("ignores runs shorter than three characters, which are minified locals", () => {
    const set = tokens("var a=1,bc=2,def=3;");
    expect(set.has("def")).toBe(true);
    expect(set.has("bc")).toBe(false);
    expect(set.has("a")).toBe(false);
  });

  it("keeps dollar and underscore names", () => {
    const set = tokens("const $foo=1, _bar=2;");
    expect(set.has("$foo")).toBe(true);
    expect(set.has("_bar")).toBe(true);
  });
});

describe("normalise", () => {
  it("strips the sourcemap comment, which differs between builds for no behavioural reason", () => {
    const withMap = "code();\n//# sourceMappingURL=index.js.map\n";
    expect(normalise(withMap)).not.toContain("sourceMappingURL");
    expect(normalise(withMap)).toContain("code()");
  });

  it("does not let a line ending difference register as a change", () => {
    expect(tokens("alpha\r\nbeta")).toEqual(tokens("alpha\nbeta"));
  });
});

describe("compareBundles", () => {
  const withFix = 'JSON.stringify({content,allowed_mentions:{parse:[]}});';
  const without = 'JSON.stringify({content});';

  // The actual incident direction.
  it("REFUSES when the deployed bundle has something the candidate lacks", () => {
    const r = compareBundles(withFix, without);
    expect(r.safe).toBe(false);
    expect(r.deployedOnly).toContain("allowed_mentions");
  });

  // The control. An instrument that always refuses is not an instrument.
  it("PERMITS the reverse, because adding behaviour is the normal case", () => {
    const r = compareBundles(without, withFix);
    expect(r.safe).toBe(true);
    expect(r.candidateOnly).toContain("allowed_mentions");
  });

  it("is silent on identical bundles", () => {
    const r = compareBundles(withFix, withFix);
    expect(r.safe).toBe(true);
    expect(r.deployedOnly).toEqual([]);
    expect(r.candidateOnly).toEqual([]);
  });

  it("reports both counts, so a zero cannot come from an empty read", () => {
    const r = compareBundles(withFix, without);
    expect(r.deployedCount).toBeGreaterThan(0);
    expect(r.candidateCount).toBeGreaterThan(0);
  });

  // A loss and an addition in the same deploy must still refuse: the addition
  // does not excuse the loss.
  it("refuses when something is both added and lost", () => {
    const r = compareBundles("keepThis andLoseThis", "keepThis andAddThis");
    expect(r.safe).toBe(false);
    expect(r.deployedOnly).toEqual(["andLoseThis"]);
    expect(r.candidateOnly).toEqual(["andAddThis"]);
  });
});

describe("report", () => {
  it("names the lost token and says it would be removed from the live Worker", () => {
    const text = report(compareBundles("alpha allowed_mentions", "alpha"));
    expect(text).toContain("REFUSING");
    expect(text).toContain("allowed_mentions");
    expect(text).toContain("live Worker");
  });

  it("says SAFE without naming anything as lost", () => {
    const text = report(compareBundles("alpha", "alpha beta"));
    expect(text).toContain("SAFE");
    expect(text).not.toContain("REFUSING");
  });
});
