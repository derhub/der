ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cached_input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN reported_cost_usd REAL;
ALTER TABLE runs ADD COLUMN context_mode TEXT CHECK (context_mode IN ('resumed', 'rebuilt'));
