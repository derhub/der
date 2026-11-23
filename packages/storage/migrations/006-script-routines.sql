CREATE TABLE routines_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude-code', 'antigravity', 'fixture', 'script')),
  prompt TEXT,
  script TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id),
  UNIQUE (id, bot_id, session_id),
  CHECK (
    (engine = 'script' AND script IS NOT NULL AND prompt IS NULL)
    OR (engine <> 'script' AND prompt IS NOT NULL AND script IS NULL)
  )
);

INSERT INTO routines_new (
  id, bot_id, session_id, name, cron, enabled, revision, engine, prompt, script, created_at, updated_at
)
SELECT
  id, bot_id, session_id, name, cron, enabled, revision, engine, prompt, NULL, created_at, updated_at
FROM routines;

DROP TABLE routines;

ALTER TABLE routines_new RENAME TO routines;

CREATE INDEX idx_routines_bot_id ON routines (bot_id);

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('http', 'web', 'telegram', 'routine')),
  engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude-code', 'antigravity', 'fixture', 'script')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'cancelled')),
  routine_id TEXT REFERENCES routines(id),
  routine_slot TEXT,
  checkpoint_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id),
  UNIQUE (id, session_id, bot_id)
);

INSERT INTO runs_new (
  id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, checkpoint_json,
  created_at, updated_at, finished_at
)
SELECT
  id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, checkpoint_json,
  created_at, updated_at, finished_at
FROM runs;

DROP TABLE runs;

ALTER TABLE runs_new RENAME TO runs;

CREATE UNIQUE INDEX idx_runs_one_active_per_session
  ON runs (session_id)
  WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE INDEX idx_runs_session_id ON runs (session_id, created_at);
