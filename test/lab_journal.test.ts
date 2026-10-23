import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  closeLabSession,
  countLabRuns,
  openLabSession,
  pruneLabSessions,
} from "../src/lab_journal";
import { memoryLabDb } from "./fakes";

function open(db: D1Database, id: string, userId: string, startedAt: string) {
  return openLabSession(db, {
    id,
    userId,
    guildId: "g1",
    channelId: "c1",
    instance: "basic",
    startedAt,
  });
}

describe("lab journal", () => {
  it("opens a session and closes it once", async () => {
    const { db, rows } = memoryLabDb();
    await open(db, "s1", "u1", "2026-10-23T10:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stopped_at).toBeNull();

    await closeLabSession(db, "s1", "2026-10-23T10:01:00.000Z", "ok");
    expect(rows[0]?.stopped_at).toBe("2026-10-23T10:01:00.000Z");
    expect(rows[0]?.exit_reason).toBe("ok");

    // A second close must not overwrite how it really ended.
    await closeLabSession(db, "s1", "2026-10-23T10:09:00.000Z", "lost");
    expect(rows[0]?.exit_reason).toBe("ok");
  });

  it("is idempotent on the session id, so a Workflow retry adds no row", async () => {
    const { db, rows } = memoryLabDb();
    await open(db, "s1", "u1", "2026-10-23T10:00:00.000Z");
    await open(db, "s1", "u1", "2026-10-23T10:00:00.000Z");
    expect(rows).toHaveLength(1);
  });

  it("counts only the asking person, and counts an abandoned open session", async () => {
    const { db } = memoryLabDb();
    await open(db, "s1", "u1", "2026-10-23T10:00:00.000Z");
    await open(db, "s2", "u1", "2026-10-23T11:00:00.000Z");
    await open(db, "s3", "u2", "2026-10-23T11:00:00.000Z");
    // s1 is never closed; it still counts, so walking away buys no free slot.
    expect(await countLabRuns(db, "u1", "2026-10-23T00:00:00.000Z")).toBe(2);
    expect(await countLabRuns(db, "u2", "2026-10-23T00:00:00.000Z")).toBe(1);
    expect(await countLabRuns(db, "u3", "2026-10-23T00:00:00.000Z")).toBe(0);
  });

  it("excludes rows outside the window", async () => {
    const { db } = memoryLabDb();
    await open(db, "s1", "u1", "2026-10-20T10:00:00.000Z");
    await open(db, "s2", "u1", "2026-10-23T10:00:00.000Z");
    expect(await countLabRuns(db, "u1", "2026-10-22T00:00:00.000Z")).toBe(1);
  });

  // countLabRuns reports -1 rather than 0 when it cannot read, because
  // labQuota refuses a negative and would ALLOW a zero. A read failure must
  // not look like an unused quota.
  it("reports -1 on an unreadable count rather than 0", async () => {
    const broken = {
      prepare() {
        return { bind: () => ({ first: async () => null }) };
      },
    } as unknown as D1Database;
    expect(await countLabRuns(broken, "u1", "2026-10-22T00:00:00.000Z")).toBe(-1);
  });

  it("prunes only rows older than the cutoff", async () => {
    const { db, rows } = memoryLabDb();
    await open(db, "old", "u1", "2026-09-01T10:00:00.000Z");
    await open(db, "new", "u1", "2026-10-23T10:00:00.000Z");
    await pruneLabSessions(db, "2026-10-01T00:00:00.000Z");
    expect(rows.map((row) => row.id)).toEqual(["new"]);
  });
});

describe("lab journal shape", () => {
  // The narrowness of this table is the posture decision, not an accident, so
  // it is pinned here. If someone adds a column that could hold the submitted
  // code or its output, this fails and they have to argue for it.
  it("has no column that could hold submitted code or output", () => {
    const sql = readFileSync(new URL("../migrations/0002_lab_sessions.sql", import.meta.url), "utf8");
    const body = sql.replace(/^\s*--.*$/gm, "").toLowerCase();
    for (const banned of ["code", "output", "stdout", "stderr", "prompt", "answer", "script", "result"]) {
      expect(body).not.toMatch(new RegExp(`\\b${banned}\\b\\s+(text|blob|integer|real|numeric)`));
    }
    expect(body).toContain("exit_reason text");
    expect(body).toContain("user_id text not null");
  });

  it("indexes the two reads it actually has", () => {
    const sql = readFileSync(new URL("../migrations/0002_lab_sessions.sql", import.meta.url), "utf8").toLowerCase();
    expect(sql).toContain("(user_id, started_at)");
    expect(sql).toContain("(started_at)");
  });
});
