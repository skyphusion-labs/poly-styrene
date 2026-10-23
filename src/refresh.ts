import { CATALOG_KEY, normalizeWorkersModel, type CatalogFile, type ModelCard } from "./catalog";
import type { Env } from "./env";

const PER_PAGE = 50;
const MAX_PAGES = 30;

export async function fetchWorkersModels(
  accountId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCard[]> {
  const models: ModelCard[] = [];
  const seen = new Set<string>();
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; page <= MAX_PAGES && models.length < total; page++) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=${PER_PAGE}&page=${page}`;
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`model search failed: ${response.status}`);
    const body = (await response.json()) as {
      result?: unknown[];
      result_info?: { total_count?: number };
    };
    if (typeof body.result_info?.total_count === "number") total = body.result_info.total_count;
    const batch = Array.isArray(body.result) ? body.result : [];
    if (batch.length === 0) break;
    for (const item of batch) {
      const card = normalizeWorkersModel(item);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      models.push(card);
    }
  }
  return models;
}

export async function refreshCatalog(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ models: number } | { error: string }> {
  if (!env.CATALOG_TOKEN || !env.ACCOUNT_ID) return { error: "catalog token is not set" };
  try {
    const models = await fetchWorkersModels(env.ACCOUNT_ID, env.CATALOG_TOKEN, fetchImpl);
    const file: CatalogFile = { refreshedAt: new Date().toISOString(), models };
    await env.CATALOG.put(CATALOG_KEY, JSON.stringify(file));
    return { models: models.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "catalog refresh failed";
    console.log(JSON.stringify({ event: "catalog_refresh_failed", message }));
    return { error: message };
  }
}
