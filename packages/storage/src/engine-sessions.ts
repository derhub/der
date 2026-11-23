import type { Database } from "bun:sqlite";
import type {
  ContextMode,
  EngineKind,
  EngineSession,
  EngineSessionInput,
  RunId,
  SessionId,
} from "@der/domain";
import type { SqliteDatabase } from "./database";

interface EngineSessionRow {
  readonly session_id: string;
  readonly engine: string;
  readonly vendor_session_id: string;
  readonly base_hash: string;
  readonly context_hash: string;
  readonly last_ordinal: number;
  readonly updated_at: string;
}

export function getEngineSession(
  db: Database,
  sessionId: SessionId,
  engine: EngineKind,
): EngineSession | null {
  const row = db
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
    updatedAt: row.updated_at as EngineSession["updatedAt"],
  };
}

export function takeEngineSession<T extends { readonly contextMode: ContextMode }>(
  database: SqliteDatabase,
  runId: RunId,
  plan: (stored: EngineSession | null) => T,
): T | undefined {
  return database.inTransaction((db) => {
    const run = db
      .query<{ session_id: string; engine: string }, [string]>(
        `SELECT session_id, engine FROM runs
         WHERE id = ? AND status IN ('queued', 'running', 'waiting_approval')`,
      )
      .get(runId);
    if (!run) {
      return undefined;
    }
    const stored = getEngineSession(db, run.session_id, run.engine as EngineKind);
    db.query("DELETE FROM engine_sessions WHERE session_id = ?").run(run.session_id);
    const planned = plan(stored);
    db.query("UPDATE runs SET context_mode = ? WHERE id = ?").run(planned.contextMode, runId);
    return planned;
  });
}

/** Replaces the session's engine sessions with `row`, or with none. */
export function handOverEngineSession(
  db: Database,
  sessionId: SessionId,
  row: EngineSessionInput | undefined,
  updatedAt: string,
): void {
  db.query("DELETE FROM engine_sessions WHERE session_id = ?").run(sessionId);
  if (row === undefined) {
    return;
  }
  db.query(
    `INSERT INTO engine_sessions
       (session_id, engine, vendor_session_id, base_hash, context_hash, last_ordinal, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.sessionId,
    row.engine,
    row.vendorSessionId,
    row.baseHash,
    row.contextHash,
    row.lastOrdinal,
    updatedAt,
  );
}
