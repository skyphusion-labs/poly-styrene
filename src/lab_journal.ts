// The /lab metadata journal.
//
// This is the ONLY place in poly-styrene that records who did something, and
// it exists because a quota and an abuse trail cannot be built without it.
// It is deliberately narrow: it records THAT a person ran a sandbox and how it
// ended, and never WHAT they ran or what came back. The submitted code and its
// output are the equivalent of a prompt and an answer, and this bot does not
// persist either of those anywhere. `test/lab_journal.test.ts` asserts the
// migration carries no column that could hold them.

export type LabExit = "ok" | "failed" | "timeout" | "refused" | "lost";

export type LabSessionRow = {
  id: string;
  user_id: string;
  guild_id: string;
  channel_id: string;
  instance: string;
  started_at: string;
  stopped_at: string | null;
  exit_reason: LabExit | null;
};

export async function openLabSession(
  db: D1Database,
  row: {
    id: string;
    userId: string;
    guildId: string;
    channelId: string;
    instance: string;
    startedAt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO lab_sessions (id, user_id, guild_id, channel_id, instance, started_at, stopped_at, exit_reason)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(row.id, row.userId, row.guildId, row.channelId, row.instance, row.startedAt)
    .run();
}

export async function closeLabSession(
  db: D1Database,
  id: string,
  stoppedAt: string,
  exit: LabExit,
): Promise<void> {
  await db
    .prepare(
      `UPDATE lab_sessions SET stopped_at = ?, exit_reason = ?
       WHERE id = ? AND stopped_at IS NULL`,
    )
    .bind(stoppedAt, exit, id)
    .run();
}

/**
 * Count a person's runs since `sinceIso`, for the quota.
 *
 * A row that is still open counts, so a sandbox someone abandoned cannot be
 * used to get a free slot. A null or unreadable count is returned as -1 rather
 * than 0, because `labQuota` refuses a negative and a failed read must not
 * read as "no usage".
 */
export async function countLabRuns(db: D1Database, userId: string, sinceIso: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM lab_sessions WHERE user_id = ? AND started_at >= ?")
    .bind(userId, sinceIso)
    .first<{ n: number }>();
  const n = row?.n;
  return typeof n === "number" && Number.isFinite(n) ? n : -1;
}

/** Drop journal rows older than the retention cutoff. */
export async function pruneLabSessions(db: D1Database, beforeIso: string): Promise<void> {
  await db.prepare("DELETE FROM lab_sessions WHERE started_at < ?").bind(beforeIso).run();
}
