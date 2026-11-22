CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  version INTEGER NOT NULL CHECK (version > 0),
  markdown TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, version)
);

CREATE INDEX idx_memories_bot_version ON memories (bot_id, version DESC);

CREATE TABLE routine_slots (
  routine_id TEXT NOT NULL REFERENCES routines(id),
  slot TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  disposition TEXT NOT NULL CHECK (
    disposition IN (
      'admitted',
      'skipped_active_run',
      'blocked_ineligible',
      'skipped_obsolete_revision',
      'completed',
      'failed',
      'interrupted'
    )
  ),
  run_id TEXT REFERENCES runs(id),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (routine_id, slot)
);

CREATE INDEX idx_routine_slots_routine_slot ON routine_slots (routine_id, slot DESC);
