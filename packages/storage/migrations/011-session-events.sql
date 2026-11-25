CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('script.finished')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
  run_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id)
);

CREATE INDEX idx_session_events_pending ON session_events (state, created_at);

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('http', 'web', 'telegram', 'routine', 'event')),
  engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude-code', 'antigravity', 'fixture', 'script')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'cancelled')),
  routine_id TEXT REFERENCES routines(id),
  routine_slot TEXT,
  checkpoint_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  reported_cost_usd REAL,
  context_mode TEXT CHECK (context_mode IN ('resumed', 'rebuilt')),
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id),
  UNIQUE (id, session_id, bot_id)
);

INSERT INTO runs_new (
  id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, checkpoint_json,
  created_at, updated_at, finished_at,
  input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reported_cost_usd, context_mode
)
SELECT
  id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, checkpoint_json,
  created_at, updated_at, finished_at,
  input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reported_cost_usd, context_mode
FROM runs
ORDER BY rowid;

DROP TABLE runs;

ALTER TABLE runs_new RENAME TO runs;

CREATE UNIQUE INDEX idx_runs_one_active_per_session
  ON runs (session_id)
  WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE INDEX idx_runs_session_id ON runs (session_id, created_at);
