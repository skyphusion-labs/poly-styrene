import { describe, expect, it } from "vitest";
import { compareBundles, extractModule, normalise, report, tokens } from "../scripts/predeploy-check.mjs";

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

describe("extractModule", () => {
  // Shaped from what the API actually returned: multipart/form-data, 2 parts,
  // the module in the part named index.js. Measured, not assumed.
  const BOUNDARY = "f71f0e0dd82e5873e3eb46e6f29fcc305720ce61febd345ee57eac56aed7";

  function multipart(body: string, name = "index.js") {
    return [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="metadata"',
      "",
      '{"main_module":"index.js"}',
      `--${BOUNDARY}`,
      `Content-Disposition: form-data; name="${name}"; filename="${name}"`,
      "Content-Type: application/javascript+module",
      "",
      body,
      `--${BOUNDARY}--`,
      "",
    ].join("\r\n");
  }

  it("pulls the module out of a two-part response", () => {
    expect(extractModule(multipart("var x=1;"))).toBe("var x=1;");
  });

  it("passes a bare module through untouched, so it keeps working if the API stops wrapping", () => {
    expect(extractModule("var y=2;")).toBe("var y=2;");
  });

  // THE TRAP. Multipart puts \r\n before the next delimiter and that byte
  // belongs to the format. Keeping it produced a one-byte difference against a
  // locally built bundle, 47343 against 47344, on every run.
  it("removes the line ending the FORMAT added", () => {
    expect(extractModule(multipart("var x=1;"))).not.toMatch(/\r?\n$/);
  });

  // And the other half, which is a different bug: a bundle may legitimately
  // end in its own newline and eating that would be wrong.
  it("keeps a newline that belongs to the CONTENT", () => {
    expect(extractModule(multipart("var x=1;\n"))).toBe("var x=1;\n");
  });

  it("keeps newlines inside the content", () => {
    expect(extractModule(multipart("a();\nb();\nc();"))).toBe("a();\nb();\nc();");
  });

  // Falling through to compare a boundary header against a bundle would
  // produce confident nonsense, so this refuses and says what it saw.
  it("fails loudly and names the parts it found when the one asked for is absent", () => {
    expect(() => extractModule(multipart("var x=1;"), "main.js")).toThrow(/no part named "main\.js"/);
    expect(() => extractModule(multipart("var x=1;"), "main.js")).toThrow(/metadata, index\.js/);
  });

  it("can take a differently named part", () => {
    expect(extractModule(multipart("var z=3;", "worker.js"), "worker.js")).toBe("var z=3;");
  });

  // A one-byte trailing difference does not move a single token, which is part
  // of why tokens were the right comparison surface rather than bytes.
  it("leaves the token comparison unaffected by a trailing newline either way", () => {
    const withNewline = compareBundles("alpha beta\n", "alpha beta");
    expect(withNewline.safe).toBe(true);
    expect(withNewline.deployedOnly).toEqual([]);
    expect(withNewline.candidateOnly).toEqual([]);
  });

  it("end to end: a multipart response compares clean against the same module", () => {
    const module = 'JSON.stringify({content,allowed_mentions:{parse:[]}});\n';
    const result = compareBundles(extractModule(multipart(module)), module);
    expect(result.safe).toBe(true);
    expect(result.deployedOnly).toEqual([]);
  });
});
