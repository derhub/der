ALTER TABLE bots ADD COLUMN capability_policy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE bots ADD COLUMN event_chain_limit INTEGER NOT NULL DEFAULT 3
  CHECK (event_chain_limit >= 0);
