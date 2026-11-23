CREATE TABLE script_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  bot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted')),
  result_json TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, digest, occurrence)
);

CREATE INDEX idx_script_runs_run_status ON script_runs (run_id, status);
