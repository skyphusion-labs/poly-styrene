// Compare the bundle that is DEPLOYED against the bundle you are about to
// deploy, and refuse if the deployed one contains behaviour the candidate
// lacks.
//
// WHY THIS READING AND NOT ANOTHER. On 2026-10-23 deploying `main` removed
// `allowed_mentions: { parse: [] }` from the live Worker for about twenty
// minutes, and every local instrument said fine: `git status` clean, the diff
// against `main` clean, the suite green, the deploy quiet. They all agreed
// because the content being lost had never been COMMITTED, so there was
// nothing for any of them to compare against. Adding another status check or
// another local diff inherits that blindness exactly.
//
// The only thing that differed was the ARTIFACT THAT WAS ALREADY RUNNING,
// because it had been built from the uncommitted tree. So that is what this
// compares, and it has to run BEFORE the deploy: afterwards the deployed
// bundle and the ref match by construction and nothing can fire.
//
// GRANULARITY WAS MEASURED, NOT CHOSEN. Against the real historical pair
// (ac5320a, which has the fix, versus its parent d20f2ee, which does not):
//
//   string literals only ->  0 deployed-only.  WOULD NOT HAVE FIRED.
//   word-like tokens     ->  1 deployed-only: `allowed_mentions`. Zero noise.
//
// `allowed_mentions` is an object KEY, and object keys are unquoted in the
// source and survive into the bundle unmangled, so a quoted-string comparison
// cannot see it. Tokens are the surface that both carries the signal and
// survives minification, which mangles local identifiers but not property
// names.

/** Strip things that differ between builds without differing in behaviour. */
export function normalise(text) {
  return text
    .replace(/^\/\/#\s*sourceMappingURL=.*$/gm, "")
    .replace(/\r\n/g, "\n");
}

/**
 * Word-like tokens of three characters or more.
 *
 * Three is deliberate: shorter runs are dominated by minified local names,
 * which change between builds for no behavioural reason and would bury the
 * signal in noise.
 */
export function tokens(text) {
  const found = normalise(text).match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g);
  return new Set(found ?? []);
}

/**
 * What the deployed bundle has that the candidate does not.
 *
 * `candidateOnly` is reported but is NOT a failure: adding behaviour is the
 * normal case. Only losing it is the defect this exists for.
 */
export function compareBundles(deployedText, candidateText) {
  const deployed = tokens(deployedText);
  const candidate = tokens(candidateText);
  const deployedOnly = [...deployed].filter((t) => !candidate.has(t)).sort();
  const candidateOnly = [...candidate].filter((t) => !deployed.has(t)).sort();
  return {
    deployedOnly,
    candidateOnly,
    deployedCount: deployed.size,
    candidateCount: candidate.size,
    safe: deployedOnly.length === 0,
  };
}

/** The operator-facing report. Returns the text; the caller decides the exit. */
export function report(result) {
  const lines = [];
  lines.push(`deployed tokens ${result.deployedCount}, candidate tokens ${result.candidateCount}`);
  if (result.candidateOnly.length > 0) {
    lines.push(`ADDED by this deploy (${result.candidateOnly.length}), which is normal:`);
    for (const t of result.candidateOnly.slice(0, 40)) lines.push(`  + ${t}`);
    if (result.candidateOnly.length > 40) lines.push(`  ... ${result.candidateOnly.length - 40} more`);
  }
  if (result.safe) {
    lines.push("SAFE: the deployed bundle contains nothing the candidate lacks.");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`REFUSING: the DEPLOYED bundle contains ${result.deployedOnly.length} token(s) the candidate does NOT.`);
  lines.push("Deploying would remove them from the live Worker. Each one is behaviour that exists");
  lines.push("only in whatever tree the current deployment was built from, and in no committed ref.");
  lines.push("");
  for (const t of result.deployedOnly.slice(0, 40)) lines.push(`  - ${t}`);
  if (result.deployedOnly.length > 40) lines.push(`  ... ${result.deployedOnly.length - 40} more`);
  lines.push("");
  lines.push("Commit that behaviour, or establish deliberately that it should go, before deploying.");
  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------
// Deliberately takes two FILES rather than fetching the deployed script
// itself. The download is one operator step whose output can be eyeballed,
// and keeping it outside means every line of logic above is reachable by a
// test. See CLAUDE.md for the sequence.

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (isMain) {
  const [deployedPath, candidatePath] = process.argv.slice(2);
  if (!deployedPath || !candidatePath) {
    console.error("usage: node scripts/predeploy-check.mjs <deployed-bundle> <candidate-bundle>");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const result = compareBundles(readFileSync(deployedPath, "utf8"), readFileSync(candidatePath, "utf8"));
  console.log(report(result));
  process.exit(result.safe ? 0 : 1);
}
