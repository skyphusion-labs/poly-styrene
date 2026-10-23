import { describe, expect, it } from "vitest";
import { buildWorkersInput, extractAnswer, preflight, runCloudflare, taskKind } from "../src/infer";
import { SYSTEM_PROMPT } from "../src/prompt";

describe("infer", () => {
  it("classifies tasks", () => {
    expect(taskKind("Text Generation")).toBe("chat");
    expect(taskKind("Text-to-Image")).toBe("image");
    expect(taskKind("Translation")).toBe("translation");
    expect(taskKind("Summarization")).toBe("summary");
    expect(taskKind("Text Embeddings")).toBe("embed");
    expect(taskKind("Text Classification")).toBe("class");
    expect(taskKind("Automatic Speech Recognition")).toBe("asr");
    expect(taskKind("Text-to-Speech")).toBe("tts");
    expect(taskKind("Image-to-Text")).toBe("vision");
    expect(taskKind("Something else")).toBe("other");
  });

  it("rejects a translation or a file model before the call", () => {
    expect(preflight("Translation", { hasFile: false, sourceLang: "", targetLang: "es" })).toMatch(/source_lang/);
    expect(preflight("Translation", { hasFile: false, sourceLang: "en", targetLang: "es" })).toBeNull();
    expect(preflight("Automatic Speech Recognition", { hasFile: false, sourceLang: "", targetLang: "" })).toMatch(/file/);
    expect(preflight("Text Generation", { hasFile: false, sourceLang: "", targetLang: "" })).toBeNull();
  });

  it("builds the input shape for each task", () => {
    const chat = buildWorkersInput({ task: "Text Generation", prompt: "hi", sourceLang: "", targetLang: "" });
    expect(chat.ok && chat.input.messages).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "hi" },
    ]);
    const image = buildWorkersInput({ task: "Text-to-Image", prompt: "a cat", sourceLang: "", targetLang: "" });
    expect(image.ok && image.input).toEqual({ prompt: "a cat" });
    const translation = buildWorkersInput({ task: "Translation", prompt: "hola", sourceLang: "es", targetLang: "en" });
    expect(translation.ok && translation.input).toEqual({ text: "hola", source_lang: "es", target_lang: "en" });
    const audio = new Uint8Array([1, 2, 3]);
    const asr = buildWorkersInput({
      task: "Automatic Speech Recognition",
      prompt: "",
      sourceLang: "",
      targetLang: "",
      file: { bytes: audio, mime: "audio/wav" },
    });
    expect(asr.ok && asr.input.audio).toEqual([1, 2, 3]);
    const big = buildWorkersInput({
      task: "Automatic Speech Recognition",
      prompt: "",
      sourceLang: "",
      targetLang: "",
      file: { bytes: new Uint8Array(1_000_001), mime: "audio/wav" },
    });
    expect(big.ok).toBe(false);
    const vision = buildWorkersInput({
      task: "Image-to-Text",
      prompt: "",
      sourceLang: "",
      targetLang: "",
      file: { bytes: new Uint8Array([9]), mime: "image/png" },
    });
    expect(vision.ok && typeof vision.input.image).toBe("string");
    expect(vision.ok && vision.input.prompt).toBe("Describe this image.");
  });

  it("reads the common result shapes", () => {
    expect(extractAnswer("plain")).toEqual({ kind: "text", text: "plain" });
    expect(extractAnswer({ response: "r" }).kind).toBe("text");
    expect(extractAnswer({ translated_text: "t" })).toMatchObject({ text: "t" });
    expect(extractAnswer({ choices: [{ message: { content: "c" } }] })).toMatchObject({ text: "c" });
    expect(extractAnswer({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] })).toMatchObject({ text: "a\nb" });
    expect(extractAnswer({ image: "aaaa" })).toMatchObject({ kind: "file", filename: "image.png" });
    expect(extractAnswer({ audio: "bbbb" })).toMatchObject({ filename: "speech.mp3" });
    expect(extractAnswer("x".repeat(81), "Text-to-Image")).toMatchObject({ kind: "file" });
    expect(extractAnswer({ error: "nope" })).toEqual({ kind: "error", text: "nope" });
    expect(extractAnswer({ data: [[1, 2, 3]] }).text).toMatch(/3 dimensions/);
    expect(extractAnswer({ data: [1, 2] }).text).toMatch(/2 dimensions/);
    expect(extractAnswer(null)).toMatchObject({ kind: "error" });
  });

  it("sends the call through the named gateway", async () => {
    const calls: unknown[] = [];
    const ai = {
      run: async (model: string, input: unknown, options: unknown) => {
        calls.push({ model, input, options });
        return { response: "ok" };
      },
    };
    const result = await runCloudflare(ai as unknown as Ai, "author/model", { messages: [] }, "poly-styrene");
    expect(result).toEqual({ response: "ok" });
    expect(calls[0]).toEqual({
      model: "author/model",
      input: { messages: [] },
      options: { gateway: { id: "poly-styrene", skipCache: true } },
    });
  });
});
