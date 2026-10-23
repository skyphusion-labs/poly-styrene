import { extractAnswer, type Answer } from "./infer";
import { SYSTEM_PROMPT } from "./prompt";

export function ollamaChatBody(model: string, prompt: string): unknown {
  return {
    input: {
      openai_route: "/v1/chat/completions",
      openai_input: {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        stream: false,
        max_tokens: 800,
      },
    },
  };
}

export type JobView =
  | { state: "pending" }
  | { state: "done"; answer: Answer }
  | { state: "failed"; error: string };

// return_aggregate_stream on the Ollama worker wraps one yielded object in an array.
export function parseOllamaOutput(output: unknown): Answer {
  let value = output;
  if (value && typeof value === "object" && "status" in value && "output" in value) {
    value = (value as { output: unknown }).output;
  }
  if (Array.isArray(value)) {
    const objects = value.filter((item) => item && typeof item === "object");
    value = objects.length > 0 ? objects[objects.length - 1] : value[value.length - 1];
  }
  return extractAnswer(value, "Text Generation");
}

export function interpretRunpod(payload: unknown): JobView {
  if (!payload || typeof payload !== "object") return { state: "failed", error: "Empty GPU status." };
  const row = payload as { status?: unknown; output?: unknown; error?: unknown };
  const status = typeof row.status === "string" ? row.status.toUpperCase() : "";
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") return { state: "pending" };
  if (status === "COMPLETED") {
    const answer = parseOllamaOutput(row.output);
    if (answer.kind === "file") {
      return { state: "done", answer: { kind: "text", text: answer.caption || "The GPU returned a file." } };
    }
    if (answer.kind === "text" && answer.text.length > 8000) {
      return {
        state: "done",
        answer: { kind: "text", text: answer.text.slice(0, 8000) + "\n\n(I cut this short to fit Discord.)" },
      };
    }
    return { state: "done", answer };
  }
  if (status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT") {
    const error = typeof row.error === "string" && row.error ? row.error : status.toLowerCase();
    return { state: "failed", error };
  }
  return { state: "failed", error: status || "Unknown GPU status." };
}
