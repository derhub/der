import {
  formatUtcTimestamp,
  isTerminalChunk,
  terminalChunkKey,
  type Run,
  type RunAdmission,
  type RunEvent,
  type RunEventInput,
  type RunId,
  type RunRequest,
  type RunStatus,
  type RunStreamState,
  type SessionId,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { fingerprintJson } from "./canonical";
import type { SqliteDatabase } from "./database";
import { conflictError, notFoundError, validationError } from "./errors";
import {
  mapBotRow,
  mapMessageRow,
  mapRunEventRow,
  mapRunRow,
  mapSessionRow,
  type BotRow,
  type MessageRow,
  type RoutineRow,
  type RunEventRow,
  type RunRow,
  type SessionRow,
  ACTIVE_RUN_STATUS_SQL,
} from "./rows";
import { insertQueuedRun } from "./run-lifecycle";

export async function admitRun(
  database: SqliteDatabase,
  request: RunRequest,
): Promise<RunAdmission> {
  const parsed = compiledParsers.runRequest.safeParse(request);
  if (!parsed.success) {
    throw validationError(
      "run.invalid_request",
      "Invalid run admission request",
      parsed.error.message,
      `/api/sessions/${request.sessionId ?? "unknown"}/runs`,
    );
  }

  const valid = parsed.data;
  const instance = `/api/sessions/${valid.sessionId}/runs`;

  const sessionRow = database.db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(valid.sessionId);
  if (!sessionRow) {
    throw notFoundError(
      "session.not_found",
      "Session not found",
      `Session ${valid.sessionId} does not exist.`,
      instance,
    );
  }
  if (sessionRow.bot_id !== valid.botId) {
    throw conflictError(
      "session.scope_mismatch",
      "Session scope mismatch",
      `Session ${valid.sessionId} does not belong to bot ${valid.botId}.`,
      instance,
    );
  }

  const botRow = database.db
    .query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?")
    .get(valid.botId);
  if (!botRow) {
    throw notFoundError(
      "bot.not_found",
      "Bot not found",
      `Bot ${valid.botId} does not exist.`,
      instance,
    );
  }
  const bot = mapBotRow(botRow);
  const session = mapSessionRow(sessionRow);
  const resolvedEngine = valid.engine ?? session.engine ?? bot.defaultEngine;
  if (resolvedEngine !== "script" && !bot.allowedEngines.includes(resolvedEngine)) {
    throw validationError(
      "run.engine_not_allowed",
      "Engine is not allowed",
      `Engine "${resolvedEngine}" is not allowed on bot ${bot.id}.`,
      instance,
    );
  }

  const payloadFingerprint = await fingerprintJson({
    botId: valid.botId,
    sessionId: valid.sessionId,
    origin: valid.origin,
    engine: resolvedEngine,
    input: valid.input,
    routineId: valid.routineId ?? null,
    routineSlot: valid.routineSlot ?? null,
  });

  const now = formatUtcTimestamp(database.now());

  return database.inTransactionWithRetry((db) => {
    const existingRequest = db
      .query<
        { payload_fingerprint: string; run_id: string; initial_message_id: string },
        [string, string]
      >(
        `SELECT payload_fingerprint, run_id, initial_message_id
         FROM run_requests
         WHERE session_id = ? AND idempotency_key = ?`,
      )
      .get(valid.sessionId, valid.idempotencyKey);

    if (existingRequest) {
      if (existingRequest.payload_fingerprint !== payloadFingerprint) {
        throw conflictError(
          "idempotency.conflict",
          "Idempotency key conflict",
          `Idempotency-Key "${valid.idempotencyKey}" was already used in session ${valid.sessionId} with a different payload.`,
          instance,
        );
      }

      const existingRun = db
        .query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?")
        .get(existingRequest.run_id);
      const existingMessage = db
        .query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?")
        .get(existingRequest.initial_message_id);
      if (!existingRun || !existingMessage) {
        throw new Error(`Corrupt run_request reference for key ${valid.idempotencyKey}`);
      }

      return compiledParsers.runAdmission.parse({
        run: mapRunRow(existingRun),
        initialMessage: mapMessageRow(existingMessage),
        isDuplicate: true,
        payloadFingerprint,
      });
    }

    if (valid.routineId !== undefined) {
      const routineRow = db
        .query<RoutineRow, [string, string, string]>(
          "SELECT * FROM routines WHERE id = ? AND bot_id = ? AND session_id = ?",
        )
        .get(valid.routineId, valid.botId, valid.sessionId);
      if (!routineRow) {
        throw conflictError(
          "routine.scope_mismatch",
          "Routine scope mismatch",
          `Routine ${valid.routineId} does not belong to bot ${valid.botId} and session ${valid.sessionId}.`,
          instance,
        );
      }
      if (resolvedEngine === "script" && routineRow.engine !== "script") {
        throw conflictError(
          "routine.scope_mismatch",
          "Routine scope mismatch",
          `Routine ${valid.routineId} does not carry a script.`,
          instance,
        );
      }
    }

    const activeRun = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM runs
         WHERE session_id = ? AND status IN ${ACTIVE_RUN_STATUS_SQL}`,
      )
      .get(valid.sessionId);
    if (activeRun) {
      throw conflictError(
        "run.active_conflict",
        "Active run exists",
        `Session ${valid.sessionId} already has active run ${activeRun.id}.`,
        instance,
      );
    }

    const runId = `run_${crypto.randomUUID()}`;
    const messageId = `msg_${crypto.randomUUID()}`;

    insertQueuedRun(db, {
      id: runId,
      botId: valid.botId,
      sessionId: valid.sessionId,
      origin: valid.origin,
      engine: resolvedEngine,
      routineId: valid.routineId ?? null,
      routineSlot: valid.routineSlot ?? null,
      at: now,
    });

    const ordinalRow = db
      .query<{ next_ordinal: number }, [string]>(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM messages WHERE session_id = ?",
      )
      .get(valid.sessionId);
    const nextOrdinal = ordinalRow?.next_ordinal ?? 1;

    db.query(
      `INSERT INTO messages (id, bot_id, session_id, ordinal, role, parts_json, run_id, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`,
    ).run(
      messageId,
      valid.botId,
      valid.sessionId,
      nextOrdinal,
      JSON.stringify(valid.input.parts),
      runId,
      now,
    );

    db.query(
      `INSERT INTO run_requests
        (session_id, idempotency_key, bot_id, payload_fingerprint, run_id, initial_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      valid.sessionId,
      valid.idempotencyKey,
      valid.botId,
      payloadFingerprint,
      runId,
      messageId,
      now,
    );

    const createdRun = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId);
    const createdMessage = db
      .query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?")
      .get(messageId);
    if (!createdRun || !createdMessage) {
      throw new Error(`Run ${runId} admission did not persist cleanly`);
    }

    return compiledParsers.runAdmission.parse({
      run: mapRunRow(createdRun),
      initialMessage: mapMessageRow(createdMessage),
      isDuplicate: false,
      payloadFingerprint,
    });
  });
}

export function getRun(database: SqliteDatabase, runId: RunId): Run | undefined {
  const row = database.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId);
  return row ? mapRunRow(row) : undefined;
}

export function listSessionRuns(database: SqliteDatabase, sessionId: SessionId): Run[] {
  return database.db
    .query<RunRow, [string]>("SELECT * FROM runs WHERE session_id = ? ORDER BY rowid DESC")
    .all(sessionId)
    .map(mapRunRow);
}

export async function appendRunEvents(
  database: SqliteDatabase,
  runId: RunId,
  events: readonly RunEventInput[],
  maxEventBatchSize: number,
): Promise<RunEvent[]> {
  if (events.length === 0) {
    return [];
  }

  const committed: RunEvent[] = [];
  for (let offset = 0; offset < events.length; offset += maxEventBatchSize) {
    const batch = events.slice(offset, offset + maxEventBatchSize);
    const now = formatUtcTimestamp(database.now());
    const batchRows = await database.inTransactionWithRetry((db) => {
      const runRow = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId);
      if (!runRow) {
        throw notFoundError(
          "run.not_found",
          "Run not found",
          `Run ${runId} does not exist.`,
          `/api/runs/${runId}`,
        );
      }

      const results: RunEvent[] = [];
      for (const entry of batch) {
        // Only finishing a Run writes a terminal payload or the reserved key, whatever the caller.
        if (isTerminalChunk(entry.chunk) || entry.chunkKey === terminalChunkKey(runId)) {
          continue;
        }
        const existing = db
          .query<RunEventRow, [string, string]>(
            "SELECT * FROM run_events WHERE run_id = ? AND chunk_key = ?",
          )
          .get(runId, entry.chunkKey);
        if (existing) {
          results.push(mapRunEventRow(existing));
          continue;
        }

        const terminalRow = db
          .query<{ sequence: number }, [string]>(
            "SELECT sequence FROM run_events WHERE run_id = ? AND is_terminal = 1 LIMIT 1",
          )
          .get(runId);
        if (terminalRow) {
          throw conflictError(
            "run.already_terminal",
            "Run already has a terminal event",
            `Run ${runId} already committed a terminal event at sequence ${terminalRow.sequence}.`,
            `/api/runs/${runId}/events`,
          );
        }

        const seqRow = db
          .query<{ next_seq: number }, [string]>(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?",
          )
          .get(runId);
        const nextSeq = seqRow?.next_seq ?? 1;

        db.query(
          `INSERT INTO run_events (run_id, sequence, chunk_key, chunk_json, is_terminal, created_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
        ).run(runId, nextSeq, entry.chunkKey, JSON.stringify(entry.chunk), now);

        const inserted = db
          .query<RunEventRow, [string, number]>(
            "SELECT * FROM run_events WHERE run_id = ? AND sequence = ?",
          )
          .get(runId, nextSeq);
        if (inserted) {
          results.push(mapRunEventRow(inserted));
        }
      }
      return results;
    });
    committed.push(...batchRows);
  }

  return committed;
}

export function getRunStreamState(
  database: SqliteDatabase,
  runId: RunId,
): RunStreamState | undefined {
  const runRow = database.db
    .query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?")
    .get(runId);
  if (!runRow) {
    return undefined;
  }

  const stats = database.db
    .query<{ high_water_mark: number; terminal_sequence: number | null }, [string]>(
      `SELECT
         COALESCE(MAX(sequence), 0) AS high_water_mark,
         MAX(CASE WHEN is_terminal = 1 THEN sequence ELSE NULL END) AS terminal_sequence
       FROM run_events
       WHERE run_id = ?`,
    )
    .get(runId);

  return {
    highWaterMark: stats?.high_water_mark ?? 0,
    terminalSequence: stats?.terminal_sequence ?? undefined,
    status: runRow.status as RunStatus,
  };
}

export function readRunEventsAfter(
  database: SqliteDatabase,
  runId: RunId,
  after: number,
  limit: number,
): RunEvent[] {
  const rows = database.db
    .query<RunEventRow, [string, number, number]>(
      `SELECT * FROM run_events
       WHERE run_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(runId, after, limit);
  return rows.map(mapRunEventRow);
}
