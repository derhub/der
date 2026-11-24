CREATE TABLE engine_sessions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude-code', 'antigravity', 'fixture')),
  vendor_session_id TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  last_ordinal INTEGER NOT NULL CHECK (last_ordinal >= 0),
  pending_run_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, engine)
);
