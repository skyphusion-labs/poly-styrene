// Egress probe for poly-styrene#8. NEVER MERGE THIS BRANCH.
//
// The question is whether `enableInternet: false` is honoured when passed on
// the `default` scheduling policy. That is a PLATFORM question, so it does not
// need /lab opened to anyone: this worker drives the REAL LabContainer with the
// REAL labStartOptions() and the REAL image, which is what makes the answer
// transfer to /lab instead of merely being about some container.
//
// One probe per request, selected by ?probe=, so each result is independently
// visible and no single request has to wait on five timeouts.
import { decodeLabResult, encodeLabRequest, type LabLang } from "../src/lab";

export { LabContainer } from "../src/lab_container";

type ProbeEnv = { LAB: DurableObjectNamespace };

type Probe = {
  lang: LabLang;
  code: string;
  /** What containment predicts. */
  expect: "SUCCEED" | "FAIL";
  why: string;
};

/** Retries reserved for a container application that is still rolling out. */
const PROVISION_ATTEMPTS = 6;
const PROVISION_WAIT_MS = 5000;
const PROVISION_PENDING = /no container instance|not running|try again later/i;

const PROBES: Record<string, Probe> = {
  // THE POSITIVE CONTROL. Without this, a sandbox that is broken in some
  // unrelated way reads exactly like a sandbox that is correctly contained.
  control: {
    lang: "python",
    code: "print(1 + 1)",
    expect: "SUCCEED",
    why: "proves the sandbox executes at all, so a failure below means containment and not breakage",
  },
  dns: {
    lang: "python",
    code: "import socket\nprint('RESOLVED', socket.gethostbyname('example.com'))",
    expect: "FAIL",
    why: "with internet off, no public resolver answers DNS from inside",
  },
  tcp443: {
    lang: "python",
    code: "import socket\ns = socket.socket()\ns.settimeout(5)\ns.connect(('1.1.1.1', 443))\nprint('CONNECTED')",
    expect: "FAIL",
    why: "raw IP on 443, so it does not depend on DNS being blocked",
  },
  tcp80: {
    lang: "python",
    code: "import socket\ns = socket.socket()\ns.settimeout(5)\ns.connect(('8.8.8.8', 80))\nprint('CONNECTED')",
    expect: "FAIL",
    why: "raw IP on 80, the port a host denylist would cover and an open internet would not",
  },
  // The one that matters most. While enableInternet is true, ports other than
  // 80 and 443 bypass host filtering entirely, so this is the probe that
  // separates "internet is off" from "hosts are filtered".
  tcp53: {
    lang: "python",
    code: "import socket\ns = socket.socket()\ns.settimeout(5)\ns.connect(('8.8.8.8', 53))\nprint('CONNECTED')",
    expect: "FAIL",
    why: "neither 80 nor 443, which is the gap a denylist leaves open",
  },
};

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("probe") ?? "";
    const probe = PROBES[name];
    if (!probe) {
      return Response.json({ ok: false, stage: "unknown probe", available: Object.keys(PROBES) });
    }

    // EVERYTHING below is inside a catch, and that is the correction to this
    // probe rather than a nicety. The first run returned Cloudflare error 1101
    // on every call, which is an uncaught JavaScript exception, so the verdict
    // structure was bypassed entirely and the run said nothing at all.
    // An instrument that can fail without reporting why is not an instrument.
    //
    // container.start() inside LabContainer is deliberately NOT wrapped there,
    // because in /lab the Workflow catches and reports to Discord. The probe
    // has no Workflow, so the probe has to catch.
    const startedAt = Date.now();
    let run;
    let attempts = 0;
    try {
      // RETRY, bounded, and only on the one error that means the container
      // application has nothing to hand out yet.
      //
      // Attempt 3 of this probe failed all six calls with "There is no
      // container instance that can be provided to this Durable Object, try
      // again later", surfacing as "exec() cannot be called on a container
      // that is not running". A Worker deploy finishes in about a second; the
      // container application image push and rollout do not, so curling
      // immediately races it. "try again later" is literal advice.
      //
      // The attempt count is REPORTED on every response, so a success after
      // five tries reads differently from a clean one. A retry that hides how
      // hard it had to try converts a structural problem into a flaky one.
      let lastErr: unknown;
      for (attempts = 1; attempts <= PROVISION_ATTEMPTS; attempts++) {
        try {
          const stub = env.LAB.get(env.LAB.idFromName("egress-probe"));
          const response = await stub.fetch("https://lab.invalid/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeLabRequest(probe.lang, probe.code),
          });
          if (!response.ok) {
            return Response.json({
              probe: name,
              ok: false,
              stage: "sandbox returned a non-2xx",
              sandboxStatus: response.status,
              detail: (await response.text()).slice(0, 600),
              attempts,
              elapsedMs: Date.now() - startedAt,
            });
          }
          run = decodeLabResult(await response.json());
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const message = err instanceof Error ? err.message : String(err);
          // Anything else is a real fault and surfaces immediately rather than
          // being retried into a timeout.
          if (!PROVISION_PENDING.test(message)) throw err;
          if (attempts < PROVISION_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, PROVISION_WAIT_MS));
          }
        }
      }
      if (lastErr) throw lastErr;
    } catch (err) {
      // The message is the whole diagnosis. A container that refuses to start
      // says so here instead of becoming an error page.
      const e = err as { name?: unknown; message?: unknown; stack?: unknown };
      return Response.json({
        probe: name,
        ok: false,
        stage: "the sandbox threw before returning a result",
        attempts,
        errorName: typeof e?.name === "string" ? e.name : "unknown",
        errorMessage: typeof e?.message === "string" ? e.message.slice(0, 600) : String(err).slice(0, 600),
        firstFrame: typeof e?.stack === "string" ? (e.stack.split("\n")[1] ?? "").trim().slice(0, 300) : "",
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (!run) {
      return Response.json({
        probe: name,
        ok: false,
        stage: "unreadable sandbox result",
        attempts,
        elapsedMs: Date.now() - startedAt,
      });
    }

    const succeeded = run.exitCode === 0 && !run.timedOut;
    const observed = succeeded ? "SUCCEED" : "FAIL";
    return Response.json({
      probe: name,
      ok: true,
      why: probe.why,
      expected: probe.expect,
      observed,
      verdict: observed === probe.expect ? "AS EXPECTED" : "UNEXPECTED, READ THIS",
      attempts,
      elapsedMs: Date.now() - startedAt,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdout: run.stdout.slice(0, 400),
      stderr: run.stderr.slice(0, 400),
    });
  },
};
