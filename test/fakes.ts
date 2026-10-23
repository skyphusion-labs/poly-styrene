import type { AskParams, Env } from "../src/env";

type Row = {
  guild_id: string;
  channel_id: string;
  user_id: string;
  provider: string;
  model_id: string;
  task: string;
  updated_at: string;
};

export function memoryKv() {
  const dump = new Map<string, { value: string; expirationTtl?: number }>();
  const kv = {
    async get(key: string) {
      return dump.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      dump.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
    async delete(key: string) {
      dump.delete(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, dump };
}

export function memoryDb() {
  const rows: Row[] = [];
  const db = {
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (!text.startsWith("SELECT")) throw new Error(`unexpected sql: ${text.slice(0, 40)}`);
              const [guild, channel, user] = args;
              const row = rows.find((item) => item.guild_id === guild && item.channel_id === channel && item.user_id === user);
              return (row ?? null) as T | null;
            },
            async run() {
              if (text.startsWith("INSERT")) {
                const [guild_id, channel_id, user_id, provider, model_id, task, updated_at] = args as string[];
                const row = { guild_id, channel_id, user_id, provider, model_id, task, updated_at };
                const existing = rows.find(
                  (item) => item.guild_id === guild_id && item.channel_id === channel_id && item.user_id === user_id,
                );
                if (existing) Object.assign(existing, row);
                else rows.push(row);
                return { success: true };
              }
              if (text.startsWith("DELETE")) {
                const [guild, channel, user] = args;
                const index = rows.findIndex((item) => item.guild_id === guild && item.channel_id === channel && item.user_id === user);
                if (index >= 0) rows.splice(index, 1);
                return { success: true };
              }
              throw new Error(`unexpected sql: ${text.slice(0, 40)}`);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, rows };
}

export function memoryAsk() {
  const created: { id: string; params: AskParams }[] = [];
  const binding = {
    async create(options?: { id?: string; params?: AskParams }) {
      const id = options?.id ?? "";
      if (!id) throw new Error("missing id");
      if (created.some((item) => item.id === id)) throw new Error("instance already exists");
      created.push({ id, params: options?.params as AskParams });
    },
  };
  return { binding: binding as unknown as Workflow<AskParams>, created };
}

export function testEnv(over: Partial<Env> = {}) {
  const catalog = memoryKv();
  const pins = memoryDb();
  const ask = memoryAsk();
  const env = {
    AI: {},
    DB: pins.db,
    CATALOG: catalog.kv,
    ASK: ask.binding,
    GATEWAY_ID: "poly-styrene",
    ACCOUNT_ID: "account",
    DEFAULT_MODEL: "@cf/zai-org/glm-4.7-flash",
    DEFAULT_TASK: "Text Generation",
    OLLAMA_MODEL: "qwen2.5-coder:7b",
    RUNPOD_ENDPOINT_ID: "",
    ...over,
  } as Env;
  return { env, catalog, pins, ask };
}
