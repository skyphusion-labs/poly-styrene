import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AskParams, Env } from "./env";
import { buildWorkersInput, extractAnswer, runCloudflare } from "./infer";
import { publishAnswer, postDiscordMessage } from "./discord_rest";
import {
  cancelRunpodJob,
  execTimeoutSec,
  giveUpMessage,
  interpretRunpod,
  ollamaChatBody,
  pollPlan,
  runpodUrl,
  type CancelOutcome,
} from "./runpod";
import { base64ToBytes, chunkDiscord, formatReply } from "./text";

const STEP_RETRY = {
  retries: { limit: 3, delay: "2 seconds" as const, backoff: "constant" as const },
  timeout: "1 minute" as const,
};

type InferState = { posted: boolean; text: string };

function safe(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 300);
}

async function loadAttachment(params: AskParams): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  if (!params.attachmentUrl) return undefined;
  const response = await fetch(params.attachmentUrl);
  if (!response.ok) throw new Error(`file fetch failed: ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mime: params.attachmentType || "application/octet-stream",
  };
}

export class AskWorkflow extends WorkflowEntrypoint<Env, AskParams> {
  async run(event: Readonly<WorkflowEvent<AskParams>>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    if (!params?.prompt || !params.applicationId || !params.interactionToken || !params.modelId) return;
    try {
      if (params.provider === "ollama") await this.runOllama(params, step);
      else await this.runWorkers(params, step);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      await this.reportFailure(step, params, message);
    }
  }

  private async publishText(step: WorkflowStep, name: string, params: AskParams, text: string): Promise<void> {
    const chunks = chunkDiscord(text);
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i] ?? "";
      const followup = i > 0;
      await step.do(`${name} ${i}`, STEP_RETRY, async () => {
        await postDiscordMessage({
          applicationId: params.applicationId,
          interactionToken: params.interactionToken,
          content,
          followup,
        });
        return { ok: true };
      });
    }
  }

  private async reportFailure(step: WorkflowStep, params: AskParams, message: string): Promise<void> {
    const text = `Poly Styrene failed. ${safe(message)}`;
    try {
      await step.do(
        "report failure",
        { retries: { limit: 2, delay: "2 seconds" as const }, timeout: "30 seconds" as const },
        async () => {
        console.log(JSON.stringify({ event: "ask_failed", provider: params.provider, model: params.modelId, task: params.task }));
        await publishAnswer({
          applicationId: params.applicationId,
          interactionToken: params.interactionToken,
          text,
        });
        return { ok: true };
      });
    } catch {
      console.log(JSON.stringify({ event: "ask_report_failed", provider: params.provider, model: params.modelId, task: params.task }));
    }
  }

  private async runWorkers(params: AskParams, step: WorkflowStep): Promise<void> {
    // The file bytes stay inside this step. A step return over 1 MiB is dropped,
    // and a separate download step would bill the model twice if the call then failed.
    const outcome = await step.do(
      "infer",
      { retries: { limit: 0, delay: "1 second" as const }, timeout: "3 minutes" as const },
      async (): Promise<InferState> => {
        console.log(JSON.stringify({ event: "ask_infer", provider: "cloudflare", model: params.modelId, task: params.task }));
        const file = await loadAttachment(params);
        const built = buildWorkersInput({
          task: params.task,
          prompt: params.prompt,
          sourceLang: params.sourceLang,
          targetLang: params.targetLang,
          file,
        });
        if (!built.ok) return { posted: false, text: built.error };
        const raw = await runCloudflare(this.env.AI, params.modelId, built.input, this.env.GATEWAY_ID);
        const answer = extractAnswer(raw, params.task);
        if (answer.kind === "file") {
          await publishAnswer({
            applicationId: params.applicationId,
            interactionToken: params.interactionToken,
            text: formatReply(params.modelId, answer.caption),
            files: [{ filename: answer.filename, mime: answer.mime, bytes: base64ToBytes(answer.base64) }],
          });
          return { posted: true, text: "" };
        }
        return { posted: false, text: answer.text.slice(0, 20000) };
      },
    );
    if (!outcome.posted) await this.publishText(step, "reply", params, formatReply(params.modelId, outcome.text));
  }

  private async runOllama(params: AskParams, step: WorkflowStep): Promise<void> {
    const endpoint = this.env.RUNPOD_ENDPOINT_ID;
    const key = this.env.RUNPOD_API_KEY ?? "";
    if (!endpoint || !key) throw new Error("Ollama is not configured.");
    const job = await step.do(
      "submit",
      { retries: { limit: 0, delay: "1 second" as const }, timeout: "30 seconds" as const },
      async () => {
      console.log(JSON.stringify({ event: "ask_infer", provider: "ollama", model: params.modelId, task: params.task }));
      const response = await fetch(runpodUrl(endpoint, "run"), {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(ollamaChatBody(params.modelId, params.prompt)),
      });
      if (!response.ok) throw new Error(`GPU submit failed: ${response.status}`);
      const body = (await response.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id) throw new Error("GPU submit returned no job id.");
      return { id: body.id };
    });

    try {
      await this.publishText(
        step,
        "notice",
        params,
        `Poly Styrene is waiting on the GPU for \`${params.modelId}\`. A cold start can take a few minutes.`,
      );
    } catch {
      console.log(JSON.stringify({ event: "ask_notice_failed", provider: "ollama", model: params.modelId, task: params.task }));
    }

    // The budget is DERIVED from the endpoint timeout rather than restated
    // beside it, and it deliberately outlasts it, so a job the endpoint itself
    // kills is observed as failed instead of abandoned as pending.
    const plan = pollPlan(execTimeoutSec(this.env.RUNPOD_EXEC_TIMEOUT_SEC));

    try {
      for (let i = 0; i < plan.polls; i++) {
        const view = await step.do(
          `poll ${i}`,
          { retries: { limit: 3, delay: "2 seconds" as const }, timeout: "30 seconds" as const },
          async () => {
          const response = await fetch(runpodUrl(endpoint, `status/${job.id}`), {
            headers: { authorization: `Bearer ${key}` },
          });
          if (!response.ok) throw new Error(`GPU status failed: ${response.status}`);
          return interpretRunpod(await response.json());
        });
        // Reaching a terminal state means the job stopped on its own. There is
        // nothing to cancel and nothing still billing.
        if (view.state === "done") {
          const text = view.answer.kind === "error" ? view.answer.text : view.answer.kind === "text" ? view.answer.text : "Done.";
          await this.publishText(step, `done ${i}`, params, formatReply(params.modelId, text));
          return;
        }
        if (view.state === "failed") {
          await this.publishText(step, `gpu fail ${i}`, params, `Poly Styrene, \`${params.modelId}\`\nGPU failed. ${safe(view.error)}`);
          return;
        }
        await step.sleep(`wait ${i}`, plan.intervalMs);
      }

      // Budget exhausted while the job is still live. Cancel BEFORE telling the
      // user, so what we tell them about the cost is true.
      const outcome = await this.cancelJob(step, endpoint, key, job.id, "budget");
      await this.publishText(step, "gpu timeout", params, giveUpMessage(plan.budgetSec, outcome));
    } catch (err) {
      // Any other abandonment: a status step that exhausted its retries, a
      // publish that failed, the Workflow being torn down. The job is still
      // running and nobody is going to read it.
      await this.cancelJob(step, endpoint, key, job.id, "error");
      throw err;
    }
  }

  /**
   * Stop paying for a job nobody will read. Best effort in both directions: it
   * never throws, because it runs on paths that are already failing and must
   * not replace the original error with its own.
   */
  private async cancelJob(
    step: WorkflowStep,
    endpoint: string,
    key: string,
    jobId: string,
    why: "budget" | "error",
  ): Promise<CancelOutcome> {
    try {
      return await step.do(
        `cancel ${why}`,
        { retries: { limit: 2, delay: "2 seconds" as const }, timeout: "30 seconds" as const },
        async () => {
          const outcome = await cancelRunpodJob(endpoint, key, jobId);
          console.log(JSON.stringify({ event: "gpu_cancel", why, outcome }));
          return outcome;
        },
      );
    } catch {
      console.log(JSON.stringify({ event: "gpu_cancel_failed", why }));
      return "failed";
    }
  }
}
