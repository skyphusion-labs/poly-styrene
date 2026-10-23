import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOG_KEY } from "../src/catalog";
import { handleDiscord } from "../src/discord";
import { setPin } from "../src/db";
import { testEnv } from "./fakes";

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
