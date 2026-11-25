CREATE TABLE script_runs_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  bot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
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
  UNIQUE (run_id, digest, key, occurrence)
);

INSERT INTO script_runs_new (
  id, run_id, bot_id, digest, occurrence, source, status, result_json, delivered_at,
  created_at, updated_at, seed, lease_owner, lease_until, detached_at
)
SELECT
  id, run_id, bot_id, digest, occurrence, source, status, result_json, delivered_at,
  created_at, updated_at, seed, lease_owner, lease_until, detached_at
FROM script_runs;

DROP TABLE script_runs;

ALTER TABLE script_runs_new RENAME TO script_runs;

CREATE INDEX idx_script_runs_run_status ON script_runs (run_id, status);
