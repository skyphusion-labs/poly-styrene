import type { LabLang } from "./lab";

export type Provider = "cloudflare" | "ollama";

export type AskParams = {
  applicationId: string;
  interactionToken: string;
  prompt: string;
  provider: Provider;
  modelId: string;
  task: string;
  sourceLang: string;
  targetLang: string;
  attachmentUrl: string;
  attachmentName: string;
  attachmentType: string;
};

/**
 * The /lab Workflow payload.
 *
 * NOTE, because it is easy to get wrong when reading the journal: `code` is
 * carried here, and a Workflow engine retains its event payload so the
 * instance can resume. So the submitted code transits and is retained by
 * Workflows, exactly as `AskParams.prompt` already is. What the /lab journal
 * in D1 does not hold is the code or its output; that is a statement about our
 * own tables, not about the Workflow engine.
 */
export type LabParams = {
  applicationId: string;
  interactionToken: string;
  sessionId: string;
  userId: string;
  guildId: string;
  channelId: string;
  lang: LabLang;
  code: string;
};

export interface Env {
  AI: Ai;
  DB: D1Database;
  CATALOG: KVNamespace;
  ASK: Workflow<AskParams>;
  LABRUN: Workflow<LabParams>;
  LAB: DurableObjectNamespace;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  RUNPOD_API_KEY?: string;
  CATALOG_TOKEN?: string;
  GATEWAY_ID: string;
  ACCOUNT_ID: string;
  DEFAULT_MODEL: string;
  DEFAULT_TASK: string;
  OLLAMA_MODEL: string;
  RUNPOD_ENDPOINT_ID: string;
  /** Comma separated Discord role ids allowed to run /lab. Unset denies everyone. */
  LAB_ROLE_IDS?: string;
}
