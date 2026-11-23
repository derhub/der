CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('mcp', 'home-assistant', 'wasmer', 'docker', 'engine-permission', 'fixture', 'capability')),
  operation_id TEXT NOT NULL,
  canonical_arguments_json TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  awakeable TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  actor TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, operation_kind, operation_id, attempt_id),
  FOREIGN KEY (run_id, session_id, bot_id) REFERENCES runs(id, session_id, bot_id)
);

INSERT INTO approvals_new (
  id, bot_id, session_id, run_id, operation_kind, operation_id, canonical_arguments_json,
  attempt_id, prompt, awakeable, deadline, status, actor, decided_at, created_at, updated_at
)
SELECT
  id, bot_id, session_id, run_id, operation_kind, operation_id, canonical_arguments_json,
  attempt_id, prompt, awakeable, deadline, status, actor, decided_at, created_at, updated_at
FROM approvals;

DROP TABLE approvals;

ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX idx_approvals_run_id ON approvals (run_id, created_at);

CREATE TABLE effects_new (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('mcp', 'home-assistant', 'wasmer', 'docker', 'engine-permission', 'fixture', 'capability')),
  operation_id TEXT NOT NULL,
  canonical_arguments_json TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'unknown')),
  outcome_json TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, operation_kind, operation_id, attempt_id)
);

INSERT INTO effects_new (
  id, run_id, operation_kind, operation_id, canonical_arguments_json,
  attempt_id, status, outcome_json, started_at, updated_at
)
SELECT
  id, run_id, operation_kind, operation_id, canonical_arguments_json,
  attempt_id, status, outcome_json, started_at, updated_at
FROM effects;

DROP TABLE effects;

ALTER TABLE effects_new RENAME TO effects;
