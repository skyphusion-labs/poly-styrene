import { SYSTEM_PROMPT } from "./prompt";

export type Answer =
  | { kind: "text"; text: string }
  | { kind: "file"; caption: string; filename: string; mime: string; base64: string }
  | { kind: "error"; text: string };

export type TaskKind =
  | "chat"
  | "image"
  | "translation"
  | "summary"
  | "embed"
  | "class"
  | "asr"
  | "tts"
  | "vision"
  | "other";

type Built = { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

export function taskKind(task: string): TaskKind {
  const name = task.toLowerCase();
  if (name.includes("text-to-image") || name.includes("image generation")) return "image";
  if (name.includes("translation")) return "translation";
  if (name.includes("summar")) return "summary";
  if (name.includes("embed")) return "embed";
  if (name.includes("speech") && (name.includes("recog") || name.includes("asr"))) return "asr";
  if (name.includes("text-to-speech") || name === "tts") return "tts";
  if (name.includes("image-to-text") || name.includes("visual question")) return "vision";
  if (name.includes("classif")) return "class";
  if (name.includes("text generation")) return "chat";
  return "other";
}

export function preflight(
  task: string,
  opts: { hasFile: boolean; sourceLang: string; targetLang: string },
): string | null {
  const kind = taskKind(task);
  if (kind === "translation" && (!opts.sourceLang || !opts.targetLang)) {
    return "This model translates. Pass source_lang and target_lang, for example en and es.";
  }
  if ((kind === "asr" || kind === "vision") && !opts.hasFile) {
    return "This model needs a file. Attach one with the file option.";
  }
  return null;
}

/**
 * The chat token budget, covering BOTH phases for a reasoning model: thinking
 * first, then the answer. `test/infer.test.ts` asserts a floor rather than this
 * exact number, so tuning it is allowed and slashing it is not.
 */
const CHAT_MAX_TOKENS = 2048;

export function buildWorkersInput(args: {
  task: string;
  prompt: string;
  sourceLang: string;
  targetLang: string;
  file?: { bytes: Uint8Array; mime: string };
}): Built {
  const kind = taskKind(args.task);
  if (kind === "image") return { ok: true, input: { prompt: args.prompt } };
  if (kind === "translation") {
    return {
      ok: true,
      input: { text: args.prompt, source_lang: args.sourceLang, target_lang: args.targetLang },
    };
  }
  if (kind === "summary") return { ok: true, input: { input_text: args.prompt } };
  if (kind === "embed") return { ok: true, input: { text: args.prompt } };
  if (kind === "class") return { ok: true, input: { text: args.prompt } };
  if (kind === "tts") return { ok: true, input: { prompt: args.prompt } };
  if (kind === "asr") {
    if (!args.file) return { ok: false, error: "This model needs an audio file." };
    if (args.file.bytes.byteLength > 1_000_000) {
      return { ok: false, error: "Audio is limited to 1MB on this path." };
    }
    return { ok: true, input: { audio: Array.from(args.file.bytes) } };
  }
  if (kind === "vision") {
    if (!args.file) return { ok: false, error: "This model needs an image file." };
    return {
      ok: true,
      input: {
        image: bytesToBase64(args.file.bytes),
        prompt: args.prompt || "Describe this image.",
      },
    };
  }
  return {
    ok: true,
    input: {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: args.prompt },
      ],
      // A REASONING model spends budget thinking BEFORE it writes the answer,
      // so an unset cap is not "no limit", it is the platform default split
      // across both phases. @cf/zai-org/glm-4.7-flash exhausted that default
      // mid-thought and returned content: null with a populated `reasoning`,
      // which is how a raw envelope reached a public channel. The budget has
      // to cover thinking AND answering. Discord truncates near 2000 chars,
      // so the answer itself cannot usefully be longer than this either.
      max_tokens: CHAT_MAX_TOKENS,
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** True when the reply carried reasoning but no answer. Not an answer itself. */
function readReasoning(row: Record<string, unknown>): string {
  if (!Array.isArray(row.choices) || row.choices.length === 0) return "";
  const first = row.choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const reasoning = (message as { reasoning?: unknown }).reasoning;
  return typeof reasoning === "string" ? reasoning : "";
}

/**
 * The model declining, which IS a response and not a failure to parse one.
 * An OpenAI-shaped reply carries it beside `content`, and the envelope from
 * the live failure had `refusal: null` right next to the null content, so this
 * path is one field away from the one that already bit us.
 */
function readRefusal(row: Record<string, unknown>): string {
  if (!Array.isArray(row.choices) || row.choices.length === 0) return "";
  const first = row.choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const refusal = (message as { refusal?: unknown }).refusal;
  return typeof refusal === "string" && refusal.trim() ? refusal : "";
}

function readChoice(row: Record<string, unknown>): string {
  if (!Array.isArray(row.choices) || row.choices.length === 0) return "";
  const first = row.choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown; text?: unknown }).message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    // `reasoning` is the model thinking out loud. It is deliberately NOT
    // returned here: promoting it to an answer prints an internal monologue
    // that restates the user's own question back at them. readReasoning()
    // reports it separately so the caller can say WHY there is no answer.
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return typeof (first as { text?: unknown }).text === "string" ? (first as { text: string }).text : "";
}

function stripDataUrl(value: string): string {
  return value.replace(/^data:[^,]*,/, "");
}

export function extractAnswer(result: unknown, task = ""): Answer {
  if (result == null) return { kind: "error", text: "The model returned nothing." };
  if (typeof result === "string") {
    if (taskKind(task) === "image" && result.length > 80) {
      return { kind: "file", caption: "Image.", filename: "image.png", mime: "image/png", base64: stripDataUrl(result) };
    }
    return { kind: "text", text: result };
  }
  if (typeof result !== "object") return { kind: "text", text: String(result) };
  const row = result as Record<string, unknown>;
  if (typeof row.error === "string" && row.error) return { kind: "error", text: row.error };
  if (Array.isArray(row.errors) && row.errors.length > 0) {
    return { kind: "error", text: JSON.stringify(row.errors).slice(0, 500) };
  }
  const text = firstString(row, ["response", "result", "text", "description", "summary", "translated_text", "transcription"]);
  if (typeof row.image === "string") {
    return {
      kind: "file",
      caption: text || "Image.",
      filename: "image.png",
      mime: "image/png",
      base64: stripDataUrl(row.image),
    };
  }
  if (typeof row.audio === "string") {
    return {
      kind: "file",
      caption: text || "Audio.",
      filename: "speech.mp3",
      mime: "audio/mpeg",
      base64: stripDataUrl(row.audio),
    };
  }
  const choice = readChoice(row);
  if (choice) return { kind: "text", text: choice };
  if (text) return { kind: "text", text };
  if (Array.isArray(row.data) && row.data.length > 0 && Array.isArray(row.data[0])) {
    const dims = (row.data[0] as unknown[]).length;
    return { kind: "text", text: `Embedding, ${row.data.length} vector(s), ${dims} dimensions.` };
  }
  if (Array.isArray(row.data) && row.data.every((item) => typeof item === "number")) {
    return { kind: "text", text: `Embedding, ${row.data.length} dimensions.` };
  }
  // NEVER print the raw envelope. It carries the provider's object shape,
  // model and request ids, and whatever else the provider chose to include,
  // into whatever channel asked. An unreadable reply is a short sentence here
  // and a journalled event; the detail belongs in the log, not the chat.
  // A refusal is the model ANSWERING, so it is reported before anything that
  // explains a missing answer. Reported without the text in the log, because
  // a refusal is model output and this bot does not journal that.
  const refusal = readRefusal(row);
  if (refusal) {
    console.log(JSON.stringify({ event: "answer_refused" }));
    return { kind: "error", text: `The model declined: ${refusal}` };
  }
  const reasoning = readReasoning(row);
  console.log(JSON.stringify({
    event: "answer_unreadable",
    keys: Object.keys(row).slice(0, 12),
    had_reasoning: reasoning.length > 0,
  }));
  if (reasoning) {
    return {
      kind: "error",
      text: "The model spent its whole budget thinking and never wrote an answer. Try a shorter question, or pin a different model with /model.",
    };
  }
  return { kind: "error", text: "I could not read the model's reply." };
}

type GatewayRun = (
  model: string,
  input: Record<string, unknown>,
  options?: { gateway?: { id: string; skipCache?: boolean } },
) => Promise<unknown>;

// Model ids come from the live catalog, which is wider than the pinned
// workers-types union. The call still goes through the AI binding.
export async function runCloudflare(
  ai: Ai,
  model: string,
  input: Record<string, unknown>,
  gatewayId: string,
): Promise<unknown> {
  // Call through the binding, so `this` inside the AI binding IS the binding.
  // Hoisting `ai.run` into a local and calling it bare detaches the receiver,
  // and the binding's own `run` then assigns to a private field on undefined:
  // "Cannot set properties of undefined (setting '#options')" thrown from
  // cloudflare-internal:ai-api. The cast has to land on the OBJECT so the
  // gateway option stays typed without losing the receiver.
  const gateway = ai as unknown as { run: GatewayRun };
  return gateway.run(model, input, { gateway: { id: gatewayId, skipCache: true } });
}
