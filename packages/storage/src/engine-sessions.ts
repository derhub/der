import type { Database } from "bun:sqlite";
import type { EngineKind, EngineSession, EngineSessionInput, SessionId } from "@der/domain";
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

export function takeEngineSession(
  database: SqliteDatabase,
  sessionId: SessionId,
  engine: EngineKind,
): EngineSession | null {
  return database.inTransaction((db) => {
    const stored = getEngineSession(db, sessionId, engine);
    db.query("DELETE FROM engine_sessions WHERE session_id = ?").run(sessionId);
    return stored;
  });
}

export function saveEngineSession(db: Database, row: EngineSessionInput, updatedAt: string): void {
  db.query(
    `INSERT OR REPLACE INTO engine_sessions
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
