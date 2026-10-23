import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CATALOG_KEY } from "../src/catalog";
import { handleDiscord } from "../src/discord";
import { setPin } from "../src/db";
import { deferredGate, testEnv } from "./fakes";

// /ask answers inside Discord's 3 second interaction deadline, and NO TEST IN
// THIS REPO CAN FAIL A DEADLINE: every fake answers instantly. So the thing
// that is actually assertable is the NUMBER OF SEQUENTIAL ROUND TRIPS on the
// response path, which is what the budget is spent on. These assert the reads
// that were removed stay removed.

const pair = generateKeyPairSync("ed25519");
const der = pair.publicKey.export({ format: "der", type: "spki" });
const publicHex = Buffer.from(der.subarray(der.length - 32)).toString("hex");

function signed(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), pair.privateKey).toString("hex");
  return new Request("https://poly-styrene.example/discord", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body,
  });
}

function askInteraction(options: unknown[]) {
  return {
    id: `inter-${Math.random().toString(16).slice(2)}`,
    application_id: "app-1",
    token: "token-1",
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "4242" } },
    data: { name: "ask", options },
  };
}

async function post(env: Parameters<typeof handleDiscord>[1], payload: unknown) {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waited.push(p);
    },
  };
  const response = await handleDiscord(signed(JSON.stringify(payload)), env, ctx);
  const text = await response.text();
  await Promise.all(waited);
  return { json: response.status === 200 ? JSON.parse(text) : null, waited };
}

describe("the /ask response path does no unnecessary io", () => {
  it("does NOT read the catalog when no model override is given", async () => {
    const { env, catalog, ask } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    const out = await post(env, askInteraction([{ name: "prompt", value: "hello" }]));
    expect(out.json).toEqual({ type: 5 });
    expect(ask.created).toHaveLength(1);
    // The catalog decides nothing on this path; the pin does. Reading it was
    // a whole round trip spent on a value that is then discarded.
    expect(catalog.gets).not.toContain(CATALOG_KEY);
  });

  it("DOES read the catalog when an override has to be resolved against it", async () => {
    const { env, catalog } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    await post(env, askInteraction([
      { name: "prompt", value: "hello" },
      { name: "model", value: "@cf/meta/llama-3.1-8b-instruct" },
    ]));
    expect(catalog.gets).toContain(CATALOG_KEY);
  });

  it("writes the cooldown off the response path, not on it", async () => {
    const { env, catalog } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    const out = await post(env, askInteraction([{ name: "prompt", value: "hello" }]));
    // Deferred rather than awaited, so it costs no latency before the reply.
    expect(out.waited.length).toBeGreaterThan(0);
    // And it still lands, so the cooldown is no less reliable than before.
    expect(catalog.dump.has("cool:4242")).toBe(true);
  });

  it("still enforces the cooldown it read in parallel", async () => {
    const { env } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    const first = await post(env, askInteraction([{ name: "prompt", value: "one" }]));
    expect(first.json).toEqual({ type: 5 });
    const second = await post(env, askInteraction([{ name: "prompt", value: "two" }]));
    expect(second.json.type).toBe(4);
    expect(second.json.data.content).toContain("3 seconds");
  });

  it("still honours a pin, so the parallel read did not drop the model lookup", async () => {
    const { env, pins, ask } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    await setPin(pins.db, "guild-1", "channel-1", "4242", {
      provider: "cloudflare",
      model_id: "@cf/pinned/model",
      task: "Text Generation",
    });
    await post(env, askInteraction([{ name: "prompt", value: "hello" }]));
    expect(ask.created[0]?.params.modelId).toBe("@cf/pinned/model");
  });
});

describe("the Workflow create is NOT on the response path", () => {
  // memoryAsk's create has no `await` in its body, so it completes
  // SYNCHRONOUSLY and every existing test passes whether the create is
  // awaited or deferred. That is the same stub-shape blindness that hid the AI
  // binding receiver bug: a fake that cannot behave like the real thing cannot
  // observe the defect. So this uses a create that genuinely defers.
  function deferredAsk() {
    const created: string[] = [];
    // deferredGate carries the reasoning, including why a zero-delay timer
    // does not work here and why the backstop exists.
    const gate = deferredGate();
    const binding = {
      async create(options?: { id?: string }) {
        await gate.promise;
        created.push(options?.id ?? "");
      },
    };
    return { binding, created, release: gate.release };
  }

  it("returns the deferral BEFORE the create has completed", async () => {
    const ask = deferredAsk();
    const { env } = testEnv({ DISCORD_PUBLIC_KEY: publicHex, ASK: ask.binding as never });
    const waited: Promise<unknown>[] = [];
    const response = await handleDiscord(
      signed(JSON.stringify(askInteraction([{ name: "prompt", value: "hello" }]))),
      env,
      { waitUntil(p: Promise<unknown>) { waited.push(p); } },
    );

    expect(JSON.parse(await response.text())).toEqual({ type: 5 });
    // THE ASSERTION THAT MATTERS: the 3 second budget was spent without
    // waiting for the create.
    expect(ask.created).toEqual([]);

    // And it still happens, so this is deferral and not loss.
    ask.release();
    await Promise.all(waited);
    expect(ask.created).toHaveLength(1);
  });

  it("still starts exactly one Workflow per interaction", async () => {
    const ask = deferredAsk();
    const { env } = testEnv({ DISCORD_PUBLIC_KEY: publicHex, ASK: ask.binding as never });
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil(p: Promise<unknown>) { waited.push(p); } };
    const payload = askInteraction([{ name: "prompt", value: "hello" }]);
    await handleDiscord(signed(JSON.stringify(payload)), env, ctx);
    ask.release();
    await Promise.all(waited);
    expect(ask.created).toHaveLength(1);
  });
});

describe("a create failure is reported, not swallowed", () => {
  // The whole objection to moving the create off the response path is that a
  // failure leaves a deferral nobody resolves. These pin the answer.
  function failingAsk(message: string) {
    return {
      async create() {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        throw new Error(message);
      },
    };
  }

  it("tells the user through the interaction token when the create fails", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    });
    try {
      const { env } = testEnv({ DISCORD_PUBLIC_KEY: publicHex, ASK: failingAsk("boom") as never });
      const waited: Promise<unknown>[] = [];
      const response = await handleDiscord(
        signed(JSON.stringify(askInteraction([{ name: "prompt", value: "hello" }]))),
        env,
        { waitUntil(p: Promise<unknown>) { waited.push(p); } },
      );
      // The deferral still went out; the user is not left with nothing.
      expect(JSON.parse(await response.text())).toEqual({ type: 5 });
      await Promise.all(waited);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/messages/@original");
      expect(calls[0]?.body).toContain("could not start that");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // A Discord retry is not a failure and must not produce a second message.
  it("says nothing when the instance already exists", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    });
    try {
      const { env } = testEnv({
        DISCORD_PUBLIC_KEY: publicHex,
        ASK: failingAsk("instance already exists") as never,
      });
      const waited: Promise<unknown>[] = [];
      await handleDiscord(
        signed(JSON.stringify(askInteraction([{ name: "prompt", value: "hello" }]))),
        env,
        { waitUntil(p: Promise<unknown>) { waited.push(p); } },
      );
      await Promise.all(waited);
      expect(calls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("moving the create off the path did not make it unobservable", () => {
  // Measured: removing the ask_create_ms log left the whole suite GREEN, so
  // the argument that "moving work off a measured path must not hide it" was
  // an assertion about intent and nothing enforced it. This enforces it.
  it("logs ask_create_ms so create latency is still measurable", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    try {
      const { env } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
      const waited: Promise<unknown>[] = [];
      await handleDiscord(
        signed(JSON.stringify(askInteraction([{ name: "prompt", value: "hello" }]))),
        env,
        { waitUntil(p: Promise<unknown>) { waited.push(p); } },
      );
      await Promise.all(waited);
      const joined = lines.join(" ");
      expect(joined).toContain("ask_create_ms");
      // And the response-path budget line is still emitted, separately, so
      // the two measurements do not collapse into one.
      expect(joined).toContain("ask_io_ms");
      // The create is no longer part of the response-path budget, so it must
      // not reappear as a split in it.
      const io = lines.find((l) => l.includes("ask_io_ms")) ?? "";
      expect(io).not.toContain('"create"');
    } finally {
      spy.mockRestore();
    }
  });
});
