CREATE TABLE channel_bindings_new (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL CHECK (length(trim(integration)) > 0),
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

INSERT INTO channel_bindings_new (
  id,
  integration,
  external_chat_id,
  external_actor_id,
  bot_id,
  session_id,
  enabled,
  created_at,
  updated_at
)
SELECT
  id,
  integration,
  external_chat_id,
  external_actor_id,
  bot_id,
  session_id,
  enabled,
  created_at,
  updated_at
FROM channel_bindings;

DROP TABLE channel_bindings;

ALTER TABLE channel_bindings_new RENAME TO channel_bindings;

CREATE INDEX idx_channel_bindings_bot_session ON channel_bindings (bot_id, session_id, enabled);
