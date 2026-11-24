CREATE TABLE script_runs_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  bot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK (occurrence >= 1),
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted', 'in_doubt')),
  result_json TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seed INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  detached_at TEXT,
  UNIQUE (run_id, digest, occurrence)
);

INSERT INTO script_runs_new (
  id, run_id, bot_id, digest, occurrence, source, status, result_json, delivered_at,
  created_at, updated_at
)
SELECT
  id, run_id, bot_id, digest, occurrence, source, status, result_json, delivered_at,
  created_at, updated_at
FROM script_runs;

DROP TABLE script_runs;

ALTER TABLE script_runs_new RENAME TO script_runs;

CREATE INDEX idx_script_runs_run_status ON script_runs (run_id, status);

CREATE TABLE script_steps (
  script_run_id TEXT NOT NULL REFERENCES script_runs(id),
  position INTEGER NOT NULL CHECK (position >= 1),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('read', 'write')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'unknown', 'skipped')),
  result_json TEXT,
  error_json TEXT,
  seq INTEGER,
  batch INTEGER,
  round INTEGER,
  PRIMARY KEY (script_run_id, position)
);
