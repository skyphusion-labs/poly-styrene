import { describe, expect, it } from "vitest";
import { publishAnswer } from "../src/discord_rest";

describe("discord rest", () => {
  it("patches the original and posts the rest", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "", body: String(init?.body) });
      return new Response("{}", { status: 200 });
    };
    await publishAnswer(
      { applicationId: "app", interactionToken: "tok", text: "z".repeat(2000) },
      fetchImpl,
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe("https://discord.com/api/v10/webhooks/app/tok/messages/@original");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("https://discord.com/api/v10/webhooks/app/tok");
    expect(calls[0]?.body).toContain('"content"');
  });

  it("sends a file as multipart on the first message", async () => {
    let form: FormData | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      form = init?.body as FormData;
      return new Response("{}", { status: 200 });
    };
    await publishAnswer(
      {
        applicationId: "app",
        interactionToken: "tok",
        text: "pic",
        files: [{ filename: "image.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
      },
      fetchImpl,
    );
    expect(form).toBeInstanceOf(FormData);
    expect(String(form?.get("payload_json"))).toContain("pic");
    expect(form?.get("files[0]")).toBeInstanceOf(Blob);
  });

  it("throws the status without the webhook url", async () => {
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 400 });
    await expect(
      publishAnswer({ applicationId: "app", interactionToken: "secret-token", text: "hi" }, fetchImpl),
    ).rejects.toThrow("Discord 400: nope");
  });
});
