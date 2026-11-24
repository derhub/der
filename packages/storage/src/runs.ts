import {
  CLOUD_EVENT_SPEC_VERSION,
  CLOUD_EVENT_TYPES,
  formatUtcTimestamp,
  type CloudEvent,
  type ContextMode,
  type JsonValue,
  type Message,
  type MessagePart,
  type OutboxEvent,
  type Run,
  type RunAdmission,
  type RunEvent,
  type RunId,
  type RunRequest,
  type RunStatus,
  type RunUsage,
  type SessionId,
  type TerminalRunStatus,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { fingerprintJson } from "./canonical";
import { insertOutboxForBindings } from "./channel-outbox";
import type { SqliteDatabase } from "./database";
import { conflictError, notFoundError, validationError } from "./errors";
import {
  mapBotRow,
  mapMessageRow,
  mapRunEventRow,
  mapRunRow,
  mapSessionRow,
  type BotRow,
  type ChannelBindingRow,
  type MessageRow,
  type RoutineRow,
  type RunEventRow,
  type RunRow,
  type SessionRow,
} from "./rows";

export interface RunEventInput {
  readonly chunkKey: string;
  readonly chunk: JsonValue;
  readonly isTerminal?: boolean;
}

export interface FinishRunInput {
  readonly runId: RunId;
  readonly status: TerminalRunStatus;
  readonly terminalEvent: RunEventInput;
  readonly finalMessageParts?: readonly MessagePart[];
  readonly detail?: string;
  readonly checkpoint?: JsonValue | null;
  readonly usage?: RunUsage;
  readonly contextMode?: ContextMode;
}

export interface FinishRunOutcome {
  readonly run: Run;
  readonly terminalEvent: RunEvent;
  readonly finalMessage?: Message;
  readonly outboxEvents: readonly OutboxEvent[];
}

export interface RunStreamState {
  readonly highWaterMark: number;
  readonly terminalSequence: number | undefined;
  readonly status: RunStatus;
}

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
         WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_approval')`,
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

    db.query(
      `INSERT INTO runs
        (id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, checkpoint_json, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, ?, ?, NULL)`,
    ).run(
      runId,
      valid.botId,
      valid.sessionId,
      valid.origin,
      resolvedEngine,
      valid.routineId ?? null,
      valid.routineSlot ?? null,
      now,
      now,
    );

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

export async function markRunRunning(
  database: SqliteDatabase,
  runId: RunId,
  checkpoint?: JsonValue | null,
): Promise<Run> {
  const now = formatUtcTimestamp(database.now());
  return database.inTransactionWithRetry((db) => {
    const existing = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!existing) {
      throw notFoundError(
        "run.not_found",
        "Run not found",
        `Run ${runId} does not exist.`,
        `/api/runs/${runId}`,
      );
    }
    if (existing.status === "queued" || existing.status === "waiting_approval") {
      db.query(
        `UPDATE runs
         SET status = 'running', checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?
         WHERE id = ?`,
      ).run(checkpoint !== undefined ? JSON.stringify(checkpoint) : null, now, runId);
    } else if (checkpoint !== undefined && existing.status === "running") {
      db.query("UPDATE runs SET checkpoint_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(checkpoint),
        now,
        runId,
      );
    }
    const updated = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!updated) {
      throw new Error(`Run ${runId} disappeared`);
    }
    return mapRunRow(updated);
  });
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
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          nextSeq,
          entry.chunkKey,
          JSON.stringify(entry.chunk),
          entry.isTerminal ? 1 : 0,
          now,
        );

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

export async function finishRun(
  database: SqliteDatabase,
  input: FinishRunInput,
): Promise<FinishRunOutcome> {
  const now = formatUtcTimestamp(database.now());
  const instance = `/api/runs/${input.runId}`;

  return database.inTransactionWithRetry((db) => {
    const runRow = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(input.runId);
    if (!runRow) {
      throw notFoundError(
        "run.not_found",
        "Run not found",
        `Run ${input.runId} does not exist.`,
        instance,
      );
    }

    const existingTerminal = db
      .query<RunEventRow, [string, string]>(
        "SELECT * FROM run_events WHERE run_id = ? AND chunk_key = ?",
      )
      .get(input.runId, input.terminalEvent.chunkKey);

    let terminalEvent: RunEvent;
    if (existingTerminal) {
      terminalEvent = mapRunEventRow(existingTerminal);
    } else {
      const seqRow = db
        .query<{ next_seq: number }, [string]>(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?",
        )
        .get(input.runId);
      const nextSeq = seqRow?.next_seq ?? 1;
      db.query(
        `INSERT INTO run_events (run_id, sequence, chunk_key, chunk_json, is_terminal, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).run(
        input.runId,
        nextSeq,
        input.terminalEvent.chunkKey,
        JSON.stringify(input.terminalEvent.chunk),
        now,
      );
      const insertedEvent = db
        .query<RunEventRow, [string, number]>(
          "SELECT * FROM run_events WHERE run_id = ? AND sequence = ?",
        )
        .get(input.runId, nextSeq);
      if (!insertedEvent) {
        throw new Error(`Terminal event for run ${input.runId} was not persisted`);
      }
      terminalEvent = mapRunEventRow(insertedEvent);
    }

    const finishedAt = runRow.finished_at ?? now;
    db.query(
      `UPDATE runs
       SET status = ?, checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?, finished_at = ?,
           input_tokens = COALESCE(?, input_tokens),
           cached_input_tokens = COALESCE(?, cached_input_tokens),
           cache_write_tokens = COALESCE(?, cache_write_tokens),
           output_tokens = COALESCE(?, output_tokens),
           reported_cost_usd = COALESCE(?, reported_cost_usd),
           context_mode = COALESCE(?, context_mode)
       WHERE id = ?`,
    ).run(
      input.status,
      input.checkpoint !== undefined ? JSON.stringify(input.checkpoint) : null,
      now,
      finishedAt,
      input.usage?.inputTokens ?? null,
      input.usage?.cachedInputTokens ?? null,
      input.usage?.cacheWriteTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.usage?.reportedCostUsd ?? null,
      input.contextMode ?? null,
      input.runId,
    );

    const outboxEvents: OutboxEvent[] = [];
    let finalMessage: Message | undefined;

    if (input.finalMessageParts !== undefined && input.finalMessageParts.length > 0) {
      const existingReply = db
        .query<MessageRow, [string]>(
          "SELECT * FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY ordinal DESC LIMIT 1",
        )
        .get(input.runId);
      if (existingReply) {
        finalMessage = mapMessageRow(existingReply);
      } else {
        const ordinalRow = db
          .query<{ next_ordinal: number }, [string]>(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM messages WHERE session_id = ?",
          )
          .get(runRow.session_id);
        const nextOrdinal = ordinalRow?.next_ordinal ?? 1;
        const messageId = `msg_${crypto.randomUUID()}`;
        db.query(
          `INSERT INTO messages (id, bot_id, session_id, ordinal, role, parts_json, run_id, created_at)
           VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?)`,
        ).run(
          messageId,
          runRow.bot_id,
          runRow.session_id,
          nextOrdinal,
          JSON.stringify(input.finalMessageParts),
          input.runId,
          now,
        );
        const insertedMsg = db
          .query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?")
          .get(messageId);
        if (insertedMsg) {
          finalMessage = mapMessageRow(insertedMsg);
        }
      }

      if (finalMessage) {
        const sessionBindings = db
          .query<ChannelBindingRow, [string, string]>(
            `SELECT * FROM channel_bindings
             WHERE bot_id = ? AND session_id = ? AND enabled = 1
             ORDER BY created_at ASC, id ASC`,
          )
          .all(runRow.bot_id, runRow.session_id);

        const chatEnvelope: CloudEvent = {
          specversion: CLOUD_EVENT_SPEC_VERSION,
          id: `chat.replied:${input.runId}`,
          source: `/bots/${runRow.bot_id}`,
          type: CLOUD_EVENT_TYPES.chatReplied,
          time: now,
          subject: `sessions/${runRow.session_id}/runs/${input.runId}`,
          datacontenttype: "application/json",
          data: {
            botId: runRow.bot_id,
            sessionId: runRow.session_id,
            runId: input.runId,
            message: finalMessage,
          },
        };

        outboxEvents.push(...insertOutboxForBindings(db, sessionBindings, chatEnvelope, now));
      }
    }

    if (runRow.routine_id !== null) {
      const botBindings = db
        .query<ChannelBindingRow, [string]>(
          `SELECT * FROM channel_bindings
           WHERE bot_id = ? AND enabled = 1
           ORDER BY created_at ASC, id ASC`,
        )
        .all(runRow.bot_id);

      const routineEnvelope: CloudEvent = {
        specversion: CLOUD_EVENT_SPEC_VERSION,
        id: `routine.finished:${input.runId}`,
        source: `/bots/${runRow.bot_id}`,
        type: CLOUD_EVENT_TYPES.routineFinished,
        time: now,
        subject: `bots/${runRow.bot_id}/routines/${runRow.routine_id}/runs/${input.runId}`,
        datacontenttype: "application/json",
        data: {
          botId: runRow.bot_id,
          routineId: runRow.routine_id,
          runId: input.runId,
          sessionId: runRow.session_id,
          slot: runRow.routine_slot ?? runRow.created_at,
          outcome: input.status,
          finishedAt,
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
        },
      };

      outboxEvents.push(...insertOutboxForBindings(db, botBindings, routineEnvelope, now));
    }

    const updatedRun = db
      .query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?")
      .get(input.runId);
    if (!updatedRun) {
      throw new Error(`Run ${input.runId} disappeared`);
    }

    return {
      run: mapRunRow(updatedRun),
      terminalEvent,
      ...(finalMessage !== undefined ? { finalMessage } : {}),
      outboxEvents,
    };
  });
}
