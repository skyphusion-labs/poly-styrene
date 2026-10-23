import type { Provider } from "./env";

export type Pin = {
  provider: Provider;
  model_id: string;
  task: string;
};

export async function getPin(
  db: D1Database,
  guildId: string,
  channelId: string,
  userId: string,
): Promise<Pin | null> {
  const row = await db
    .prepare("SELECT provider, model_id, task FROM pins WHERE guild_id = ? AND channel_id = ? AND user_id = ?")
    .bind(guildId, channelId, userId)
    .first<Pin>();
  return row ?? null;
}

export async function setPin(
  db: D1Database,
  guildId: string,
  channelId: string,
  userId: string,
  pin: Pin,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pins (guild_id, channel_id, user_id, provider, model_id, task, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, channel_id, user_id) DO UPDATE SET
         provider = excluded.provider,
         model_id = excluded.model_id,
         task = excluded.task,
         updated_at = excluded.updated_at`,
    )
    .bind(guildId, channelId, userId, pin.provider, pin.model_id, pin.task, new Date().toISOString())
    .run();
}

export async function clearPin(db: D1Database, guildId: string, channelId: string, userId: string): Promise<void> {
  await db
    .prepare("DELETE FROM pins WHERE guild_id = ? AND channel_id = ? AND user_id = ?")
    .bind(guildId, channelId, userId)
    .run();
}
