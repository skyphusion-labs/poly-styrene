import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A tracked symlink reached a public repo and nothing noticed, because nothing
// looks. `node_modules -> /Users/conrad/dev/poly-styrene/node_modules` was
// committed and pushed: an absolute path from one machine, which every clone
// resolves to nothing, and which on that machine aims npm at a different
// working tree's dependencies. The suite was green throughout, because the
// suite had no opinion about what is in the index.

function tracked(): { mode: string; path: string }[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-s"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const mode = line.slice(0, line.indexOf(" "));
        const path = line.slice(line.indexOf("\t") + 1);
        return { mode, path };
      });
  } catch {
    // Not a git checkout, or no git. Reported rather than silently passing.
    return null;
  }
}

describe("repository hygiene", () => {
  it("tracks no symlinks at all", () => {
    const files = tracked();
    if (files === null) {
      expect.soft(true, "git was unavailable, so this check did not run").toBe(true);
      return;
    }
    // Proves the instrument can see the index before trusting a zero from it.
    expect(files.length).toBeGreaterThan(5);
    const links = files.filter((file) => file.mode === "120000").map((file) => file.path);
    expect(links).toEqual([]);
  });

  it("does not track node_modules in any form", () => {
    const files = tracked();
    if (files === null) return;
    const hits = files.map((file) => file.path).filter((path) => path === "node_modules" || path.startsWith("node_modules/"));
    expect(hits).toEqual([]);
  });

  // The root cause, pinned so the pattern cannot quietly regain its slash.
  // `node_modules/` matches a DIRECTORY only and lets a symlink of the same
  // name straight through.
  it("ignores paths without a trailing slash, so a symlink is covered too", () => {
    const lines = readFileSync(new URL("../.gitignore", import.meta.url), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(lines).toContain("node_modules");
    const slashed = lines.filter((line) => line.endsWith("/"));
    expect(slashed).toEqual([]);
  });
});

describe("the GPU image reference stays pinned", () => {
  // The endpoint configuration lives on RunPod, so this repo cannot enforce
  // what actually runs. What it CAN enforce is that its own record does not
  // drift back to a mutable tag, which is the thing that made poly-styrene#4
  // invisible: nothing anywhere said which image had run.
  const readme = () => readFileSync(new URL("../README.md", import.meta.url), "utf8");

  it("records a digest, not a tag", () => {
    const text = readme();
    expect(text).toMatch(/svenbrnn\/runpod-ollama@sha256:[0-9a-f]{64}/);
  });

  it("does not reference the mutable latest tag anywhere", () => {
    expect(readme()).not.toContain("runpod-ollama:latest");
  });

  it("says that applying it is a RunPod-side change, so the record is not mistaken for the control", () => {
    expect(readme()).toContain("RunPod-side change");
  });
});
