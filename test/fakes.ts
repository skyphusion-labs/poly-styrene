import type { AskParams, Env, LabParams } from "../src/env";
import { encodeLabResult } from "../src/lab";
import type { LabRun } from "../src/lab";

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
  // Reads are recorded so a test can assert a key was NOT fetched. Removing a
  // round trip is invisible to an assertion about the response.
  const gets: string[] = [];
  const kv = {
    async get(key: string) {
      gets.push(key);
      return dump.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      dump.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
    async delete(key: string) {
      dump.delete(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, dump, gets };
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

export type LabRowFake = {
  id: string;
  user_id: string;
  guild_id: string;
  channel_id: string;
  instance: string;
  started_at: string;
  stopped_at: string | null;
  exit_reason: string | null;
};

/**
 * A D1 fake for the lab_sessions table.
 *
 * Kept separate from memoryDb rather than folded into it: the two tables are
 * read by different code and a single fake that guesses which one a statement
 * means would answer a question the real D1 never gets asked.
 */
export function memoryLabDb() {
  const rows: LabRowFake[] = [];
  const db = {
    prepare(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (text.startsWith("SELECT COUNT(*) AS n FROM lab_sessions")) {
                const [userId, since] = args as string[];
                const n = rows.filter((row) => row.user_id === userId && row.started_at >= since).length;
                return { n } as unknown as T;
              }
              throw new Error(`unexpected sql: ${text.slice(0, 60)}`);
            },
            async run() {
              if (text.startsWith("INSERT INTO lab_sessions")) {
                const [id, user_id, guild_id, channel_id, instance, started_at] = args as string[];
                if (!rows.some((row) => row.id === id)) {
                  rows.push({ id, user_id, guild_id, channel_id, instance, started_at, stopped_at: null, exit_reason: null });
                }
                return { success: true };
              }
              if (text.startsWith("UPDATE lab_sessions")) {
                const [stopped_at, exit_reason, id] = args as string[];
                const row = rows.find((item) => item.id === id && item.stopped_at === null);
                if (row) {
                  row.stopped_at = stopped_at;
                  row.exit_reason = exit_reason;
                }
                return { success: true };
              }
              if (text.startsWith("DELETE FROM lab_sessions")) {
                const [before] = args as string[];
                for (let i = rows.length - 1; i >= 0; i--) {
                  if ((rows[i] as LabRowFake).started_at < before) rows.splice(i, 1);
                }
                return { success: true };
              }
              throw new Error(`unexpected sql: ${text.slice(0, 60)}`);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, rows };
}

/**
 * SYNCHRONOUS ON PURPOSE, and that has a consequence worth knowing.
 *
 * `create` is declared `async` and has NO `await` in its body, so it runs to
 * completion synchronously. That makes it simple for the many tests that only
 * care WHETHER an instance was created, and it means those tests **cannot see
 * an await being removed**: moving the Workflow create from the response path
 * into `ctx.waitUntil` left all 150 tests green.
 *
 * So if you are asserting about ORDERING or TIMING rather than about the fact
 * of creation, do not use this. Build a fake that actually defers, locally in
 * the file that needs it, and see `test/ask_io.test.ts` for the working shape:
 * an explicitly released gate with a timeout backstop. `CLAUDE.md` has the
 * general rule under "What a fake has to be able to do".
 */
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

/**
 * SYNCHRONOUS ON PURPOSE, and that has a consequence worth knowing.
 *
 * `create` is declared `async` and has NO `await` in its body, so it runs to
 * completion synchronously. That makes it simple for the many tests that only
 * care WHETHER an instance was created, and it means those tests **cannot see
 * an await being removed**: moving the Workflow create from the response path
 * into `ctx.waitUntil` left all 150 tests green.
 *
 * So if you are asserting about ORDERING or TIMING rather than about the fact
 * of creation, do not use this. Build a fake that actually defers, locally in
 * the file that needs it, and see `test/ask_io.test.ts` for the working shape:
 * an explicitly released gate with a timeout backstop. `CLAUDE.md` has the
 * general rule under "What a fake has to be able to do".
 */
export function memoryLabRun() {
  const created: { id: string; params: LabParams }[] = [];
  const binding = {
    async create(options?: { id?: string; params?: LabParams }) {
      const id = options?.id ?? "";
      if (!id) throw new Error("missing id");
      if (created.some((item) => item.id === id)) throw new Error("instance already exists");
      created.push({ id, params: options?.params as LabParams });
    },
  };
  return { binding: binding as unknown as Workflow<LabParams>, created };
}

/** A sandbox Durable Object namespace fake that answers with a canned run. */
export function memoryLabNamespace(run: LabRun = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false }) {
  const asked: { name: string; body: string }[] = [];
  const namespace = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    getByName(name: string) {
      return {
        async fetch(input: RequestInfo, init?: RequestInit) {
          const body = typeof init?.body === "string" ? init.body : "";
          asked.push({ name, body });
          return new Response(encodeLabResult(run), { headers: { "content-type": "application/json" } });
        },
      } as unknown as DurableObjectStub;
    },
  };
  return { namespace: namespace as unknown as DurableObjectNamespace, asked };
}

export function testEnv(over: Partial<Env> = {}) {
  const catalog = memoryKv();
  const pins = memoryDb();
  const ask = memoryAsk();
  const labRun = memoryLabRun();
  const lab = memoryLabNamespace();
  const env = {
    AI: {},
    DB: pins.db,
    CATALOG: catalog.kv,
    ASK: ask.binding,
    LABRUN: labRun.binding,
    LAB: lab.namespace,
    GATEWAY_ID: "poly-styrene",
    ACCOUNT_ID: "account",
    DEFAULT_MODEL: "@cf/zai-org/glm-4.7-flash",
    DEFAULT_TASK: "Text Generation",
    OLLAMA_MODEL: "qwen2.5-coder:7b",
    RUNPOD_ENDPOINT_ID: "",
    LAB_ROLE_IDS: "",
    ...over,
  } as Env;
  return { env, catalog, pins, ask, labRun, lab };
}
