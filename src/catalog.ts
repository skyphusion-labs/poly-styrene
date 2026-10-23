import type { Env, Provider } from "./env";
import { selectValue } from "./text";

export const CATALOG_KEY = "catalog:v1";
export const PAGE_SIZE = 25;

export type ModelCard = {
  id: string;
  provider: Provider;
  task: string;
  name: string;
  description: string;
  price: string;
};

export type CatalogFile = {
  refreshedAt: string;
  models: ModelCard[];
};

export type ModelQuery = {
  provider?: string;
  task?: string;
  search?: string;
};

export type ModelPage = {
  items: ModelCard[];
  page: number;
  pages: number;
  total: number;
};

const TASK_RANK: Record<string, number> = {
  "text generation": 0,
  "text-to-image": 1,
  translation: 2,
  summarization: 3,
  "text classification": 4,
  "automatic speech recognition": 5,
  "text-to-speech": 6,
  "image-to-text": 7,
  "text embeddings": 8,
};

function taskRank(task: string): number {
  return TASK_RANK[task.toLowerCase()] ?? 50;
}

export function priceText(properties: unknown): string {
  if (!Array.isArray(properties)) return "";
  const found = properties.find(
    (item) => item && typeof item === "object" && (item as { property_id?: string }).property_id === "price",
  ) as { value?: unknown } | undefined;
  if (!found || !Array.isArray(found.value) || found.value.length === 0) return "";
  const first = found.value[0] as { price?: unknown; unit?: unknown };
  if (typeof first.price !== "number" || typeof first.unit !== "string") return "";
  return `$${first.price} ${first.unit}`.slice(0, 80);
}

export function normalizeWorkersModel(raw: unknown): ModelCard | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { name?: unknown; description?: unknown; task?: unknown; properties?: unknown };
  if (typeof row.name !== "string" || row.name.length === 0) return null;
  let task = "Unknown";
  if (row.task && typeof row.task === "object" && typeof (row.task as { name?: unknown }).name === "string") {
    task = (row.task as { name: string }).name;
  }
  const description = typeof row.description === "string" ? row.description.slice(0, 180) : "";
  return {
    id: row.name,
    provider: "cloudflare",
    task,
    name: row.name,
    description,
    price: priceText(row.properties),
  };
}

export function ollamaCard(model: string): ModelCard {
  return {
    id: model,
    provider: "ollama",
    task: "Text Generation",
    name: model,
    description: "RunPod serverless Ollama. GPU time bills while the worker is up.",
    price: "",
  };
}

export function mergeOllama(models: ModelCard[], ollamaModel: string): ModelCard[] {
  if (!ollamaModel) return models;
  if (models.some((model) => model.provider === "ollama" && model.id === ollamaModel)) return models;
  return [ollamaCard(ollamaModel), ...models];
}

export function queryModels(models: ModelCard[], query: ModelQuery): ModelCard[] {
  const provider = (query.provider ?? "").trim().toLowerCase();
  const task = (query.task ?? "").trim().toLowerCase();
  const search = (query.search ?? "").trim().toLowerCase();
  const matched = models.filter((model) => {
    if (provider && provider !== "all" && model.provider !== provider) return false;
    if (task && model.task.toLowerCase() !== task) return false;
    if (!search) return true;
    const hay = `${model.id} ${model.name} ${model.task} ${model.description}`.toLowerCase();
    return hay.includes(search);
  });
  matched.sort((a, b) => taskRank(a.task) - taskRank(b.task) || a.id.localeCompare(b.id));
  return matched;
}

export function pageModels(models: ModelCard[], page: number, size = PAGE_SIZE): ModelPage {
  const pages = Math.max(1, Math.ceil(models.length / size));
  const current = Math.min(Math.max(1, page || 1), pages);
  const start = (current - 1) * size;
  return {
    items: models.slice(start, start + size),
    page: current,
    pages,
    total: models.length,
  };
}

export function findModel(models: ModelCard[], raw: string): ModelCard | undefined {
  return models.find((model) => model.id === raw || selectValue(model.id) === raw);
}

export function modelFromId(raw: string): ModelCard | null {
  const id = raw.trim();
  if (!id || id.length > 200) return null;
  if (id.startsWith("@cf/") || /^[a-z0-9.-]+\/[A-Za-z0-9._:-]+$/.test(id)) {
    return {
      id,
      provider: "cloudflare",
      task: "Text Generation",
      name: id,
      description: "Pinned by id. Not in the cached catalog.",
      price: "",
    };
  }
  if (/^[A-Za-z0-9._:-]+$/.test(id) && id.includes(":")) {
    return ollamaCard(id);
  }
  return null;
}

export async function readCatalog(env: Env): Promise<CatalogFile> {
  const raw = await env.CATALOG.get(CATALOG_KEY);
  let file: CatalogFile = { refreshedAt: "", models: [] };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CatalogFile;
      if (parsed && Array.isArray(parsed.models)) {
        file = { refreshedAt: parsed.refreshedAt ?? "", models: parsed.models };
      }
    } catch {
      file = { refreshedAt: "", models: [] };
    }
  }
  return { refreshedAt: file.refreshedAt, models: mergeOllama(file.models, env.OLLAMA_MODEL) };
}
