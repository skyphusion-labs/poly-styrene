import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  decodeLabRequest,
  encodeLabResult,
  LAB_INACTIVITY_MS,
  LAB_RUN_MS,
  labArgv,
  labExecEnv,
  labStartOptions,
  type LabRun,
} from "./lab";

/**
 * The /lab sandbox.
 *
 * This file imports "cloudflare:workers", so no test can import it (see
 * CLAUDE.md). It therefore holds platform calls and nothing decidable: the
 * argv, the environment, the start options and both sides of the wire format
 * all come from `src/lab.ts`, which is covered.
 *
 * One sandbox per person. The caller derives the name from the authenticated
 * invoker, and a Durable Object serialises its own requests, so a second run
 * by the same person waits instead of starting a second container.
 */
export class LabContainer extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // An inactivity timeout does not survive a Durable Object restart, and a
    // restarted object starts without one. Re-arming here matters because the
    // timeout is the backstop that reaps a container when the Workflow dies.
    // Failing to re-arm fails SAFE: with no timeout the platform stops the
    // container shortly after this object goes inactive, which is sooner.
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          await container.setInactivityTimeout(LAB_INACTIVITY_MS);
        } catch {
          console.log(JSON.stringify({ event: "lab_timeout_rearm_failed" }));
        }
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "bad request" }, { status: 400 });
    }
    const parsed = decodeLabRequest(body);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const run = await this.runOnce(labArgv(parsed.lang, parsed.code));
    return new Response(encodeLabResult(run), {
      headers: { "content-type": "application/json" },
    });
  }

  private async runOnce(argv: string[]): Promise<LabRun> {
    const container = this.ctx.container;
    // ctx.container is optional on the type, so a missing binding is a
    // configuration error rather than a crash at the first property access.
    if (!container) throw new Error("No container is configured for this Durable Object");

    if (!container.running) {
      // Under the `default` scheduling policy the image and the instance
      // class come from wrangler.jsonc. The ONLY thing passed here is
      // containment. start() is synchronous and returns before the container
      // is ready; exec() below waits for a container that is still starting,
      // so there is nothing to poll.
      container.start(labStartOptions());
      try {
        await container.setInactivityTimeout(LAB_INACTIVITY_MS);
      } catch {
        // Throws synchronously below zero and REJECTS above six hours, so both
        // arms land here. Fails safe: no timeout means the platform stops the
        // container sooner, not later.
        console.log(JSON.stringify({ event: "lab_timeout_set_failed" }));
      }
    }

    // Deliberately no container.monitor(). Under this compatibility date a
    // pending monitor() keeps the Durable Object in memory for up to fifteen
    // minutes, which would hold the container past its inactivity timeout and
    // bill for it. Failure is observed through the exit code instead.
    const proc = await container.exec(argv, {
      env: labExecEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), LAB_RUN_MS);
    });

    try {
      // output() may be called only once and buffers both streams. It also
      // waits for any child the command left behind, which is precisely why
      // this is a race: a backgrounded process would otherwise hang the run.
      const finished = proc.output().then((out) => ({
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
        exitCode: out.exitCode,
        timedOut: false,
      }));

      const winner = await Promise.race([finished, expired]);
      if (winner !== "expired") return winner;

      // Taking the instance away is the only bound that holds. kill() reaches
      // just the process exec() started and not its children, and calling it
      // after a process has already exited raises an uncaught internal error
      // in the Durable Object, so this code never calls it at all.
      console.log(JSON.stringify({ event: "lab_timeout", ms: LAB_RUN_MS }));
      await container.destroy("lab run exceeded the time bound");
      return { stdout: "", stderr: "", exitCode: null, timedOut: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // There is deliberately NO explicit teardown on a successful run. The
  // inactivity timeout above is the platform-enforced path and it is five
  // minutes, which costs well under a cent on this instance class, and it
  // leaves the sandbox warm so a researcher can iterate on a file across two
  // runs. Adding a destroy call here would buy a fraction of a cent and one
  // more branch in the file that no test can reach. The timeout branch above
  // destroys, because there a runaway is the thing being stopped.
}
