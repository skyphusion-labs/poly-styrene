import { describe, expect, it, vi } from "vitest";
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

  // The test above passes whether or not the call keeps its receiver, because
  // its stub is an ARROW function and never touches `this`. A detached arrow
  // behaves exactly like a bound one, so the stub could not fail the way the
  // real binding fails. In production every /ask on the Workers AI path threw
  // "Cannot set properties of undefined (setting '#options')" from
  // cloudflare-internal:ai-api, because the real binding assigns to a private
  // field on `this` and `this` was undefined.
  //
  // This stub uses a private field for exactly that reason: it is the smallest
  // thing that can tell a bound call from a detached one.
  it("calls run ON the binding, so the receiver survives", async () => {
    class FakeAi {
      #seen: unknown[] = [];
      async run(model: string, input: unknown, options: unknown): Promise<unknown> {
        this.#seen.push({ model, input, options });
        return { response: "ok" };
      }
      seen(): unknown[] {
        return this.#seen;
      }
    }
    const binding = new FakeAi();
    const result = await runCloudflare(binding as unknown as Ai, "author/model", { messages: [] }, "poly-styrene");
    expect(result).toEqual({ response: "ok" });
    expect(binding.seen()).toEqual([
      {
        model: "author/model",
        input: { messages: [] },
        options: { gateway: { id: "poly-styrene", skipCache: true } },
      },
    ]);
  });
});

describe("a reasoning model that never wrote an answer", () => {
  // The real envelope from the live failure, 2026-10-23: content is null and
  // the model's thinking sits in `reasoning`. Before this guard, extractAnswer
  // fell through to JSON.stringify and printed the whole thing into a public
  // Discord channel. A well-formed fixture passes on that defect, which is why
  // this one is shaped from what actually came back.
  const envelope = {
    id: "chatcmpl-898ca21459b6f566",
    object: "chat.completion",
    model: "@cf/zai-org/glm-4.7-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          reasoning: "1. Analyze the User's Request: The user is asking ...",
        },
      },
    ],
  };

  it("does not print the raw envelope", () => {
    const out = extractAnswer(envelope);
    expect(out.text).not.toContain("chatcmpl-");
    expect(out.text).not.toContain("chat.completion");
    expect(out.text).not.toContain("@cf/zai-org");
  });

  it("does not present the model's reasoning as the answer", () => {
    const out = extractAnswer(envelope);
    expect(out.text).not.toContain("Analyze the User's Request");
  });

  it("says why there is no answer", () => {
    const out = extractAnswer(envelope);
    expect(out.kind).toBe("error");
    expect(out.text.toLowerCase()).toContain("budget");
  });

  it("still reads a normal reply", () => {
    const ok = extractAnswer({ choices: [{ message: { content: "hello" } }] });
    expect(ok.kind).toBe("text");
    expect(ok.text).toBe("hello");
  });
});

describe("the chat path carries a token budget", () => {
  it("sets max_tokens so reasoning cannot consume the whole reply", () => {
    const built = buildWorkersInput({
      task: "Text Generation",
      prompt: "hi",
      sourceLang: "",
      targetLang: "",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect((built.input as { max_tokens?: number }).max_tokens).toBeGreaterThan(0);
  });
});

describe("the unreadable path, which the reasoning fixture cannot reach", () => {
  // The fixture in the suite above carries `reasoning`, so it takes the
  // budget branch and never reaches the final fallback. Measured on
  // fab9706: reinstating `JSON.stringify(result)` as that fallback left the
  // whole suite GREEN. This envelope has no reasoning, so it is the only
  // thing that pins the branch where the raw dump used to live.
  const opaque = { id: "chatcmpl-zzz", object: "chat.completion", model: "@cf/some/model", weird: { nested: 1 } };

  it("does not print the raw envelope when there is no reasoning either", () => {
    const out = extractAnswer(opaque);
    expect(out.kind).toBe("error");
    expect(out.text).not.toContain("chatcmpl-");
    expect(out.text).not.toContain("chat.completion");
    expect(out.text).not.toContain("nested");
    expect(out.text).not.toContain("{");
  });

  it("says plainly that it could not read the reply", () => {
    expect(extractAnswer(opaque).text).toBe("I could not read the model's reply.");
  });
});

describe("a model that declines", () => {
  // `refusal` sat right beside the null content in the envelope from the live
  // failure, so this path is one field away from the one that already bit us.
  // Before this, a decline was reported as "I could not read the model's
  // reply", which blames us for something the model actually answered.
  const declined = {
    id: "chatcmpl-ref",
    choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "I cannot help with that." } }],
  };

  it("reports the decline, not a parse failure", () => {
    const out = extractAnswer(declined);
    expect(out.text).toContain("I cannot help with that.");
    expect(out.text).toContain("declined");
    expect(out.text).not.toContain("could not read");
  });

  it("prefers the decline over the budget explanation, since a refusal is not an exhausted budget", () => {
    const both = {
      choices: [
        { message: { content: null, refusal: "No.", reasoning: "thinking about whether to answer" } },
      ],
    };
    const out = extractAnswer(both);
    expect(out.text).toContain("No.");
    expect(out.text).not.toContain("budget");
  });

  it("ignores a blank or non-string refusal", () => {
    expect(extractAnswer({ choices: [{ message: { content: null, refusal: "   " } }] }).text).toBe(
      "I could not read the model's reply.",
    );
    expect(extractAnswer({ choices: [{ message: { content: null, refusal: 7 } }] }).text).toBe(
      "I could not read the model's reply.",
    );
  });

  it("still lets real content win over a refusal field", () => {
    const out = extractAnswer({ choices: [{ message: { content: "the answer", refusal: "No." } }] });
    expect(out.kind).toBe("text");
    expect(out.text).toBe("the answer");
  });
});

describe("the chat token budget is adequate, not merely present", () => {
  // Measured on fab9706: `toBeGreaterThan(0)` passed with max_tokens set to 1,
  // so the existing assertion could not tell a working budget from a token.
  // A FLOOR is asserted rather than the exact value, so tuning the number
  // stays allowed and slashing it does not.
  it("leaves room for thinking AND answering", () => {
    const built = buildWorkersInput({ task: "Text Generation", prompt: "hi", sourceLang: "", targetLang: "" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const budget = (built.input as { max_tokens?: unknown }).max_tokens;
    expect(typeof budget).toBe("number");
    expect(budget as number).toBeGreaterThanOrEqual(1024);
  });

  // Only a live call against the real model proves the budget is big enough.
  // This asserts the DECISION was made, which is what regressed: the chat path
  // shipped with no cap at all while the RunPod path had one.
  it("is set on the chat path at all, which is what was missing", () => {
    const built = buildWorkersInput({ task: "Text Generation", prompt: "hi", sourceLang: "", targetLang: "" });
    expect(built.ok && "max_tokens" in built.input).toBe(true);
  });
});

describe("the log carries no model output", () => {
  // CLAUDE.md states that no prompt and no answer is persisted by this Worker,
  // including to a log line. That was a comment and a convention with nothing
  // enforcing it: measured on this branch, adding the refusal text to the
  // answer_refused event left the suite green. These pin the two log lines
  // that sit closest to model output, because they are the ones handling it.
  function captureLogs(run: () => void): string[] {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      run();
      return spy.mock.calls.map((call) => String(call[0]));
    } finally {
      spy.mockRestore();
    }
  }

  it("does not log a refusal, which is the model speaking", () => {
    const secret = "I cannot help with that particular exploit.";
    const lines = captureLogs(() => {
      extractAnswer({ choices: [{ message: { content: null, refusal: secret } }] });
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("exploit");
    }
    expect(lines.join(" ")).toContain("answer_refused");
  });

  it("does not log reasoning or content on an unreadable reply", () => {
    const thinking = "1. Analyze the User's Request about port scanning";
    const lines = captureLogs(() => {
      extractAnswer({ id: "chatcmpl-1", choices: [{ message: { content: null, reasoning: thinking } }] });
    });
    for (const line of lines) {
      expect(line).not.toContain(thinking);
      expect(line).not.toContain("port scanning");
    }
    // The shape is what gets journalled: key names and a boolean, never text.
    const joined = lines.join(" ");
    expect(joined).toContain("answer_unreadable");
    expect(joined).toContain("had_reasoning");
  });
});
