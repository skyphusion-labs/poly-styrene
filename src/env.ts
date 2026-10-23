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

export interface Env {
  AI: Ai;
  DB: D1Database;
  CATALOG: KVNamespace;
  ASK: Workflow<AskParams>;
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
  /** The RunPod endpoint execution timeout in seconds. Unset falls back to the documented default. */
  RUNPOD_EXEC_TIMEOUT_SEC?: string;
}
