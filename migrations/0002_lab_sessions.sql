-- The /lab metadata journal.
--
-- Deliberately carries NO column that could hold submitted code or its
-- output. A quota and an abuse trail need to know that a person ran a sandbox
-- and how it ended; they do not need the contents, and this bot does not
-- persist a prompt or an answer anywhere else either.
CREATE TABLE IF NOT EXISTS lab_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  instance TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  exit_reason TEXT
);

-- The quota reads (user_id, started_at).
CREATE INDEX IF NOT EXISTS lab_sessions_user_started ON lab_sessions (user_id, started_at);

-- The retention prune reads started_at alone.
CREATE INDEX IF NOT EXISTS lab_sessions_started ON lab_sessions (started_at);
