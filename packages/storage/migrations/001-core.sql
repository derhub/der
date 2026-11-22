CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  persona TEXT NOT NULL,
  default_engine TEXT NOT NULL CHECK (default_engine IN ('codex', 'claude-code', 'antigravity', 'fixture')),
  allowed_engines_json TEXT NOT NULL,
  workspace_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  title TEXT NOT NULL,
  engine TEXT CHECK (engine IS NULL OR engine IN ('codex', 'claude-code', 'antigravity', 'fixture')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, bot_id)
);

CREATE INDEX idx_sessions_bot_id ON sessions (bot_id, created_at);

CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude-code', 'antigravity', 'fixture')),
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id),
  UNIQUE (id, bot_id, session_id)
);

CREATE INDEX idx_routines_bot_id ON routines (bot_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('http', 'web', 'telegram', 'routine')),
  engine TEXT NOT NULL CHECK (engine IN ('codex', 'claude-code', 'antigravity', 'fixture')),
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

CREATE UNIQUE INDEX idx_runs_one_active_per_session
  ON runs (session_id)
  WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE INDEX idx_runs_session_id ON runs (session_id, created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  parts_json TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ordinal),
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id)
);

CREATE INDEX idx_messages_run_id ON messages (run_id);

CREATE TABLE run_requests (
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  initial_message_id TEXT NOT NULL REFERENCES messages(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, idempotency_key),
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id)
);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  chunk_key TEXT NOT NULL,
  chunk_json TEXT NOT NULL,
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, chunk_key)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('mcp', 'home-assistant', 'wasmer', 'docker', 'engine-permission', 'fixture')),
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

CREATE INDEX idx_approvals_run_id ON approvals (run_id, created_at);

CREATE TABLE effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('mcp', 'home-assistant', 'wasmer', 'docker', 'engine-permission', 'fixture')),
  operation_id TEXT NOT NULL,
  canonical_arguments_json TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'unknown')),
  outcome_json TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, operation_kind, operation_id, attempt_id)
);

CREATE TABLE channel_bindings (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL CHECK (integration IN ('telegram', 'fixture')),
  external_chat_id TEXT NOT NULL,
  external_actor_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id, bot_id) REFERENCES sessions(id, bot_id),
  UNIQUE (integration, external_chat_id, external_actor_id, session_id)
);

CREATE INDEX idx_channel_bindings_bot_session ON channel_bindings (bot_id, session_id, enabled);

CREATE TABLE channel_receipts (
  integration TEXT NOT NULL CHECK (integration IN ('telegram', 'fixture')),
  consumer TEXT NOT NULL,
  external_update_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('admitted', 'decided', 'ignored', 'rejected', 'duplicate')),
  reference_id TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (integration, consumer, external_update_id)
);

CREATE TABLE channel_cursors (
  integration TEXT NOT NULL CHECK (integration IN ('telegram', 'fixture')),
  consumer TEXT NOT NULL,
  position TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (integration, consumer)
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES channel_bindings(id),
  event_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'retrying', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (binding_id, event_id)
);

CREATE INDEX idx_outbox_events_due ON outbox_events (state, next_retry_at, created_at);
