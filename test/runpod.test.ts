import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt";
import {
  DEFAULT_EXEC_TIMEOUT_SEC,
  cancelRunpodJob,
  execTimeoutSec,
  giveUpMessage,
  interpretRunpod,
  ollamaChatBody,
  parseOllamaOutput,
  pollPlan,
  runpodUrl,
} from "../src/runpod";

describe("runpod", () => {
  it("builds an openai chat body for the ollama worker", () => {
    const body = ollamaChatBody("qwen2.5-coder:7b", "hi") as {
      input: { openai_route: string; openai_input: { model: string; stream: boolean; max_tokens: number; messages: { content: string }[] } };
    };
    expect(body.input.openai_route).toBe("/v1/chat/completions");
    expect(body.input.openai_input.model).toBe("qwen2.5-coder:7b");
    expect(body.input.openai_input.stream).toBe(false);
    expect(body.input.openai_input.max_tokens).toBe(800);
    expect(body.input.openai_input.messages[0]?.content).toBe(SYSTEM_PROMPT);
  });

  it("unwraps an aggregated stream and maps job status", () => {
    const answer = parseOllamaOutput({
      status: "COMPLETED",
      output: [{ choices: [{ message: { content: "first" } }] }, { choices: [{ message: { content: "last" } }] }],
    });
    expect(answer).toMatchObject({ kind: "text", text: "last" });
    expect(interpretRunpod({ status: "IN_QUEUE" })).toEqual({ state: "pending" });
    expect(interpretRunpod({ status: "in_progress" })).toEqual({ state: "pending" });
    expect(interpretRunpod({ status: "COMPLETED", output: { response: "done" } })).toMatchObject({
      state: "done",
      answer: { text: "done" },
    });
    const long = interpretRunpod({ status: "COMPLETED", output: { response: "z".repeat(8001) } });
    expect(long.state === "done" && long.answer.kind === "text" && long.answer.text.length).toBeLessThan(8100);
    const file = interpretRunpod({ status: "COMPLETED", output: { image: "aaaa", description: "pic" } });
    expect(file.state === "done" && file.answer.kind === "text" && file.answer.text).toBe("pic");
    expect(interpretRunpod({ status: "FAILED", error: "boom" })).toEqual({ state: "failed", error: "boom" });
    expect(interpretRunpod({ status: "TIMED_OUT" }).state).toBe("failed");
    expect(interpretRunpod(null)).toMatchObject({ state: "failed" });
    expect(interpretRunpod({ status: "WEIRD" })).toMatchObject({ state: "failed", error: "WEIRD" });
  });
});

describe("the poll budget is derived, not restated", () => {
  // The defect this closes: POLLS was 72 at a 10 second interval, so the loop
  // walked away after about 12 minutes while the endpoint was still allowed to
  // run. The two numbers had to agree and only one of them was in the repo.
  it("always outlasts the endpoint timeout, which is the whole point", () => {
    for (const timeout of [60, 300, 600, 900, 1200, 3600]) {
      const plan = pollPlan(timeout);
      expect(plan.budgetSec).toBeGreaterThan(timeout);
      expect(plan.polls * (plan.intervalMs / 1000)).toBeGreaterThanOrEqual(timeout);
    }
  });

  it("covers more wall time than the old loop with FEWER workflow steps", () => {
    const plan = pollPlan(DEFAULT_EXEC_TIMEOUT_SEC);
    expect(plan.budgetSec).toBeGreaterThan(720); // the old 72 x 10s
    expect(plan.polls).toBeLessThan(72);
  });

  it("derives the count from the interval rather than hardcoding it", () => {
    expect(pollPlan(600, 10, 0).polls).toBe(60);
    expect(pollPlan(600, 30, 0).polls).toBe(20);
    expect(pollPlan(100, 30, 0).polls).toBe(4); // rounds UP, never short
  });

  it("falls back and clamps rather than trusting the var", () => {
    expect(execTimeoutSec(undefined)).toBe(DEFAULT_EXEC_TIMEOUT_SEC);
    expect(execTimeoutSec("")).toBe(DEFAULT_EXEC_TIMEOUT_SEC);
    expect(execTimeoutSec("nonsense")).toBe(DEFAULT_EXEC_TIMEOUT_SEC);
    expect(execTimeoutSec("0")).toBe(DEFAULT_EXEC_TIMEOUT_SEC);
    expect(execTimeoutSec("-5")).toBe(DEFAULT_EXEC_TIMEOUT_SEC);
    expect(execTimeoutSec("600")).toBe(600);
    // A millisecond value pasted in by mistake must not buy a day of polling.
    expect(execTimeoutSec("900000")).toBe(3600);
  });
});

describe("an abandoned GPU job is cancelled", () => {
  function stubFetch(status: number, record?: { url: string; method: string; auth: string }[]) {
    const impl: typeof fetch = async (input, init) => {
      record?.push({
        url: String(input),
        method: init?.method ?? "",
        auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ""),
      });
      return new Response("{}", { status });
    };
    return impl;
  }

  it("calls the cancel route for the job, with the key as a bearer token", async () => {
    const calls: { url: string; method: string; auth: string }[] = [];
    const out = await cancelRunpodJob("ep1", "k1", "job1", stubFetch(200, calls));
    expect(out).toBe("cancelled");
    expect(calls[0]?.url).toBe("https://api.runpod.ai/v2/ep1/cancel/job1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.auth).toBe("Bearer k1");
  });

  it("treats a 404 as already finished rather than a failure", async () => {
    expect(await cancelRunpodJob("ep1", "k1", "job1", stubFetch(404))).toBe("already-finished");
  });

  it("reports failure on a bad status instead of throwing", async () => {
    expect(await cancelRunpodJob("ep1", "k1", "job1", stubFetch(500))).toBe("failed");
  });

  // It runs on paths that are already failing, so it must never replace the
  // original error with its own.
  it("never throws, even when fetch does", async () => {
    const boom: typeof fetch = async () => {
      throw new Error("network down");
    };
    await expect(cancelRunpodJob("ep1", "k1", "job1", boom)).resolves.toBe("failed");
  });

  it("refuses to call anything when it has nothing to cancel with", async () => {
    const calls: { url: string; method: string; auth: string }[] = [];
    expect(await cancelRunpodJob("", "k1", "job1", stubFetch(200, calls))).toBe("failed");
    expect(await cancelRunpodJob("ep1", "", "job1", stubFetch(200, calls))).toBe("failed");
    expect(await cancelRunpodJob("ep1", "k1", "", stubFetch(200, calls))).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("tells the user whether the job was actually stopped", () => {
    expect(giveUpMessage(960, "cancelled")).toContain("not still costing");
    expect(giveUpMessage(960, "already-finished")).toContain("not still costing");
    expect(giveUpMessage(960, "failed")).toContain("may still be running");
    expect(giveUpMessage(960, "cancelled")).toContain("16 minutes");
  });
});

describe("runpod urls", () => {
  it("builds every route off one base", () => {
    expect(runpodUrl("ep", "run")).toBe("https://api.runpod.ai/v2/ep/run");
    expect(runpodUrl("ep", "status/j1")).toBe("https://api.runpod.ai/v2/ep/status/j1");
    expect(runpodUrl("ep", "cancel/j1")).toBe("https://api.runpod.ai/v2/ep/cancel/j1");
  });

  it("refuses an empty endpoint rather than building a wrong url", () => {
    expect(() => runpodUrl("", "run")).toThrow();
  });
});
