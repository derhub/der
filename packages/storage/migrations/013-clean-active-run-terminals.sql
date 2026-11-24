DELETE FROM run_events
WHERE run_id IN (
  SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting_approval')
)
AND (
  chunk_key = run_id || ':terminal'
  OR is_terminal = 1
  OR (json_valid(chunk_json) AND json_extract(chunk_json, '$.type') IN ('RUN_FINISHED', 'RUN_ERROR'))
);
