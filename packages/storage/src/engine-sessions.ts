import type { EngineKind, EngineSession, RunId, SessionId } from "@der/domain";
import type { SqliteDatabase } from "./database";

interface EngineSessionRow {
  readonly session_id: string;
  readonly engine: string;
  readonly vendor_session_id: string;
  readonly base_hash: string;
  readonly context_hash: string;
  readonly last_ordinal: number;
  readonly pending_run_id: string | null;
  readonly updated_at: string;
}

export function getEngineSession(
  database: SqliteDatabase,
  sessionId: SessionId,
  engine: EngineKind,
): EngineSession | null {
  const row = database.db
    .query<EngineSessionRow, [string, string]>(
      "SELECT * FROM engine_sessions WHERE session_id = ? AND engine = ?",
    )
    .get(sessionId, engine);
  if (!row) {
    return null;
  }
  return {
    sessionId: row.session_id,
    engine: row.engine as EngineKind,
    vendorSessionId: row.vendor_session_id,
    baseHash: row.base_hash,
    contextHash: row.context_hash,
    lastOrdinal: row.last_ordinal,
    pendingRunId: row.pending_run_id,
    updatedAt: row.updated_at as EngineSession["updatedAt"],
  };
}

export function markEngineSessionPending(
  database: SqliteDatabase,
  sessionId: SessionId,
  engine: EngineKind,
  runId: RunId,
): void {
  database.db
    .query("UPDATE engine_sessions SET pending_run_id = ? WHERE session_id = ? AND engine = ?")
    .run(runId, sessionId, engine);
}

export function saveEngineSession(
  database: SqliteDatabase,
  row: Omit<EngineSession, "pendingRunId" | "updatedAt">,
  updatedAt: string,
): void {
  database.db
    .query(
      `INSERT INTO engine_sessions
         (session_id, engine, vendor_session_id, base_hash, context_hash, last_ordinal, pending_run_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (session_id, engine) DO UPDATE SET
         vendor_session_id = excluded.vendor_session_id,
         base_hash = excluded.base_hash,
         context_hash = excluded.context_hash,
         last_ordinal = excluded.last_ordinal,
         pending_run_id = NULL,
         updated_at = excluded.updated_at
       WHERE excluded.last_ordinal > engine_sessions.last_ordinal`,
    )
    .run(
      row.sessionId,
      row.engine,
      row.vendorSessionId,
      row.baseHash,
      row.contextHash,
      row.lastOrdinal,
      updatedAt,
    );
}

export function dropEngineSession(
  database: SqliteDatabase,
  sessionId: SessionId,
  engine: EngineKind,
): void {
  database.db
    .query("DELETE FROM engine_sessions WHERE session_id = ? AND engine = ?")
    .run(sessionId, engine);
}
