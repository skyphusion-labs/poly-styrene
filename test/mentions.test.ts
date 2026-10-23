import { describe, expect, it } from "vitest";
import { postDiscordMessage, publishAnswer } from "../src/discord_rest";

// Model output posts publicly into a channel, so a mention in it would ping
// real people. `allowed_mentions: { parse: [] }` on every outbound path is what
// stops that.
//
// This file exists because that protection was lost in production once, on
// 2026-10-23, for about twenty minutes: it lived only in an uncommitted
// working tree, so deploying `main` removed it and no diff showed anything,
// because the content had never been committed. It was restored by
// poly-styrene#13, which changed `src/discord_rest.ts` and nothing else, so
// nothing could observe it going missing a second time.
//
// Kept separate from `test/rest.test.ts` on purpose. That file is about the
// REST client formatting requests correctly; this one pins a safety property
// that has already been lost once. Separate also means this adds no conflict
// to the uncommitted tree, which carries its own assertions in `rest.test.ts`.
// Two guards on a twice-lost invariant is not duplication worth removing.

function capture() {
  const bodies: BodyInit[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.body !== undefined && init.body !== null) bodies.push(init.body);
    return new Response("{}", { status: 200 });
  };
  return { bodies, fetchImpl };
}

function parsed(body: BodyInit): Record<string, unknown> {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  const payload = (body as FormData).get("payload_json");
  return JSON.parse(String(payload)) as Record<string, unknown>;
}

// Asserted as parsed STRUCTURE rather than as a substring, so a malformed or
// renamed field cannot pass by appearing somewhere in the text.
function assertSuppressed(body: BodyInit) {
  const json = parsed(body);
  expect(json.allowed_mentions).toEqual({ parse: [] });
}

describe("outbound Discord messages suppress every mention", () => {
  it("suppresses mentions on the JSON path, including every followup chunk", async () => {
    const { bodies, fetchImpl } = capture();
    // Long enough to force more than one message, so a followup is covered too
    // and not just the first PATCH.
    await publishAnswer({ applicationId: "app", interactionToken: "tok", text: "z".repeat(4200) }, fetchImpl);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) assertSuppressed(body);
  });

  it("suppresses mentions on the multipart path", async () => {
    const { bodies, fetchImpl } = capture();
    await publishAnswer(
      {
        applicationId: "app",
        interactionToken: "tok",
        text: "here",
        files: [{ filename: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }],
      },
      fetchImpl,
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) assertSuppressed(body);
  });

  it("suppresses mentions on a direct followup post", async () => {
    const { bodies, fetchImpl } = capture();
    await postDiscordMessage(
      { applicationId: "app", interactionToken: "tok", content: "hi", followup: true },
      fetchImpl,
    );
    expect(bodies).toHaveLength(1);
    assertSuppressed(bodies[0] as BodyInit);
  });

  // The failure this guards against is a payload that mentions someone, so it
  // is worth proving with text that WOULD ping if the field were absent.
  it("suppresses a role and user mention carried in model output", async () => {
    const { bodies, fetchImpl } = capture();
    await postDiscordMessage(
      {
        applicationId: "app",
        interactionToken: "tok",
        content: "ping <@&123456789> and <@987654321> and @everyone",
        followup: false,
      },
      fetchImpl,
    );
    const json = parsed(bodies[0] as BodyInit);
    expect(json.content).toContain("<@&123456789>");
    expect(json.allowed_mentions).toEqual({ parse: [] });
  });
});
