import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  asLabLang,
  decodeLabRequest,
  decodeLabResult,
  encodeLabRequest,
  encodeLabResult,
  formatLabRun,
  LAB_DAILY_RUNS,
  LAB_INSTANCE,
  LAB_MAX_CODE,
  LAB_MAX_INSTANCES,
  LAB_MAX_OUTPUT,
  LAB_RUN_MS,
  LAB_INACTIVITY_MS,
  labArgv,
  labGate,
  labQuota,
  labSandboxName,
  labExecEnv,
  labStartOptions,
  parseLab,
  parseRoleIds,
  quotaWindowStart,
  retentionCutoff,
} from "../src/lab";

describe("lab containment", () => {
  // This is the load-bearing guard in the whole file. enableInternet: false is
  // the containment story for /lab, and turning it on is what would let
  // researcher code reach third parties from our account. Flipping it has to
  // break a test.
  it("starts the container with the internet OFF", () => {
    expect(labStartOptions().enableInternet).toBe(false);
  });

  it("passes no secret into the sandbox", () => {
    // Every process in a container can read the whole environment, so a
    // credential here would be readable by researcher code. There is none,
    // and the container never needs one: it has no network.
    const passed = Object.keys(labExecEnv()).sort();
    expect(passed).toEqual(["HOME", "LAB", "TERM"]);
    expect(Object.values(labExecEnv()).join(" ")).not.toMatch(/token|key|secret/i);
  });

  // Under the `default` scheduling policy the image and the instance class
  // come from wrangler.jsonc, not from start(), so the constants in lab.ts
  // are a MIRROR of config and can silently disagree with it. This reads the
  // real file.
  it("agrees with wrangler.jsonc on the instance class and the instance cap", () => {
    const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
      containers?: { class_name?: string; instance_type?: string; max_instances?: number }[];
      durable_objects?: { bindings?: { name?: string; class_name?: string }[] };
      exports?: Record<string, { type?: string; storage?: string }>;
      migrations?: unknown;
    };
    const lab = (config.containers ?? []).find((entry) => entry.class_name === "LabContainer");
    expect(lab, "wrangler.jsonc has no LabContainer container").toBeTruthy();
    expect(lab?.instance_type).toBe(LAB_INSTANCE);
    expect(lab?.max_instances).toBe(LAB_MAX_INSTANCES);

    // A container needs all three of these, and exports is mutually
    // exclusive with migrations.
    expect((config.durable_objects?.bindings ?? []).some((b) => b.class_name === "LabContainer")).toBe(true);
    expect(config.exports?.LabContainer?.storage).toBe("sqlite");
    expect(config.migrations).toBeUndefined();
  });

  // max_instances is the only ceiling that survives our own code being
  // wrong, and it exists ONLY under the default scheduling policy.
  it("does not select the durable_object scheduling policy, which would forfeit max_instances", () => {
    const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(raw).not.toContain("durable_object\"");
    expect(raw).not.toMatch(/scheduling_policy["\s:]+["\s]*durable_object/);
  });

  // The inactivity timeout is the backstop for a dead Workflow, so it has to
  // outlive a legitimate run and still be short. Both halves matter: equal
  // values would race, and a long timeout bills for nothing.
  it("keeps the run bound inside the inactivity backstop", () => {
    expect(LAB_RUN_MS).toBeLessThan(LAB_INACTIVITY_MS);
    expect(LAB_INACTIVITY_MS).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });
});

describe("lab gate", () => {
  it("denies when no role is configured, rather than allowing", () => {
    const verdict = labGate({ inGuild: true, roles: ["1"], allowedRoleIds: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("not configured");
  });

  it("denies in a DM", () => {
    expect(labGate({ inGuild: false, roles: ["7"], allowedRoleIds: ["7"] }).ok).toBe(false);
  });

  it("denies a member with no roles and a member with the wrong role", () => {
    expect(labGate({ inGuild: true, roles: [], allowedRoleIds: ["7"] }).ok).toBe(false);
    expect(labGate({ inGuild: true, roles: ["8", "9"], allowedRoleIds: ["7"] }).ok).toBe(false);
  });

  it("allows a member holding any allowed role", () => {
    expect(labGate({ inGuild: true, roles: ["9", "7"], allowedRoleIds: ["7", "8"] }).ok).toBe(true);
  });

  it("parses the allowlist and drops anything that is not an id", () => {
    expect(parseRoleIds("7, 8 ,7,,notanid,9x,10")).toEqual(["7", "8", "10"]);
    expect(parseRoleIds(undefined)).toEqual([]);
    expect(parseRoleIds("")).toEqual([]);
    expect(parseRoleIds("   ")).toEqual([]);
  });
});

describe("lab parsing", () => {
  it("refuses empty and oversized code", () => {
    expect(parseLab("sh", "   ").ok).toBe(false);
    const big = parseLab("sh", "x".repeat(LAB_MAX_CODE + 1));
    expect(big.ok).toBe(false);
    expect(big.ok === false && big.error).toContain(String(LAB_MAX_CODE));
  });

  it("defaults to sh and refuses an unknown language", () => {
    const parsed = parseLab("", "echo hi");
    expect(parsed.ok && parsed.lang).toBe("sh");
    expect(parseLab("ruby", "puts 1").ok).toBe(false);
    expect(asLabLang("python")).toBe("python");
    expect(asLabLang("perl")).toBeNull();
  });

  it("normalises line endings and trims", () => {
    const parsed = parseLab("sh", "  echo a\r\necho b  ");
    expect(parsed.ok && parsed.code).toBe("echo a\necho b");
  });

  it("carries the code as one argv element for every language", () => {
    const code = "print('it is \"quoted\" and\nmultiline')";
    for (const lang of ["sh", "python", "node"] as const) {
      const argv = labArgv(lang, code);
      expect(argv[argv.length - 1]).toBe(code);
      expect(argv.length).toBeGreaterThanOrEqual(3);
    }
    expect(labArgv("python", "x")[0]).toBe("python3");
    expect(labArgv("node", "x")[0]).toBe("node");
    expect(labArgv("sh", "x")[0]).toBe("/bin/sh");
  });
});

describe("lab quota", () => {
  it("allows under the limit and refuses at it", () => {
    expect(labQuota(0).ok).toBe(true);
    expect(labQuota(LAB_DAILY_RUNS - 1).ok).toBe(true);
    expect(labQuota(LAB_DAILY_RUNS).ok).toBe(false);
    expect(labQuota(LAB_DAILY_RUNS + 5).ok).toBe(false);
  });

  // countLabRuns returns -1 when it cannot read, and that must refuse rather
  // than read as "no usage so far".
  it("refuses an unreadable count instead of treating it as zero", () => {
    expect(labQuota(-1).ok).toBe(false);
    expect(labQuota(Number.NaN).ok).toBe(false);
  });

  it("derives a 24 hour window and a 30 day retention cutoff", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    expect(quotaWindowStart(now)).toBe("2026-10-22T12:00:00.000Z");
    expect(retentionCutoff(now)).toBe("2026-09-23T12:00:00.000Z");
  });
});

describe("lab sandbox naming", () => {
  // The name comes from the authenticated invoker and nothing else, which is
  // what keeps one researcher out of another one's sandbox.
  it("derives the name from the user id", () => {
    expect(labSandboxName("12345")).toBe("lab-12345");
  });

  it("throws rather than naming a sandbox from anything that is not a user id", () => {
    expect(() => labSandboxName("")).toThrow();
    expect(() => labSandboxName("../other")).toThrow();
    expect(() => labSandboxName("lab-1 OR 1=1")).toThrow();
  });
});

describe("lab output", () => {
  it("reports the exit code and both streams", () => {
    const text = formatLabRun({ stdout: "out here", stderr: "err here", exitCode: 0, timedOut: false });
    expect(text).toContain("exit 0");
    expect(text).toContain("out here");
    expect(text).toContain("err here");
  });

  it("says so when a run was killed on the time bound", () => {
    const text = formatLabRun({ stdout: "", stderr: "", exitCode: null, timedOut: true });
    expect(text).toContain("destroyed");
    expect(text).toContain("120s");
  });

  it("says No output rather than printing empty fences", () => {
    const text = formatLabRun({ stdout: "  ", stderr: "", exitCode: 0, timedOut: false });
    expect(text).toContain("No output.");
    expect(text).not.toContain("```");
  });

  // Container output is attacker controlled. A fence in it would close my
  // fence and let the rest render as markdown in the channel.
  it("neuters a code fence in the output so it cannot break out", () => {
    const text = formatLabRun({ stdout: "a\n```\n# heading", stderr: "", exitCode: 0, timedOut: false });
    expect(text).not.toContain("\n```\n# heading");
    expect(text).toContain("` ` `");
  });

  it("caps each stream", () => {
    const text = formatLabRun({ stdout: "x".repeat(LAB_MAX_OUTPUT + 500), stderr: "", exitCode: 0, timedOut: false });
    expect(text).toContain("cut to fit Discord");
    expect(text.length).toBeLessThan(LAB_MAX_OUTPUT + 400);
  });
});

describe("lab wire contract", () => {
  // Both ends of this live in lab.ts precisely so they are covered: the
  // Durable Object and the Workflow that use them cannot be imported by a
  // test at all.
  it("round trips a request", () => {
    const encoded = encodeLabRequest("python", "print(1)");
    const decoded = decodeLabRequest(JSON.parse(encoded));
    expect(decoded.ok && decoded.lang).toBe("python");
    expect(decoded.ok && decoded.code).toBe("print(1)");
  });

  it("refuses a request that is not shaped right", () => {
    expect(decodeLabRequest(null).ok).toBe(false);
    expect(decodeLabRequest("nope").ok).toBe(false);
    expect(decodeLabRequest({ lang: "sh", code: "x" }).ok).toBe(false);
    expect(decodeLabRequest({ v: 2, lang: "sh", code: "x" }).ok).toBe(false);
    expect(decodeLabRequest({ v: 1, lang: "sh" }).ok).toBe(false);
    expect(decodeLabRequest({ v: 1, lang: 7, code: "x" }).ok).toBe(false);
  });

  it("applies the same validation on the way in as the command did", () => {
    expect(decodeLabRequest({ v: 1, lang: "ruby", code: "x" }).ok).toBe(false);
    expect(decodeLabRequest({ v: 1, lang: "sh", code: "   " }).ok).toBe(false);
    expect(decodeLabRequest({ v: 1, lang: "sh", code: "x".repeat(LAB_MAX_CODE + 1) }).ok).toBe(false);
  });

  it("round trips a result, including a null exit code", () => {
    const run = { stdout: "a", stderr: "b", exitCode: 0, timedOut: false };
    expect(decodeLabResult(JSON.parse(encodeLabResult(run)))).toEqual(run);
    const killed = { stdout: "", stderr: "", exitCode: null, timedOut: true };
    expect(decodeLabResult(JSON.parse(encodeLabResult(killed)))).toEqual(killed);
  });

  // A garbled reply must not render as a run that succeeded with no output,
  // so this returns null and the Workflow reports the sandbox as lost.
  it("returns null for a garbled result rather than a partial run", () => {
    expect(decodeLabResult(null)).toBeNull();
    expect(decodeLabResult({ v: 1, stdout: "a", stderr: "b", timedOut: false })).toBeNull();
    expect(decodeLabResult({ v: 1, stdout: "a", stderr: "b", exitCode: "0", timedOut: false })).toBeNull();
    expect(decodeLabResult({ v: 1, stdout: "a", stderr: "b", exitCode: 0 })).toBeNull();
    expect(decodeLabResult({ v: 2, stdout: "a", stderr: "b", exitCode: 0, timedOut: false })).toBeNull();
  });
});
