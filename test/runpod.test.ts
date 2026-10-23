import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/prompt";
import { interpretRunpod, ollamaChatBody, parseOllamaOutput } from "../src/runpod";

describe("runpod", () => {
  it("builds an openai chat body for the ollama worker", () => {
    const body = ollamaChatBody("qwen2.5-coder:7b", "hi") as {
      input: { openai_route: string; openai_input: { model: string; stream: boolean; max_tokens: number; messages: { content: string }[] } };
    };
    expect(body.input.openai_route).toBe("/v1/chat/completions");
    expect(body.input.openai_input.model).toBe("qwen2.5-coder:7b");
    expect(body.input.openai_input.stream).toBe(false);
    expect(body.input.openai_input.max_tokens).toBe(800);
    expect(body.input.openai_input.messages[0]?.content).toBe(SYSTEM_PROMPT);
  });

  it("unwraps an aggregated stream and maps job status", () => {
    const answer = parseOllamaOutput({
      status: "COMPLETED",
      output: [{ choices: [{ message: { content: "first" } }] }, { choices: [{ message: { content: "last" } }] }],
    });
    expect(answer).toMatchObject({ kind: "text", text: "last" });
    expect(interpretRunpod({ status: "IN_QUEUE" })).toEqual({ state: "pending" });
    expect(interpretRunpod({ status: "in_progress" })).toEqual({ state: "pending" });
    expect(interpretRunpod({ status: "COMPLETED", output: { response: "done" } })).toMatchObject({
      state: "done",
      answer: { text: "done" },
    });
    const long = interpretRunpod({ status: "COMPLETED", output: { response: "z".repeat(8001) } });
    expect(long.state === "done" && long.answer.kind === "text" && long.answer.text.length).toBeLessThan(8100);
    const file = interpretRunpod({ status: "COMPLETED", output: { image: "aaaa", description: "pic" } });
    expect(file.state === "done" && file.answer.kind === "text" && file.answer.text).toBe("pic");
    expect(interpretRunpod({ status: "FAILED", error: "boom" })).toEqual({ state: "failed", error: "boom" });
    expect(interpretRunpod({ status: "TIMED_OUT" }).state).toBe("failed");
    expect(interpretRunpod(null)).toMatchObject({ state: "failed" });
    expect(interpretRunpod({ status: "WEIRD" })).toMatchObject({ state: "failed", error: "WEIRD" });
  });
});
