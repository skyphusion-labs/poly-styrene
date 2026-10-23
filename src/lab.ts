// Pure logic for the /lab sandbox command. Nothing here imports
// "cloudflare:workers", so all of it is reachable from the node vitest pool.
// The Durable Object and the Workflow that USE this are not testable at all
// (see CLAUDE.md), so anything decidable belongs in this file rather than in
// those.

export type LabLang = "sh" | "python" | "node";

/** The instance class. `basic` is 1/4 vCPU, 1 GiB memory, 4 GB disk. */
export const LAB_INSTANCE = "basic";

/**
 * Mirrors `max_instances` in wrangler.jsonc. It is NOT enforced from here;
 * the platform enforces it, and only under the `default` scheduling policy.
 * Kept as a constant so the user-facing message and the config agree.
 */
export const LAB_MAX_INSTANCES = 2;

/**
 * How long a single run may take before the container is destroyed.
 * `exec()` has no built-in timeout and killing a process does not kill its
 * children, so the only real bound is taking the instance away.
 */
export const LAB_RUN_MS = 120_000;

/**
 * The inactivity timeout set on the container after start.
 * This is the BACKSTOP, not the primary bound: if the Workflow dies, the
 * Durable Object goes inactive and the platform stops the instance. Work
 * running inside the container does not count as activity, so a runaway
 * process cannot keep itself alive. Keep this short, and never add a Durable
 * Object alarm that checks on the work, because that is exactly what would
 * defeat the guarantee.
 */
export const LAB_INACTIVITY_MS = 300_000;

export const LAB_MAX_CODE = 4000;
export const LAB_MAX_OUTPUT = 6000;

/** Runs per person per rolling day. */
export const LAB_DAILY_RUNS = 20;

export const LAB_RETENTION_DAYS = 30;

/**
 * The start options for the lab container.
 *
 * `enableInternet: false` is the whole containment story and the reason this
 * is a function with a test rather than an inline object literal: the test
 * asserts the flag is off, so flipping it has to go through a failing test.
 * With internet off, no public resolver answers DNS from inside the
 * container.
 *
 * There is deliberately no outbound handler. An `outbound` or `outboundByHost`
 * handler runs in the Workers runtime with access to `env`, which means every
 * binding this Worker holds (DB, CATALOG, AI) plus its secrets. Adding one is
 * how the sandbox would reach our own infrastructure, so v1 does not have one.
 *
 * The image and the instance class are NOT set here. Under the `default`
 * scheduling policy they come from wrangler.jsonc, and `LAB_INSTANCE` below
 * only mirrors that config so the user-facing text and the deployed size
 * agree. `test/lab.test.ts` reads wrangler.jsonc and fails if they drift.
 *
 * UNVERIFIED, and it is the one thing in this design I could not measure:
 * that `enableInternet: false` is honoured when passed on the `default`
 * policy. The docs make options optional there and require the flag whenever
 * options are passed, but every rendered example of the flag uses the
 * `durable_object` policy. Egress MUST be confirmed dead from inside a
 * deployed container before any role is added to LAB_ROLE_IDS. Until a role
 * is set, `labGate` denies everyone, so shipping this is safe and opening it
 * is the step that needs the measurement.
 */
export function labStartOptions(): { enableInternet: false } {
  return { enableInternet: false };
}

/**
 * The environment for an exec, which is NOT the environment passed to
 * `start()`.
 *
 * Variables set on `start()` do not reach a process started by `exec()`,
 * except for PATH, so putting them on `start()` would look right and do
 * nothing. Nothing here is a secret: a container holds no credential of ours,
 * and anything placed here would be readable by every process in the sandbox.
 */
export function labExecEnv(): Record<string, string> {
  return { LAB: "1", HOME: "/home/lab", TERM: "dumb" };
}

/**
 * Parse the configured role allowlist.
 *
 * Returns the ids in order with blanks and duplicates removed. An unset or
 * blank value yields an EMPTY list, and `labGate` denies on an empty list, so
 * a missing configuration fails closed rather than open.
 */
export function parseRoleIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id || !/^[0-9]{1,24}$/.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export type GateVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether an invoker may use /lab.
 *
 * Closed by default in every direction: no configured roles, no guild, or no
 * matching role all deny. The caller has already proved the request came from
 * Discord by verifying the Ed25519 signature; this decides WHO it was.
 */
export function labGate(args: {
  inGuild: boolean;
  roles: string[];
  allowedRoleIds: string[];
}): GateVerdict {
  if (args.allowedRoleIds.length === 0) {
    return { ok: false, reason: "The lab is not configured on this bot yet." };
  }
  if (!args.inGuild) {
    return { ok: false, reason: "The lab only runs in a server channel, not in a DM." };
  }
  if (args.roles.length === 0) {
    return { ok: false, reason: "The lab is limited to a role you do not have." };
  }
  const hit = args.roles.some((role) => args.allowedRoleIds.includes(role));
  if (!hit) return { ok: false, reason: "The lab is limited to a role you do not have." };
  return { ok: true };
}

export type ParsedLab =
  | { ok: true; lang: LabLang; code: string }
  | { ok: false; error: string };

export function asLabLang(raw: string): LabLang | null {
  if (raw === "sh" || raw === "python" || raw === "node") return raw;
  return null;
}

/** Validate the submitted code and language. */
export function parseLab(rawLang: string, rawCode: string): ParsedLab {
  const code = rawCode.replace(/\r\n/g, "\n").trim();
  if (!code) return { ok: false, error: "Give me something to run." };
  if (code.length > LAB_MAX_CODE) {
    return { ok: false, error: `That is ${code.length} characters. The limit is ${LAB_MAX_CODE}.` };
  }
  const lang = asLabLang(rawLang || "sh");
  if (!lang) return { ok: false, error: "Language must be sh, python, or node." };
  return { ok: true, lang, code };
}

/**
 * Build the argv for a run.
 *
 * The code travels as a single argv element rather than interpolated into a
 * shell string. Arbitrary execution is the POINT of this command, so this is
 * not an injection defence; it is so that quotes and newlines in a researcher
 * script survive intact instead of breaking the command.
 */
export function labArgv(lang: LabLang, code: string): string[] {
  if (lang === "python") return ["python3", "-I", "-c", code];
  if (lang === "node") return ["node", "-e", code];
  return ["/bin/sh", "-c", code];
}

export type QuotaVerdict = { ok: true } | { ok: false; reason: string };

export function labQuota(runsInWindow: number, limit = LAB_DAILY_RUNS): QuotaVerdict {
  if (!Number.isFinite(runsInWindow) || runsInWindow < 0) {
    return { ok: false, reason: "I could not read your recent lab usage." };
  }
  if (runsInWindow >= limit) {
    return { ok: false, reason: `You have used ${runsInWindow} of ${limit} lab runs today. Try again tomorrow.` };
  }
  return { ok: true };
}

/** The ISO timestamp marking the start of the rolling quota window. */
export function quotaWindowStart(now: number): string {
  return new Date(now - 24 * 60 * 60 * 1000).toISOString();
}

/** The ISO timestamp before which journal rows may be pruned. */
export function retentionCutoff(now: number, days = LAB_RETENTION_DAYS): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The Durable Object name for one person's sandbox.
 *
 * Derived from the authenticated invoker, which is what keeps one researcher
 * out of another one's sandbox: a Durable Object serialises its own requests,
 * so a person gets one sandbox and a second /lab waits rather than adding an
 * instance. Never derive this from anything the caller supplies.
 */
export function labSandboxName(userId: string): string {
  if (!/^[0-9]{1,24}$/.test(userId)) throw new Error("bad user id");
  return `lab-${userId}`;
}

export type LabRun = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

/**
 * Render a finished run for Discord.
 *
 * Caps before chunking, because container output is buffered in Durable
 * Object memory and an unbounded read is a memory problem before it is a
 * Discord problem.
 */
export function formatLabRun(run: LabRun): string {
  const head = run.timedOut
    ? `Lab run stopped after ${Math.round(LAB_RUN_MS / 1000)}s and the sandbox was destroyed.`
    : `Lab run finished, exit ${run.exitCode ?? "unknown"}.`;
  const parts: string[] = [head];
  const out = clipStream(run.stdout);
  const err = clipStream(run.stderr);
  if (out) parts.push("stdout\n```\n" + out + "\n```");
  if (err) parts.push("stderr\n```\n" + err + "\n```");
  if (!out && !err) parts.push("No output.");
  return parts.join("\n");
}

function clipStream(value: string): string {
  const clean = (value ?? "").replace(/\r\n/g, "\n").replace(/```/g, "` ` `").trim();
  if (clean.length <= LAB_MAX_OUTPUT) return clean;
  return clean.slice(0, LAB_MAX_OUTPUT) + "\n(cut to fit Discord)";
}

// The wire contract between the Workflow and the sandbox Durable Object.
//
// The Durable Object and the Workflow both import "cloudflare:workers" and so
// cannot be imported by a test at all. Keeping the encode and the decode here
// means the shape they agree on IS covered, and the untestable files are left
// holding only platform calls.

export function encodeLabRequest(lang: LabLang, code: string): string {
  return JSON.stringify({ v: 1, lang, code });
}

export function decodeLabRequest(raw: unknown): ParsedLab {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Bad lab request." };
  const row = raw as { v?: unknown; lang?: unknown; code?: unknown };
  if (row.v !== 1) return { ok: false, error: "Bad lab request version." };
  if (typeof row.lang !== "string" || typeof row.code !== "string") {
    return { ok: false, error: "Bad lab request." };
  }
  return parseLab(row.lang, row.code);
}

export function encodeLabResult(run: LabRun): string {
  return JSON.stringify({
    v: 1,
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
  });
}

/**
 * Read a result back.
 *
 * Returns null rather than a partial run on anything unexpected, so a garbled
 * reply is reported as a lost sandbox instead of being rendered as a run that
 * succeeded with no output.
 */
export function decodeLabResult(raw: unknown): LabRun | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { v?: unknown; stdout?: unknown; stderr?: unknown; exitCode?: unknown; timedOut?: unknown };
  if (row.v !== 1) return null;
  if (typeof row.stdout !== "string" || typeof row.stderr !== "string") return null;
  if (typeof row.timedOut !== "boolean") return null;
  const exitCode = row.exitCode === null || typeof row.exitCode === "number" ? row.exitCode : undefined;
  if (exitCode === undefined) return null;
  return { stdout: row.stdout, stderr: row.stderr, exitCode, timedOut: row.timedOut };
}
