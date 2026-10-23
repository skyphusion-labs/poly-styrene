import {
  findModel,
  modelFromId,
  pageModels,
  PAGE_SIZE,
  queryModels,
  readCatalog,
  type ModelCard,
  type ModelPage,
  type ModelQuery,
} from "./catalog";
import { clearPin, getPin, setPin } from "./db";
import type { AskParams, Env, LabParams } from "./env";
import { preflight, taskKind } from "./infer";
import { labGate, labQuota, parseLab, parseRoleIds, quotaWindowStart } from "./lab";
import { countLabRuns } from "./lab_journal";
import { refreshCatalog } from "./refresh";
import { selectValue } from "./text";

export type WaitCtx = { waitUntil(promise: Promise<unknown>): void };

const ASK_COOLDOWN_MS = 3000;
const MAX_PROMPT = 4000;
const MAX_BODY = 1_000_000;
const MAX_FILE = 8_000_000;
const MAX_AUDIO = 1_000_000;
const BILL_CF = "Workers AI and catalog models bill on Cloudflare.";
const BILL_GPU = "Ollama bills RunPod per GPU-second while the worker is up.";

type Json = Record<string, unknown>;

type Opt = {
  name?: string;
  value?: string | number | boolean;
  focused?: boolean;
};

type Place = { userId: string; guildId: string; channelId: string };

type View = { provider: string; task: string; search: string; page: number };

type Attachment = { url: string; name: string; mime: string; size: number };

function asRecord(value: unknown): Json | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Json;
}

function ephemeral(content: string, components?: unknown[]): Json {
  const data: Json = { flags: 64, content };
  if (components) data.components = components;
  return { type: 4, data };
}

function update(content: string, components: unknown[]): Json {
  return { type: 7, data: { flags: 64, content, components } };
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyDiscord(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): Promise<boolean> {
  if (!/^[0-9]+$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > 5 * 60 * 1000) return false;
  const key = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    const data = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig, data);
  } catch {
    return false;
  }
}

function userIdOf(interaction: Json): string {
  const member = asRecord(interaction.member);
  const memberUser = member ? asRecord(member.user) : null;
  if (memberUser && typeof memberUser.id === "string") return memberUser.id;
  const user = asRecord(interaction.user);
  if (user && typeof user.id === "string") return user.id;
  return "";
}

function placeOf(interaction: Json): Place {
  return {
    userId: userIdOf(interaction),
    guildId: typeof interaction.guild_id === "string" ? interaction.guild_id : "dm",
    channelId: typeof interaction.channel_id === "string" ? interaction.channel_id : "dm",
  };
}

/** The invoker's role ids, which is what gates /lab. Absent in a DM. */
function rolesOf(interaction: Json): string[] {
  const member = asRecord(interaction.member);
  if (!member || !Array.isArray(member.roles)) return [];
  return member.roles.filter((role): role is string => typeof role === "string");
}

function dataOf(interaction: Json): Json {
  return asRecord(interaction.data) ?? {};
}

function optionsOf(data: Json): Opt[] {
  if (!Array.isArray(data.options)) return [];
  return data.options.filter((item) => item && typeof item === "object") as Opt[];
}

function stringOpt(options: Opt[], name: string): string {
  const found = options.find((opt) => opt.name === name);
  if (found?.value == null) return "";
  return String(found.value);
}

function numberOpt(options: Opt[], name: string): number {
  const found = options.find((opt) => opt.name === name);
  const value = typeof found?.value === "number" ? found.value : Number(found?.value ?? "");
  return Number.isFinite(value) ? value : 0;
}

function boolOpt(options: Opt[], name: string): boolean {
  const found = options.find((opt) => opt.name === name);
  return found?.value === true;
}

function stringField(row: Json, key: string): string {
  return typeof row[key] === "string" ? (row[key] as string) : "";
}

function viewKey(userId: string, channelId: string): string {
  return `view:${userId}:${channelId}`;
}

function bill(provider: string): string {
  return provider === "ollama" ? BILL_GPU : BILL_CF;
}

function pinText(card: ModelCard): string {
  return `Pinned \`${card.id}\` (${card.task}). ${bill(card.provider)}`;
}

function labelFor(id: string): string {
  const parts = id.split("/");
  const tail = parts.length > 1 ? parts.slice(-2).join("/") : id;
  return (tail || "model").slice(0, 100);
}

function clip(text: string): string {
  if (text.length <= 1900) return text;
  return `${text.slice(0, 1850)}\n(List clipped. Use the menu, or narrow the search.)`;
}

function listContent(page: ModelPage, query: ModelQuery): string {
  if (page.total === 0) return "No models match that filter.";
  const lines = page.items.map((model, index) => {
    const n = (page.page - 1) * PAGE_SIZE + index + 1;
    const price = model.price ? `, ${model.price}` : "";
    return `${n}. \`${model.id}\`, ${model.task}${price}`;
  });
  const filters = [query.provider, query.task, query.search].filter(Boolean).join(", ");
  const head = filters ? `Filter: ${filters}. ` : "";
  return clip(`${head}Page ${page.page} of ${page.pages}, ${page.total} models.\n${lines.join("\n")}`);
}

function rows(page: ModelPage): unknown[] {
  const components: unknown[] = [];
  if (page.items.length > 0) {
    const options = page.items.map((model) => {
      const description = `${model.task}${model.price ? `, ${model.price}` : ""}`.slice(0, 100);
      const option: Json = { label: labelFor(model.id), value: selectValue(model.id) };
      if (description.trim()) option.description = description;
      return option;
    });
    components.push({
      type: 1,
      components: [{ type: 3, custom_id: "pick", placeholder: "Pin a model for yourself", options }],
    });
  }
  if (page.pages > 1) {
    components.push({
      type: 1,
      components: [
        { type: 2, style: 2, custom_id: "page:prev", label: "Prev", disabled: page.page <= 1 },
        { type: 2, style: 2, custom_id: "page:next", label: "Next", disabled: page.page >= page.pages },
      ],
    });
  }
  return components;
}

function resolveCard(models: ModelCard[], raw: string): ModelCard | null {
  const found = findModel(models, raw);
  if (found) return found;
  if (/^h:[0-9a-f]{8}$/i.test(raw.trim())) return null;
  return modelFromId(raw);
}

function ensureCatalog(env: Env, ctx: WaitCtx, models: ModelCard[]): void {
  const hasCloudflare = models.some((model) => model.provider === "cloudflare");
  if (!hasCloudflare && env.CATALOG_TOKEN) ctx.waitUntil(refreshCatalog(env));
}

function parseView(raw: string): View | null {
  try {
    const value = JSON.parse(raw) as Partial<View>;
    if (!value || typeof value !== "object") return null;
    return {
      provider: typeof value.provider === "string" ? value.provider : "",
      task: typeof value.task === "string" ? value.task : "",
      search: typeof value.search === "string" ? value.search : "",
      page: typeof value.page === "number" ? value.page : 1,
    };
  } catch {
    return null;
  }
}

async function showModels(
  env: Env,
  ctx: WaitCtx,
  place: Place,
  query: ModelQuery,
  pageNum: number,
): Promise<{ page: ModelPage; query: View }> {
  const file = await readCatalog(env);
  ensureCatalog(env, ctx, file.models);
  const page = pageModels(queryModels(file.models, query), pageNum);
  const view: View = {
    provider: query.provider ?? "",
    task: query.task ?? "",
    search: query.search ?? "",
    page: page.page,
  };
  await env.CATALOG.put(viewKey(place.userId, place.channelId), JSON.stringify(view), { expirationTtl: 600 });
  return { page, query: view };
}

async function commandModels(interaction: Json, env: Env, ctx: WaitCtx, place: Place): Promise<Json> {
  const options = optionsOf(dataOf(interaction));
  const shown = await showModels(
    env,
    ctx,
    place,
    {
      provider: stringOpt(options, "provider"),
      task: stringOpt(options, "task"),
      search: stringOpt(options, "search"),
    },
    numberOpt(options, "page") || 1,
  );
  return ephemeral(listContent(shown.page, shown.query), rows(shown.page));
}

async function commandModel(interaction: Json, env: Env, place: Place): Promise<Json> {
  const options = optionsOf(dataOf(interaction));
  if (boolOpt(options, "clear")) {
    await clearPin(env.DB, place.guildId, place.channelId, place.userId);
    return ephemeral(`Cleared your pin. Default is \`${env.DEFAULT_MODEL}\` (${env.DEFAULT_TASK}). ${BILL_CF}`);
  }
  const name = stringOpt(options, "name").trim();
  if (!name) {
    const pin = await getPin(env.DB, place.guildId, place.channelId, place.userId);
    if (!pin) return ephemeral(`Default is \`${env.DEFAULT_MODEL}\` (${env.DEFAULT_TASK}). ${BILL_CF}`);
    return ephemeral(`Your pin is \`${pin.model_id}\` (${pin.task}). ${bill(pin.provider)}`);
  }
  const file = await readCatalog(env);
  const card = resolveCard(file.models, name);
  if (!card) return ephemeral("I don't know that model. Run /models, or pass a catalog id like author/name.");
  await setPin(env.DB, place.guildId, place.channelId, place.userId, {
    provider: card.provider,
    model_id: card.id,
    task: card.task,
  });
  return ephemeral(pinText(card));
}

function attachmentOf(data: Json, options: Opt[]): Attachment | null {
  const file = options.find((opt) => opt.name === "file");
  if (!file || file.value == null) return null;
  const resolved = asRecord(data.resolved);
  const attachments = resolved ? asRecord(resolved.attachments) : null;
  const row = attachments ? asRecord(attachments[String(file.value)]) : null;
  if (!row || typeof row.url !== "string") return null;
  return {
    url: row.url,
    name: typeof row.filename === "string" ? row.filename : "upload",
    mime: typeof row.content_type === "string" ? row.content_type : "application/octet-stream",
    size: typeof row.size === "number" ? row.size : 0,
  };
}

function readCool(raw: string | null): { at: number; id: string } | null {
  if (!raw) return null;
  const split = raw.indexOf(":");
  if (split < 0) return null;
  const at = Number(raw.slice(0, split));
  if (!Number.isFinite(at)) return null;
  return { at, id: raw.slice(split + 1) };
}

async function commandAsk(interaction: Json, env: Env, place: Place): Promise<Json> {
  const data = dataOf(interaction);
  const options = optionsOf(data);
  const prompt = stringOpt(options, "prompt").trim();
  if (!prompt) return ephemeral("Say what you want in prompt.");
  if (prompt.length > MAX_PROMPT) return ephemeral("Prompt is limited to 4000 characters.");

  const file = await readCatalog(env);
  const override = stringOpt(options, "model").trim();
  let card: ModelCard | null;
  if (override) {
    card = resolveCard(file.models, override);
    if (!card) return ephemeral("I don't know that model. Run /models, or pass a catalog id like author/name.");
  } else {
    const pin = await getPin(env.DB, place.guildId, place.channelId, place.userId);
    card = pin
      ? { id: pin.model_id, provider: pin.provider, task: pin.task, name: pin.model_id, description: "", price: "" }
      : {
          id: env.DEFAULT_MODEL,
          provider: "cloudflare",
          task: env.DEFAULT_TASK,
          name: env.DEFAULT_MODEL,
          description: "",
          price: "",
        };
  }

  const fileOpt = options.some((opt) => opt.name === "file");
  const attachment = attachmentOf(data, options);
  if (fileOpt && !attachment) return ephemeral("I could not read that file.");
  if (attachment && attachment.size > MAX_FILE) return ephemeral("Files are limited to 8MB.");

  const sourceLang = stringOpt(options, "source_lang").trim();
  const targetLang = stringOpt(options, "target_lang").trim();
  const early = preflight(card.task, { hasFile: Boolean(attachment), sourceLang, targetLang });
  if (early) return ephemeral(early);
  if (attachment && taskKind(card.task) === "asr" && attachment.size > MAX_AUDIO) {
    return ephemeral("Audio is limited to 1MB on this path.");
  }
  if (card.provider === "ollama" && (!env.RUNPOD_ENDPOINT_ID || !env.RUNPOD_API_KEY)) {
    return ephemeral("Ollama is not configured on this bot yet.");
  }

  const interactionId = stringField(interaction, "id");
  const applicationId = stringField(interaction, "application_id") || env.DISCORD_APPLICATION_ID || "";
  const interactionToken = stringField(interaction, "token");
  if (!interactionId || !applicationId || !interactionToken) {
    return ephemeral("Discord did not send an application id and token.");
  }

  const coolKey = `cool:${place.userId}`;
  const now = Date.now();
  const previous = readCool(await env.CATALOG.get(coolKey));
  if (previous && previous.id !== interactionId && now - previous.at < ASK_COOLDOWN_MS) {
    return ephemeral("Wait 3 seconds between asks.");
  }

  const params: AskParams = {
    applicationId,
    interactionToken,
    prompt,
    provider: card.provider,
    modelId: card.id,
    task: card.task,
    sourceLang,
    targetLang,
    attachmentUrl: attachment?.url ?? "",
    attachmentName: attachment?.name ?? "",
    attachmentType: attachment?.mime ?? "",
  };

  try {
    await env.ASK.create({ id: interactionId, params });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.toLowerCase().includes("already exists")) return { type: 5 };
    console.log(JSON.stringify({ event: "ask_create_failed", provider: card.provider, model: card.id, task: card.task }));
    return ephemeral("I could not start that. Try again.");
  }

  await env.CATALOG.put(coolKey, `${now}:${interactionId}`, { expirationTtl: 60 });
  console.log(JSON.stringify({ event: "ask_started", provider: card.provider, model: card.id, task: card.task }));
  return { type: 5 };
}

async function commandLab(interaction: Json, env: Env, place: Place): Promise<Json> {
  // Gate first, and refuse ephemerally, so a denial is not announced to the
  // channel and nothing is started before the invoker is known to be allowed.
  const gate = labGate({
    inGuild: place.guildId !== "dm",
    roles: rolesOf(interaction),
    allowedRoleIds: parseRoleIds(env.LAB_ROLE_IDS),
  });
  if (!gate.ok) return ephemeral(gate.reason);

  const options = optionsOf(dataOf(interaction));
  const parsed = parseLab(stringOpt(options, "language"), stringOpt(options, "code"));
  if (!parsed.ok) return ephemeral(parsed.error);

  const interactionId = stringField(interaction, "id");
  const applicationId = stringField(interaction, "application_id") || env.DISCORD_APPLICATION_ID || "";
  const interactionToken = stringField(interaction, "token");
  if (!interactionId || !applicationId || !interactionToken) {
    return ephemeral("Discord did not send an application id and token.");
  }

  // The quota is read before anything is started. countLabRuns reports -1 when
  // it cannot read, and labQuota refuses a negative, so a broken read denies
  // rather than reading as an unused quota.
  const used = await countLabRuns(env.DB, place.userId, quotaWindowStart(Date.now()));
  const quota = labQuota(used);
  if (!quota.ok) return ephemeral(quota.reason);

  const params: LabParams = {
    applicationId,
    interactionToken,
    sessionId: interactionId,
    userId: place.userId,
    guildId: place.guildId,
    channelId: place.channelId,
    lang: parsed.lang,
    code: parsed.code,
  };

  try {
    // Same idempotency as /ask: the interaction id IS the Workflow id, so a
    // Discord retry re-acknowledges rather than running the code twice.
    await env.LABRUN.create({ id: interactionId, params });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.toLowerCase().includes("already exists")) return { type: 5 };
    console.log(JSON.stringify({ event: "lab_create_failed", lang: parsed.lang }));
    return ephemeral("I could not start the lab. Try again.");
  }

  console.log(JSON.stringify({ event: "lab_started", lang: parsed.lang }));
  return { type: 5 };
}

async function autocomplete(interaction: Json, env: Env, ctx: WaitCtx): Promise<Json> {
  const options = optionsOf(dataOf(interaction));
  const focused = options.find((opt) => opt.focused);
  const file = await readCatalog(env);
  ensureCatalog(env, ctx, file.models);
  const typed = typeof focused?.value === "string" ? focused.value : "";
  let choices: { name: string; value: string }[] = [];
  if (focused?.name === "task") {
    const query = typed.toLowerCase();
    const tasks = [...new Set(file.models.map((model) => model.task))];
    choices = tasks
      .filter((task) => task.toLowerCase().includes(query))
      .slice(0, 25)
      .map((task) => ({ name: task.slice(0, 100), value: task.slice(0, 100) }));
  } else if (focused?.name === "name" || focused?.name === "model") {
    choices = queryModels(file.models, { search: typed })
      .slice(0, 25)
      .map((model) => ({
        name: `${model.id} (${model.task})`.slice(0, 100),
        value: selectValue(model.id),
      }));
  }
  return { type: 8, data: { choices } };
}

async function routeComponent(interaction: Json, env: Env, ctx: WaitCtx, place: Place): Promise<Json> {
  const data = dataOf(interaction);
  const customId = stringField(data, "custom_id");
  if (customId === "page:next" || customId === "page:prev") {
    const raw = await env.CATALOG.get(viewKey(place.userId, place.channelId));
    const view = raw ? parseView(raw) : null;
    if (!view) return ephemeral("That list expired. Run /models again.");
    const delta = customId === "page:next" ? 1 : -1;
    const shown = await showModels(env, ctx, place, view, (view.page || 1) + delta);
    return update(listContent(shown.page, shown.query), rows(shown.page));
  }
  if (customId === "pick") {
    const values = Array.isArray(data.values) ? data.values : [];
    const picked = typeof values[0] === "string" ? values[0] : "";
    if (!picked) return ephemeral("Pick a model from the list.");
    const file = await readCatalog(env);
    const card = resolveCard(file.models, picked);
    if (!card) return ephemeral("That model is not in the list anymore. Run /models again.");
    await setPin(env.DB, place.guildId, place.channelId, place.userId, {
      provider: card.provider,
      model_id: card.id,
      task: card.task,
    });
    return update(pinText(card), []);
  }
  return ephemeral("I don't know that interaction.");
}

async function routeCommand(interaction: Json, env: Env, ctx: WaitCtx, place: Place): Promise<Json> {
  const name = stringField(dataOf(interaction), "name");
  if (name === "models") return commandModels(interaction, env, ctx, place);
  if (name === "model") return commandModel(interaction, env, place);
  if (name === "ask") return commandAsk(interaction, env, place);
  if (name === "lab") return commandLab(interaction, env, place);
  return ephemeral("I don't know that interaction.");
}

export async function routeInteraction(body: unknown, env: Env, ctx: WaitCtx): Promise<Json> {
  const interaction = asRecord(body);
  if (!interaction) return ephemeral("I don't know that interaction.");
  if (interaction.type === 1) return { type: 1 };
  if (interaction.type === 4) return autocomplete(interaction, env, ctx);
  const place = placeOf(interaction);
  if (!place.userId) return ephemeral("I could not see who sent that.");
  if (interaction.type === 3) return routeComponent(interaction, env, ctx, place);
  if (interaction.type === 2) return routeCommand(interaction, env, ctx, place);
  return ephemeral("I don't know that interaction.");
}

export async function handleDiscord(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.DISCORD_PUBLIC_KEY) return new Response("discord is not configured", { status: 503 });
  const claimed = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(claimed) && claimed > MAX_BODY) return new Response("payload too large", { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY) return new Response("payload too large", { status: 413 });
  const ok = await verifyDiscord(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("x-signature-ed25519") ?? "",
    request.headers.get("x-signature-timestamp") ?? "",
    body,
  );
  if (!ok) return new Response("bad signature", { status: 401 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  return Response.json(await routeInteraction(parsed, env, ctx));
}
