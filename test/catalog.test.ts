import { describe, expect, it } from "vitest";
import {
  findModel,
  mergeOllama,
  modelFromId,
  normalizeWorkersModel,
  pageModels,
  priceText,
  queryModels,
  readCatalog,
  type ModelCard,
} from "../src/catalog";
import { selectValue } from "../src/text";
import { testEnv } from "./fakes";

function card(id: string, task: string, provider: ModelCard["provider"] = "cloudflare"): ModelCard {
  return { id, provider, task, name: id, description: `${id} desc`, price: "" };
}

describe("catalog", () => {
  it("reads a price and a workers model name", () => {
    expect(priceText([{ property_id: "price", value: [{ price: 0.0605, unit: "per M input tokens" }] }])).toBe(
      "$0.0605 per M input tokens",
    );
    expect(priceText(null)).toBe("");
    const model = normalizeWorkersModel({
      id: "uuid-not-the-call-id",
      name: "@cf/zai-org/glm-4.7-flash",
      description: "fast",
      task: { name: "Text Generation" },
      properties: [],
    });
    expect(model?.id).toBe("@cf/zai-org/glm-4.7-flash");
    expect(normalizeWorkersModel({ id: "no name" })).toBeNull();
  });

  it("sorts text generation first and pages 25 at a time", () => {
    const models = [card("e", "Text Embeddings"), card("t", "Text Generation"), card("o", "Text Generation", "ollama")];
    const matched = queryModels(models, { search: "" });
    expect(matched.map((model) => model.id)).toEqual(["o", "t", "e"]);
    expect(queryModels(models, { provider: "ollama" }).map((model) => model.id)).toEqual(["o"]);
    expect(queryModels(models, { task: "text embeddings" }).map((model) => model.id)).toEqual(["e"]);
    const page = pageModels(Array.from({ length: 26 }, (_, i) => card(`m${i}`, "Text Generation")), 2);
    expect(page.pages).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(pageModels([], 9).page).toBe(1);
  });

  it("finds a model by id or select value and accepts a typed catalog id", () => {
    const long = `@cf/${"n".repeat(100)}`;
    const models = [card(long, "Text Generation")];
    expect(findModel(models, selectValue(long))?.id).toBe(long);
    expect(modelFromId("openai/gpt-5.5")?.provider).toBe("cloudflare");
    expect(modelFromId("@cf/foo/bar")?.task).toBe("Text Generation");
    // A typed colon id no longer reaches the GPU; see "a typed id cannot reach the GPU".
    expect(modelFromId("qwen2.5-coder:7b")).toBeNull();
    expect(modelFromId("hello")).toBeNull();
    expect(modelFromId("x".repeat(201))).toBeNull();
    expect(mergeOllama([card("qwen2.5-coder:7b", "Text Generation", "ollama")], "qwen2.5-coder:7b")).toHaveLength(1);
  });

  it("merges the configured ollama model when the cache is read", async () => {
    const { env, catalog } = testEnv();
    await catalog.kv.put(
      "catalog:v1",
      JSON.stringify({ refreshedAt: "t", models: [card("@cf/foo", "Text Generation")] }),
    );
    const file = await readCatalog(env);
    expect(file.models[0]?.id).toBe("qwen2.5-coder:7b");
    expect(file.models[1]?.id).toBe("@cf/foo");
    catalog.dump.set("catalog:v1", { value: "not json" });
    const broken = await readCatalog(env);
    expect(broken.models.map((model) => model.id)).toEqual(["qwen2.5-coder:7b"]);
  });
});

describe("a typed id cannot reach the GPU", () => {
  // Removed because any string with a colon reached the RunPod path, and
  // RUNPOD_API_KEY is set in production, so the spend gate passed. One GPU
  // cold start per request, from any member, rate-limited only by the 3s
  // cooldown. These cases are shaped from what an attacker would type, not
  // from a well-formed id.
  it("refuses an arbitrary colon id", () => {
    expect(modelFromId("anything:x")).toBeNull();
    expect(modelFromId("llama3:70b")).toBeNull();
    expect(modelFromId("a:b:c:d")).toBeNull();
  });

  it("still reaches the configured model, but through the CATALOG", () => {
    // This is the path that must keep working. mergeOllama() puts the one
    // configured model into the catalog and resolveCard() finds it there, so
    // removing the typed route costs nothing a user legitimately needs.
    const merged = mergeOllama([], "huihui_ai/foundation-sec-abliterated");
    expect(merged).toHaveLength(1);
    expect(merged[0].provider).toBe("ollama");
    // And typing that same id directly does NOT mint a card.
    expect(modelFromId("huihui_ai/foundation-sec-abliterated")).toBeNull();
  });

  it("still accepts a Workers AI catalog id", () => {
    const card = modelFromId("@cf/zai-org/glm-4.7-flash");
    expect(card).not.toBeNull();
    expect(card?.provider).toBe("cloudflare");
  });

  it("never returns an ollama provider from a typed id", () => {
    for (const probe of ["x:y", "@cf/a/b", "ns/name:tag", "huihui_ai/foundation-sec-abliterated"]) {
      expect(modelFromId(probe)?.provider ?? "cloudflare").not.toBe("ollama");
    }
  });
});
