import { describe, expect, it } from "vitest";
import { fetchWorkersModels, refreshCatalog } from "../src/refresh";
import { testEnv } from "./fakes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("refresh", () => {
  it("pages the search api and drops a duplicate id", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input));
      const header = new Headers(init?.headers).get("authorization");
      expect(header).toBe("Bearer test-token");
      if (urls.length === 1) {
        return jsonResponse({
          result: [
            { name: "@cf/a", task: { name: "Text Generation" }, description: "a" },
            { name: "@cf/a", task: { name: "Text Generation" } },
          ],
          result_info: { total_count: 2 },
        });
      }
      return jsonResponse({
        result: [{ name: "@cf/b", task: { name: "Translation" } }],
        result_info: { total_count: 2 },
      });
    };
    const models = await fetchWorkersModels("account", "test-token", fetchImpl);
    expect(models.map((model) => model.id)).toEqual(["@cf/a", "@cf/b"]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/accounts/account/ai/models/search?");
  });

  it("fails with the status and not the token", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ errors: [{ message: "no" }] }, 500);
    await expect(fetchWorkersModels("account", "test-token", fetchImpl)).rejects.toThrow("model search failed: 500");
  });

  it("does not fetch when the catalog token is missing", async () => {
    const { env } = testEnv();
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    expect(await refreshCatalog(env, fetchImpl)).toEqual({ error: "catalog token is not set" });
    expect(called).toBe(false);
  });

  it("writes the catalog", async () => {
    const { env, catalog } = testEnv({ CATALOG_TOKEN: "test-token" });
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        result: [{ name: "@cf/a", task: { name: "Text Generation" }, description: "a" }],
        result_info: { total_count: 1 },
      });
    expect(await refreshCatalog(env, fetchImpl)).toEqual({ models: 1 });
    const stored = JSON.parse(catalog.dump.get("catalog:v1")?.value ?? "{}") as { models: { id: string }[] };
    expect(stored.models[0]?.id).toBe("@cf/a");
  });
});
