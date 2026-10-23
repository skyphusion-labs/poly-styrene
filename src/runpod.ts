import { extractAnswer, type Answer } from "./infer";
import { SYSTEM_PROMPT } from "./prompt";

export function ollamaChatBody(model: string, prompt: string): unknown {
  return {
    input: {
      openai_route: "/v1/chat/completions",
      openai_input: {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        stream: false,
        max_tokens: 800,
      },
    },
  };
}

export type JobView =
  | { state: "pending" }
  | { state: "done"; answer: Answer }
  | { state: "failed"; error: string };

// return_aggregate_stream on the Ollama worker wraps one yielded object in an array.
export function parseOllamaOutput(output: unknown): Answer {
  let value = output;
  if (value && typeof value === "object" && "status" in value && "output" in value) {
    value = (value as { output: unknown }).output;
  }
  if (Array.isArray(value)) {
    const objects = value.filter((item) => item && typeof item === "object");
    value = objects.length > 0 ? objects[objects.length - 1] : value[value.length - 1];
  }
  return extractAnswer(value, "Text Generation");
}

export function interpretRunpod(payload: unknown): JobView {
  if (!payload || typeof payload !== "object") return { state: "failed", error: "Empty GPU status." };
  const row = payload as { status?: unknown; output?: unknown; error?: unknown };
  const status = typeof row.status === "string" ? row.status.toUpperCase() : "";
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") return { state: "pending" };
  if (status === "COMPLETED") {
    const answer = parseOllamaOutput(row.output);
    if (answer.kind === "file") {
      return { state: "done", answer: { kind: "text", text: answer.caption || "The GPU returned a file." } };
    }
    if (answer.kind === "text" && answer.text.length > 8000) {
      return {
        state: "done",
        answer: { kind: "text", text: answer.text.slice(0, 8000) + "\n\n(I cut this short to fit Discord.)" },
      };
    }
    return { state: "done", answer };
  }
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") {
    const error = typeof row.error === "string" && row.error ? row.error : status.toLowerCase();
    return { state: "failed", error };
  }
  return { state: "failed", error: status || "Unknown GPU status." };
}

// ---------------------------------------------------------------------------
// Job lifecycle: the URLs, the poll budget, and cancelling an abandoned job.
//
// All of it lives here rather than in workflow.ts because workflow.ts imports
// "cloudflare:workers" and no test can import it. The Workflow is left holding
// step orchestration and nothing decidable.
// ---------------------------------------------------------------------------

const RUNPOD_BASE = "https://api.runpod.ai/v2";

export function runpodUrl(endpoint: string, path: string): string {
  if (!endpoint) throw new Error("missing RunPod endpoint id");
  return `${RUNPOD_BASE}/${endpoint}/${path}`;
}

/**
 * The RunPod endpoint's own execution timeout, in seconds.
 *
 * THIS NUMBER LIVES ON RUNPOD, not here, and that was the defect: the poll
 * budget and the endpoint timeout are two numbers that have to agree, and only
 * one of them was in version control, with nothing comparing them. Recording it
 * here makes the disagreement visible and lets the budget be DERIVED from it
 * instead of restated beside it.
 *
 * It is overridable through the RUNPOD_EXEC_TIMEOUT_SEC var so the real value
 * can be set without a code change. The default is what we believe the endpoint
 * is configured to and has NOT been confirmed against RunPod; confirm it and
 * set the var.
 */
export const DEFAULT_EXEC_TIMEOUT_SEC = 900;

/** Seconds between polls. Coarser than it was, which costs fewer Workflow steps. */
export const POLL_INTERVAL_SEC = 15;

/** Extra seconds polled BEYOND the endpoint timeout, so we observe its own
 * verdict instead of walking away first. This is the sign of the inequality
 * that was wrong before: the budget must EXCEED the endpoint timeout. */
export const POLL_MARGIN_SEC = 60;

export function execTimeoutSec(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXEC_TIMEOUT_SEC;
  // A pasted millisecond value or a typo should not produce a day of polling.
  if (parsed > 3600) return 3600;
  return Math.floor(parsed);
}

export type PollPlan = { polls: number; intervalMs: number; budgetSec: number };

/**
 * How long to watch, derived from how long the endpoint may run.
 *
 * The budget deliberately outlasts the endpoint timeout, so a job that the
 * endpoint itself kills is SEEN as failed rather than abandoned as pending.
 */
export function pollPlan(
  execTimeout: number = DEFAULT_EXEC_TIMEOUT_SEC,
  intervalSec: number = POLL_INTERVAL_SEC,
  marginSec: number = POLL_MARGIN_SEC,
): PollPlan {
  const budgetSec = execTimeout + marginSec;
  return {
    polls: Math.ceil(budgetSec / intervalSec),
    intervalMs: intervalSec * 1000,
    budgetSec,
  };
}

export type CancelOutcome = "cancelled" | "already-finished" | "failed";

/**
 * Stop paying for a job nobody is going to read.
 *
 * Best effort by construction: it reports rather than throws, because it runs
 * on paths that are already failing and must not replace the original error
 * with its own. The key is never logged.
 */
export async function cancelRunpodJob(
  endpoint: string,
  key: string,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelOutcome> {
  if (!endpoint || !key || !jobId) return "failed";
  try {
    const response = await fetchImpl(runpodUrl(endpoint, `cancel/${jobId}`), {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.ok) return "cancelled";
    // The job already reached a terminal state, so there is nothing to stop
    // and nothing is still billing. Not a failure.
    if (response.status === 404) return "already-finished";
    return "failed";
  } catch {
    return "failed";
  }
}

/** What the user is told when the budget runs out. */
export function giveUpMessage(budgetSec: number, outcome: CancelOutcome): string {
  const minutes = Math.round(budgetSec / 60);
  const tail =
    outcome === "failed"
      ? "I could not confirm the GPU job was cancelled, so it may still be running."
      : "The GPU job has been cancelled, so it is not still costing anything.";
  return `The GPU did not finish within about ${minutes} minutes. ${tail} Try again, or pin a Workers AI model with /model.`;
}
