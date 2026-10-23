import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, chunkDiscord, formatReply, selectValue } from "../src/text";

describe("text", () => {
  it("keeps a short select value and hashes a long one", () => {
    expect(selectValue("qwen2.5-coder:7b")).toBe("qwen2.5-coder:7b");
    const long = "x".repeat(101);
    const hashed = selectValue(long);
    expect(hashed).toMatch(/^h:[0-9a-f]{8}$/);
    expect(selectValue(long)).toBe(hashed);
    expect(selectValue(`${long}y`)).not.toBe(hashed);
  });

  it("prefixes the model and clips a long body", () => {
    expect(formatReply("a`b", "hello")).toBe("Poly Styrene, `ab`\nhello");
    const body = "y".repeat(8001);
    const reply = formatReply("m", body);
    expect(reply.startsWith("Poly Styrene, `m`\n")).toBe(true);
    expect(reply.endsWith("(I cut this short to fit Discord.)")).toBe(true);
    expect(reply.length).toBeLessThan(8200);
  });

  it("round-trips bytes and strips a data url", () => {
    const bytes = new Uint8Array([0, 1, 255, 32]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([0, 1, 255, 32]);
    expect([...base64ToBytes(`data:image/png;base64,${bytesToBase64(bytes)}`)]).toEqual([0, 1, 255, 32]);
  });

  it("splits long text under the discord cap and balances fences", () => {
    expect(chunkDiscord("")).toEqual(["(The model returned nothing.)"]);
    expect(chunkDiscord("hi")).toEqual(["hi"]);
    const chunks = chunkDiscord("z".repeat(4000), 1900);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    const fenced = `\`\`\`\n${"b".repeat(2000)}\n\`\`\``;
    const parts = chunkDiscord(fenced, 1900);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.endsWith("```")).toBe(true);
    expect(parts[1]?.startsWith("```")).toBe(true);
  });
});
