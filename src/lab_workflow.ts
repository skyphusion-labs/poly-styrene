import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, LabParams } from "./env";
import { publishAnswer, postDiscordMessage } from "./discord_rest";
import { chunkDiscord } from "./text";
import {
  decodeLabResult,
  encodeLabRequest,
  formatLabRun,
  labSandboxName,
  LAB_INSTANCE,
} from "./lab";
import { closeLabSession, openLabSession } from "./lab_journal";

/**
 * The /lab Workflow.
 *
 * Imports "cloudflare:workers", so no test can import it (see CLAUDE.md). It
 * holds orchestration only; the rendering, the wire format and the sandbox
 * name all come from `src/lab.ts`.
 */
const PUBLISH_RETRY = {
  retries: { limit: 3, delay: "2 seconds" as const, backoff: "constant" as const },
  timeout: "1 minute" as const,
};

const JOURNAL_RETRY = {
  retries: { limit: 3, delay: "2 seconds" as const, backoff: "constant" as const },
  timeout: "30 seconds" as const,
};

/**
 * The run step takes NO retries on purpose.
 *
 * A retry would execute the researcher's code a second time and bill a second
 * container for it. The timeout is longer than the in-container run bound so
 * that a sandbox the Durable Object is still queueing has room to finish; if
 * this step does time out, the container is left to the inactivity timeout,
 * which is the designed backstop rather than a leak.
 */
const RUN_STEP = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "4 minutes" as const,
};

function safe(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 300);
}

export class LabWorkflow extends WorkflowEntrypoint<Env, LabParams> {
  async run(event: Readonly<WorkflowEvent<LabParams>>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    if (!params?.code || !params.applicationId || !params.interactionToken || !params.sessionId) return;

    await step.do("journal open", JOURNAL_RETRY, async () => {
      await openLabSession(this.env.DB, {
        id: params.sessionId,
        userId: params.userId,
        guildId: params.guildId,
        channelId: params.channelId,
        instance: LAB_INSTANCE,
        startedAt: new Date().toISOString(),
      });
      return { ok: true };
    });

    try {
      const result = await step.do("run", RUN_STEP, async () => {
        console.log(JSON.stringify({ event: "lab_run", lang: params.lang, instance: LAB_INSTANCE }));
        const stub = this.env.LAB.get(this.env.LAB.idFromName(labSandboxName(params.userId)));
        const response = await stub.fetch("https://lab.invalid/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeLabRequest(params.lang, params.code),
        });
        if (!response.ok) throw new Error(`sandbox returned ${response.status}`);
        const run = decodeLabResult(await response.json());
        // A garbled reply is reported as lost rather than rendered as a run
        // that succeeded with no output.
        if (!run) throw new Error("sandbox returned an unreadable result");
        return run;
      });

      await this.publish(step, params, formatLabRun(result));
      await this.close(step, params, result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.log(JSON.stringify({ event: "lab_failed", lang: params.lang }));
      await this.close(step, params, "lost");
      try {
        await step.do("report failure", JOURNAL_RETRY, async () => {
          await publishAnswer({
            applicationId: params.applicationId,
            interactionToken: params.interactionToken,
            text: `The lab did not finish. ${safe(message)}`,
          });
          return { ok: true };
        });
      } catch {
        console.log(JSON.stringify({ event: "lab_report_failed", lang: params.lang }));
      }
    }
  }

  private async publish(step: WorkflowStep, params: LabParams, text: string): Promise<void> {
    const chunks = chunkDiscord(text);
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i] ?? "";
      const followup = i > 0;
      await step.do(`reply ${i}`, PUBLISH_RETRY, async () => {
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

  private async close(step: WorkflowStep, params: LabParams, exit: "ok" | "failed" | "timeout" | "lost"): Promise<void> {
    try {
      await step.do(`journal close ${exit}`, JOURNAL_RETRY, async () => {
        await closeLabSession(this.env.DB, params.sessionId, new Date().toISOString(), exit);
        return { ok: true };
      });
    } catch {
      // The row stays open. countLabRuns counts an open row, so the quota
      // still holds the person to it; this loses the exit reason, not the fact.
      console.log(JSON.stringify({ event: "lab_journal_close_failed", exit }));
    }
  }
}
