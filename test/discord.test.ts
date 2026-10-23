import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOG_KEY, type ModelCard } from "../src/catalog";
import { handleDiscord } from "../src/discord";
import { handleRequest } from "../src/server";
import { selectValue } from "../src/text";
import { testEnv } from "./fakes";

const pair = generateKeyPairSync("ed25519");
const der = pair.publicKey.export({ format: "der", type: "spki" });
const publicHex = Buffer.from(der.subarray(der.length - 32)).toString("hex");

function signed(body: string, timestamp = String(Math.floor(Date.now() / 1000))): Request {
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

function card(id: string, task = "Text Generation"): ModelCard {
  return { id, provider: "cloudflare", task, name: id, description: "", price: "" };
}

async function post(env: ReturnType<typeof testEnv>["env"], payload: unknown, ctx = { waitUntil(_p: Promise<unknown>) {} }) {
  const body = JSON.stringify(payload);
  const response = await handleDiscord(signed(body), env, ctx);
  const text = await response.text();
  return { status: response.status, text, json: response.status === 200 ? JSON.parse(text) : null };
}

function interaction(data: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "inter-1",
    application_id: "app-1",
    token: "token-1",
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1" } },
    data,
    ...extra,
  };
}

describe("discord", () => {
  it("answers a signed ping and rejects a bad signature", async () => {
    const { env } = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    const ping = await post(env, { type: 1 });
    expect(ping.status).toBe(200);
    expect(ping.json).toEqual({ type: 1 });

    const bad = signed(JSON.stringify({ type: 1 }));
    bad.headers.set("x-signature-ed25519", `${"ab".repeat(63)}00`);
    const rejected = await handleDiscord(bad, env, { waitUntil() {} });
    expect(rejected.status).toBe(401);

    const stale = await handleDiscord(signed(JSON.stringify({ type: 1 }), "100"), env, { waitUntil() {} });
    expect(stale.status).toBe(401);

    const missing = await handleDiscord(signed("{}"), testEnv().env, { waitUntil() {} });
    expect(missing.status).toBe(503);

    const method = await handleDiscord(new Request("https://poly-styrene.example/discord"), env, { waitUntil() {} });
    expect(method.status).toBe(405);

    const junk = await handleDiscord(signed("not-json"), env, { waitUntil() {} });
    expect(junk.status).toBe(400);

    const huge = "x".repeat(1_000_001);
    const oversized = await handleDiscord(signed(huge), env, { waitUntil() {} });
    expect(oversized.status).toBe(413);
  });

  it("lists models, pages, and pins from the menu", async () => {
    const rig = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    const models = Array.from({ length: 26 }, (_, i) => card(`@cf/test/model-${String(i).padStart(2, "0")}`));
    models.push(card("@cf/test/translator", "Translation"));
    await rig.catalog.kv.put(CATALOG_KEY, JSON.stringify({ refreshedAt: "t", models }));

    const listed = await post(rig.env, interaction({ name: "models", options: [{ name: "provider", type: 3, value: "cloudflare" }] }));
    expect(listed.json.data.flags).toBe(64);
    expect(listed.json.data.content).toContain("Page 1 of");
    const select = listed.json.data.components[0].components[0];
    expect(select.custom_id).toBe("pick");
    expect(select.options).toHaveLength(25);
    expect(select.options.every((option: { value: string }) => option.value.length <= 100)).toBe(true);
    expect(rig.catalog.dump.get("view:user-1:channel-1")?.expirationTtl).toBe(600);

    const next = await post(rig.env, interaction({ name: "x" }, { type: 3, data: { custom_id: "page:next" } }));
    expect(next.json.type).toBe(7);
    expect(next.json.data.content).toContain("Page 2 of");

    const value = select.options[0].value as string;
    const picked = await post(rig.env, interaction({ name: "x" }, { type: 3, data: { custom_id: "pick", values: [value] } }));
    expect(picked.json.data.content).toContain("Pinned");
    expect(picked.json.data.content).toContain("bill on Cloudflare");
    expect(rig.pins.rows[0]?.model_id).toBe(value);

    const shown = await post(rig.env, interaction({ name: "model" }));
    expect(shown.json.data.content).toContain(value);
  });

  it("pins, clears, and autocompletes", async () => {
    const rig = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    await rig.catalog.kv.put(
      CATALOG_KEY,
      JSON.stringify({ refreshedAt: "t", models: [card("@cf/zai-org/glm-4.7-flash"), card("qwen2.5-coder:7b")] }),
    );
    const pinned = await post(rig.env, interaction({ name: "model", options: [{ name: "name", value: "openai/gpt-5.5" }] }));
    expect(pinned.json.data.content).toContain("openai/gpt-5.5");
    expect(rig.pins.rows[0]?.provider).toBe("cloudflare");

    const cleared = await post(rig.env, interaction({ name: "model", options: [{ name: "clear", type: 5, value: true }] }));
    expect(cleared.json.data.content).toContain("Cleared");
    expect(rig.pins.rows).toHaveLength(0);

    const unknown = await post(rig.env, interaction({ name: "model", options: [{ name: "name", value: "h:0123abcd" }] }));
    expect(unknown.json.data.content).toContain("don't know");

    const tasks = await post(
      rig.env,
      interaction({ name: "models", options: [{ name: "task", value: "text", focused: true }] }, { type: 4 }),
    );
    expect(tasks.json.type).toBe(8);
    expect(tasks.json.data.choices.some((choice: { value: string }) => choice.value === "Text Generation")).toBe(true);

    const names = await post(
      rig.env,
      interaction({ name: "ask", options: [{ name: "model", value: "glm", focused: true }] }, { type: 4 }),
    );
    expect(names.json.data.choices[0].value).toBe(selectValue("@cf/zai-org/glm-4.7-flash"));
  });

  it("defers an ask and refuses a second one inside the cooldown", async () => {
    const rig = testEnv({ DISCORD_PUBLIC_KEY: publicHex, RUNPOD_ENDPOINT_ID: "endpoint", RUNPOD_API_KEY: "key" });
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const first = await post(
        rig.env,
        interaction({ name: "ask", options: [{ name: "prompt", value: "UNIQUEPROMPTTOKEN explain tls" }] }),
      );
      expect(first.json).toEqual({ type: 5 });
      expect(rig.ask.created).toHaveLength(1);
      expect(rig.ask.created[0]?.params.modelId).toBe("@cf/zai-org/glm-4.7-flash");
      expect(logs.join("\n")).toContain("ask_started");
      expect(logs.join("\n")).not.toContain("UNIQUEPROMPTTOKEN");

      const retry = await post(
        rig.env,
        interaction({ name: "ask", options: [{ name: "prompt", value: "UNIQUEPROMPTTOKEN explain tls" }] }),
      );
      expect(retry.json).toEqual({ type: 5 });
      expect(rig.ask.created).toHaveLength(1);

      const second = await post(
        rig.env,
        interaction({ name: "ask", options: [{ name: "prompt", value: "again" }] }, { id: "inter-2" }),
      );
      expect(second.json.data.content).toContain("Wait 3 seconds");
      expect(rig.ask.created).toHaveLength(1);
    } finally {
      console.log = original;
    }
  });

  it("does not burn the cooldown on a bad ask", async () => {
    const rig = testEnv({ DISCORD_PUBLIC_KEY: publicHex });
    await rig.catalog.kv.put(CATALOG_KEY, JSON.stringify({ refreshedAt: "t", models: [card("@cf/translate", "Translation")] }));
    const bad = await post(rig.env, interaction({
      name: "ask",
      options: [{ name: "prompt", value: "hola" }, { name: "model", value: "@cf/translate" }],
    }));
    expect(bad.json.data.content).toContain("source_lang");
    expect(rig.catalog.dump.has("cool:user-1")).toBe(false);
    expect(rig.ask.created).toHaveLength(0);

    const ollama = await post(rig.env, interaction({
      name: "ask",
      options: [{ name: "prompt", value: "hi" }, { name: "model", value: "qwen2.5-coder:7b" }],
    }));
    expect(ollama.json.data.content).toContain("not configured");
    expect(rig.ask.created).toHaveLength(0);

    const big = await post(rig.env, interaction({
      name: "ask",
      options: [{ name: "prompt", value: "look" }, { name: "file", value: "att-1" }],
      resolved: { attachments: { "att-1": { url: "https://cdn.example/a", filename: "a.png", size: 9_000_000, content_type: "image/png" } } },
    }));
    expect(big.json.data.content).toContain("8MB");
  });

  it("refreshes an empty catalog without blocking the reply", async () => {
    const rig = testEnv({ DISCORD_PUBLIC_KEY: publicHex, CATALOG_TOKEN: "test-token" });
    const pending: Promise<unknown>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ result: [{ name: "@cf/new", task: { name: "Text Generation" } }], result_info: { total_count: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      const listed = await post(rig.env, interaction({ name: "models" }), {
        waitUntil(promise) {
          pending.push(promise);
        },
      });
      expect(listed.json.data.content).toContain("qwen2.5-coder:7b");
      await Promise.all(pending);
      const stored = rig.catalog.dump.get(CATALOG_KEY)?.value ?? "";
      expect(stored).toContain("@cf/new");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("server", () => {
  it("serves health and a short root", async () => {
    const { env } = testEnv({ RUNPOD_ENDPOINT_ID: "endpoint" });
    const health = await handleRequest(new Request("https://poly-styrene.example/health"), env, { waitUntil() {} });
    expect(await health.json()).toEqual({ ok: true, name: "poly-styrene", gateway: "poly-styrene", ollama: true });
    const root = await handleRequest(new Request("https://poly-styrene.example/"), env, { waitUntil() {} });
    expect(await root.text()).toContain("Poly Styrene");
  });
});
