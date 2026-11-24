import type { Database } from "bun:sqlite";
import {
  type NewSessionEvent,
  type Run,
  type RunId,
  type SessionEvent,
  type SessionId,
  type UtcTimestamp,
} from "@der/domain";
import { notFoundError } from "./errors";
import { mapRunRow, mapSessionEventRow, type RunRow, type SessionEventRow } from "./rows";

export function enqueueSessionEvent(
  db: Database,
  input: NewSessionEvent,
  now: UtcTimestamp,
): SessionEvent {
  const id = input.id ?? `evt_${crypto.randomUUID()}`;
  db.query(
    `INSERT INTO session_events (id, bot_id, session_id, kind, payload_json, state, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`,
  ).run(id, input.botId, input.sessionId, input.kind, JSON.stringify(input.payload), now);
  const row = db
    .query<SessionEventRow, [string]>("SELECT * FROM session_events WHERE id = ?")
    .get(id);
  if (!row) {
    throw new Error(`Session event ${id} was not persisted`);
  }
  return mapSessionEventRow(row);
}

/**
 * Pending events, oldest first. An event whose Run was admitted but never marked
 * (a crash between the two steps) carries that Run's id, found by its idempotency key.
 */
export function listPendingSessionEvents(db: Database): SessionEvent[] {
  return db
    .query<SessionEventRow, []>(
      `SELECT e.id, e.bot_id, e.session_id, e.kind, e.payload_json, e.state,
              COALESCE(e.run_id, r.run_id) AS run_id, e.created_at
       FROM session_events e
       LEFT JOIN run_requests r ON r.session_id = e.session_id AND r.idempotency_key = e.id
       WHERE e.state = 'pending'
       ORDER BY e.created_at ASC, e.rowid ASC`,
    )
    .all()
    .map(mapSessionEventRow);
}

export function markSessionEventDelivered(db: Database, eventId: string, runId: RunId): void {
  const result = db
    .query("UPDATE session_events SET state = 'delivered', run_id = ? WHERE id = ?")
    .run(runId, eventId);
  if (result.changes === 0) {
    throw notFoundError(
      "session_event.not_found",
      "Session event not found",
      `Session event ${eventId} does not exist.`,
      `/session-events/${eventId}`,
    );
  }
}

export function countPendingSessionEvents(db: Database, sessionId: SessionId): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND state = 'pending'",
      )
      .get(sessionId)?.n ?? 0
  );
}

/** Event Runs since the session's latest Run a human started; a routine Run does not reset it. */
export function countEventChain(db: Database, sessionId: SessionId): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM runs
         WHERE session_id = ? AND origin = 'event'
           AND rowid > COALESCE(
             (SELECT MAX(rowid) FROM runs
              WHERE session_id = ? AND origin IN ('http', 'web', 'telegram')), 0)`,
      )
      .get(sessionId, sessionId)?.n ?? 0
  );
}

export function getActiveRun(db: Database, sessionId: SessionId): Run | undefined {
  const row = db
    .query<RunRow, [string]>(
      "SELECT * FROM runs WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_approval')",
    )
    .get(sessionId);
  return row ? mapRunRow(row) : undefined;
}
