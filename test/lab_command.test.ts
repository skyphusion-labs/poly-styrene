import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleDiscord } from "../src/discord";
import { LAB_DAILY_RUNS, LAB_MAX_CODE } from "../src/lab";
import { openLabSession } from "../src/lab_journal";
import { memoryLabDb, testEnv } from "./fakes";

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

function labInteraction(over: Record<string, unknown> = {}, options?: unknown[]) {
  return {
    id: "inter-lab-1",
    application_id: "app-1",
    token: "token-1",
    type: 2,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "4242" }, roles: ["7"] },
    data: {
      name: "lab",
      options: options ?? [{ name: "code", value: "echo hi" }],
    },
    ...over,
  };
}

function rig(over: Record<string, unknown> = {}) {
  const lab = memoryLabDb();
  const made = testEnv({ DISCORD_PUBLIC_KEY: publicHex, DB: lab.db, LAB_ROLE_IDS: "7", ...over });
  return { ...made, lab };
}

async function post(env: Parameters<typeof handleDiscord>[1], payload: unknown) {
  const response = await handleDiscord(signed(JSON.stringify(payload)), env, { waitUntil() {} });
  const text = await response.text();
  return { status: response.status, json: response.status === 200 ? JSON.parse(text) : null };
}

describe("/lab gating, as wired", () => {
  // labGate is unit tested, but a correct gate that nothing calls is not a
  // control. These assert the refusal happens on the real request path AND
  // that no Workflow was created, which is what actually costs money.
  it("refuses everyone when no role is configured", async () => {
    const { env, labRun } = rig({ LAB_ROLE_IDS: "" });
    const out = await post(env, labInteraction());
    expect(out.json.type).toBe(4);
    expect(out.json.data.flags).toBe(64);
    expect(out.json.data.content).toContain("not configured");
    expect(labRun.created).toHaveLength(0);
  });

  it("refuses a member without the allowed role", async () => {
    const { env, labRun } = rig();
    const out = await post(env, labInteraction({ member: { user: { id: "4242" }, roles: ["8", "9"] } }));
    expect(out.json.data.content).toContain("role you do not have");
    expect(labRun.created).toHaveLength(0);
  });

  it("refuses a member carrying no roles at all", async () => {
    const { env, labRun } = rig();
    const out = await post(env, labInteraction({ member: { user: { id: "4242" } } }));
    expect(out.json.data.flags).toBe(64);
    expect(labRun.created).toHaveLength(0);
  });

  it("refuses a DM, which carries no member and therefore no roles", async () => {
    const { env, labRun } = rig();
    const payload = labInteraction({ user: { id: "4242" }, member: undefined });
    delete (payload as Record<string, unknown>).guild_id;
    const out = await post(env, payload);
    expect(out.json.type).toBe(4);
    expect(labRun.created).toHaveLength(0);
  });

  // The test above passes on the no-roles branch, so on its own it does not
  // pin the out-of-guild check at all: a mutation forcing inGuild true left
  // it green. This one supplies roles WITHOUT a guild, which Discord does not
  // currently send for a guild command but which a user-installed app context
  // can approach, and it is the only case that reaches that branch.
  it("refuses outside a guild even when a matching role is somehow present", async () => {
    const { env, labRun } = rig();
    const payload = labInteraction({ member: { user: { id: "4242" }, roles: ["7"] } });
    delete (payload as Record<string, unknown>).guild_id;
    const out = await post(env, payload);
    expect(out.json.type).toBe(4);
    expect(out.json.data.content).toContain("not in a DM");
    expect(labRun.created).toHaveLength(0);
  });

  it("starts the Workflow for an allowed member and defers", async () => {
    const { env, labRun } = rig();
    const out = await post(env, labInteraction());
    expect(out.json).toEqual({ type: 5 });
    expect(labRun.created).toHaveLength(1);
    const created = labRun.created[0];
    expect(created?.id).toBe("inter-lab-1");
    expect(created?.params.sessionId).toBe("inter-lab-1");
    expect(created?.params.userId).toBe("4242");
    expect(created?.params.lang).toBe("sh");
    expect(created?.params.code).toBe("echo hi");
  });
});

describe("/lab input and quota, as wired", () => {
  it("refuses oversized code before starting anything", async () => {
    const { env, labRun } = rig();
    const out = await post(env, labInteraction({}, [{ name: "code", value: "x".repeat(LAB_MAX_CODE + 1) }]));
    expect(out.json.data.content).toContain(String(LAB_MAX_CODE));
    expect(labRun.created).toHaveLength(0);
  });

  it("refuses an unknown language before starting anything", async () => {
    const { env, labRun } = rig();
    const out = await post(env, labInteraction({}, [
      { name: "code", value: "puts 1" },
      { name: "language", value: "ruby" },
    ]));
    expect(out.json.data.content).toContain("sh, python, or node");
    expect(labRun.created).toHaveLength(0);
  });

  it("refuses once the daily quota is spent", async () => {
    const { env, labRun, lab } = rig();
    const now = new Date().toISOString();
    for (let i = 0; i < LAB_DAILY_RUNS; i++) {
      await openLabSession(lab.db, {
        id: `old-${i}`,
        userId: "4242",
        guildId: "guild-1",
        channelId: "channel-1",
        instance: "basic",
        startedAt: now,
      });
    }
    const out = await post(env, labInteraction());
    expect(out.json.data.content).toContain(String(LAB_DAILY_RUNS));
    expect(labRun.created).toHaveLength(0);
  });

  it("does not spend another person's quota", async () => {
    const { env, labRun, lab } = rig();
    const now = new Date().toISOString();
    for (let i = 0; i < LAB_DAILY_RUNS; i++) {
      await openLabSession(lab.db, {
        id: `other-${i}`,
        userId: "9999",
        guildId: "guild-1",
        channelId: "channel-1",
        instance: "basic",
        startedAt: now,
      });
    }
    const out = await post(env, labInteraction());
    expect(out.json).toEqual({ type: 5 });
    expect(labRun.created).toHaveLength(1);
  });

  // Discord retries an interaction it thinks it lost. The interaction id is
  // the Workflow id, so the retry must re-acknowledge rather than run the
  // researcher's code a second time in a second billed container.
  it("re-acknowledges a retried interaction without running twice", async () => {
    const { env, labRun } = rig();
    const first = await post(env, labInteraction());
    const second = await post(env, labInteraction());
    expect(first.json).toEqual({ type: 5 });
    expect(second.json).toEqual({ type: 5 });
    expect(labRun.created).toHaveLength(1);
  });
});
