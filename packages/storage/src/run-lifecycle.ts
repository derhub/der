import type { Database } from "bun:sqlite";
import {
  CLOUD_EVENT_SPEC_VERSION,
  CLOUD_EVENT_TYPES,
  formatUtcTimestamp,
  terminalChunkKey,
  type ActiveRunStatus,
  type CloudEvent,
  type FinishRunInput,
  type FinishRunOutcome,
  type JsonValue,
  type Message,
  type OutboxEvent,
  type Run,
  type RunEnd,
  type RunId,
  type TerminalRunStatus,
  type UtcTimestamp,
} from "@der/domain";
import { insertOutboxForBindings } from "./channel-outbox";
import type { SqliteDatabase } from "./database";
import { handOverEngineSession } from "./engine-sessions";
import { notFoundError } from "./errors";
import {
  isActiveRunStatus,
  mapMessageRow,
  mapRunEventRow,
  mapRunRow,
  type ChannelBindingRow,
  type MessageRow,
  type RunEventRow,
  type RunRow,
} from "./rows";

/*
 * The Run lifecycle: the only code that sets a Run's status or writes its terminal chunk.
 * Lint forbids importing this module outside the storage modules that expose it.
 */

type ActiveEvent = "start" | "approval_requested" | "approval_decided";

/** The next status of an active Run per event; `null` leaves the status as it is. */
const ACTIVE_TRANSITIONS = {
  queued: { start: "running", approval_requested: "waiting_approval", approval_decided: null },
  running: { start: null, approval_requested: "waiting_approval", approval_decided: null },
  waiting_approval: { start: "running", approval_requested: null, approval_decided: "running" },
} as const satisfies Record<ActiveRunStatus, Record<ActiveEvent, ActiveRunStatus | null>>;

/** An end leads to the same status from every active status. */
const END_STATUS = {
  complete: "completed",
  fail: "failed",
  interrupt: "interrupted",
  server_restarted: "interrupted",
} as const satisfies Record<RunEnd["kind"], TerminalRunStatus>;

/** The terminal chunk type written with each terminal status. */
const TERMINAL_CHUNK_TYPE = {
  completed: "RUN_FINISHED",
  failed: "RUN_ERROR",
  interrupted: "RUN_ERROR",
  cancelled: "RUN_ERROR",
} as const satisfies Record<TerminalRunStatus, "RUN_FINISHED" | "RUN_ERROR">;

const SERVER_RESTARTED_DETAIL =
  "The server restarted while this Run was active; direct mode cannot resume it.";

function readRun(db: Database, runId: RunId): RunRow | undefined {
  return db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(runId) ?? undefined;
}

/** Applies an active event; the update is guarded on the status it was computed from. */
function applyActiveEvent(db: Database, runId: RunId, event: ActiveEvent, at: UtcTimestamp): void {
  const row = readRun(db, runId);
  if (row === undefined || !isActiveRunStatus(row.status)) {
    return;
  }
  const next = ACTIVE_TRANSITIONS[row.status][event];
  if (next !== null) {
    db.query("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(
      next,
      at,
      runId,
      row.status,
    );
  }
}

export interface NewRunRow {
  readonly id: RunId;
  readonly botId: string;
  readonly sessionId: string;
  readonly origin: string;
  readonly engine: string;
  readonly routineId: string | null;
  readonly routineSlot: string | null;
  readonly at: UtcTimestamp;
}

/** A Run is created queued. */
export function insertQueuedRun(db: Database, run: NewRunRow): void {
  db.query(
    `INSERT INTO runs
      (id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, checkpoint_json, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, ?, ?, NULL)`,
  ).run(
    run.id,
    run.botId,
    run.sessionId,
    run.origin,
    run.engine,
    run.routineId,
    run.routineSlot,
    run.at,
    run.at,
  );
}

/** Starts a Run, or records a new checkpoint on a running one. */
export async function startRun(
  database: SqliteDatabase,
  runId: RunId,
  checkpoint?: JsonValue | null,
): Promise<Run> {
  const now = formatUtcTimestamp(database.now());
  return database.inTransactionWithRetry((db) => {
    if (readRun(db, runId) === undefined) {
      throw notFoundError(
        "run.not_found",
        "Run not found",
        `Run ${runId} does not exist.`,
        `/api/runs/${runId}`,
      );
    }
    applyActiveEvent(db, runId, "start", now);
    if (checkpoint !== undefined && readRun(db, runId)?.status === "running") {
      db.query("UPDATE runs SET checkpoint_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(checkpoint),
        now,
        runId,
      );
    }
    return mapRunRow(readRun(db, runId)!);
  });
}

/** An Approval of an attended execution makes its Run wait; a detached execution's does not. */
export function recordApprovalRequested(
  db: Database,
  runId: RunId,
  awakeable: string,
  at: UtcTimestamp,
): void {
  const detached = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM script_runs WHERE 'script:' || id = ? AND detached_at IS NOT NULL",
    )
    .get(awakeable)!.n;
  if (detached === 0) {
    applyActiveEvent(db, runId, "approval_requested", at);
  }
}

/** A Run waits only on Approvals of attended executions; it runs again once none is pending. */
export function recordApprovalDecided(db: Database, runId: RunId, at: UtcTimestamp): void {
  const pending = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM approvals a
       WHERE a.run_id = ? AND a.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM script_runs s WHERE 'script:' || s.id = a.awakeable AND s.detached_at IS NOT NULL
         )`,
    )
    .get(runId)!.n;
  if (pending === 0) {
    applyActiveEvent(db, runId, "approval_decided", at);
  }
}

function terminalChunk(run: RunRow, end: RunEnd): JsonValue {
  const type = TERMINAL_CHUNK_TYPE[END_STATUS[end.kind]];
  switch (end.kind) {
    case "complete":
      return { type, threadId: run.session_id, runId: run.id };
    case "fail":
      return { type, message: end.detail, code: end.code, runId: run.id, threadId: run.session_id };
    case "interrupt":
      return {
        type,
        message: end.detail,
        code: "effect.outcome_uncertain",
        runId: run.id,
        threadId: run.session_id,
      };
    case "server_restarted":
      return {
        type,
        message: SERVER_RESTARTED_DETAIL,
        code: "run.server_restarted",
        runId: run.id,
        threadId: run.session_id,
      };
  }
}

function endDetail(end: RunEnd): string | undefined {
  switch (end.kind) {
    case "complete":
      return undefined;
    case "server_restarted":
      return SERVER_RESTARTED_DETAIL;
    default:
      return end.detail;
  }
}

function endCheckpoint(end: RunEnd, at: UtcTimestamp): string | null {
  return end.kind === "interrupt" && end.effectId !== undefined
    ? JSON.stringify({ interruptedEffectId: end.effectId, recordedAt: at })
    : null;
}

/**
 * Ends an active Run: its status, its one terminal chunk at the reserved key, its reply and its
 * outbox events, in one transaction. The first finish wins; a later one writes nothing.
 */
export async function finishRun(
  database: SqliteDatabase,
  input: FinishRunInput,
): Promise<FinishRunOutcome> {
  const now = formatUtcTimestamp(database.now());
  const instance = `/api/runs/${input.runId}`;

  return database.inTransactionWithRetry((db) => {
    const runRow = readRun(db, input.runId);
    if (runRow === undefined) {
      throw notFoundError(
        "run.not_found",
        "Run not found",
        `Run ${input.runId} does not exist.`,
        instance,
      );
    }

    const key = terminalChunkKey(input.runId);
    const atKey = db
      .query<RunEventRow, [string, string]>(
        "SELECT * FROM run_events WHERE run_id = ? AND chunk_key = ?",
      )
      .get(input.runId, key);

    if (!isActiveRunStatus(runRow.status)) {
      const stored = db
        .query<RunEventRow, [string]>(
          "SELECT * FROM run_events WHERE run_id = ? AND is_terminal = 1 ORDER BY sequence LIMIT 1",
        )
        .get(input.runId);
      if (stored === null) {
        throw new Error(`Run ${input.runId} ended without a terminal chunk`);
      }
      return {
        won: false,
        run: mapRunRow(runRow),
        terminalEvent: mapRunEventRow(stored),
        outboxEvents: [],
      };
    }
    if (atKey !== null) {
      throw new Error(`Run ${input.runId} is active and already holds a chunk at ${key}`);
    }

    const status = END_STATUS[input.end.kind];
    const usage = input.end.kind === "complete" ? input.end.usage : undefined;
    const sequence = db
      .query<{ next_seq: number }, [string]>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?",
      )
      .get(input.runId)!.next_seq;
    db.query(
      `INSERT INTO run_events (run_id, sequence, chunk_key, chunk_json, is_terminal, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(input.runId, sequence, key, JSON.stringify(terminalChunk(runRow, input.end)), now);
    db.query(
      `UPDATE runs
       SET status = ?, checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?, finished_at = ?,
           input_tokens = ?, cached_input_tokens = ?, cache_write_tokens = ?, output_tokens = ?, reported_cost_usd = ?
       WHERE id = ? AND status = ?`,
    ).run(
      status,
      endCheckpoint(input.end, now),
      now,
      now,
      usage?.inputTokens ?? null,
      usage?.cachedInputTokens ?? null,
      usage?.cacheWriteTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.reportedCostUsd ?? null,
      input.runId,
      runRow.status,
    );

    const finalMessage =
      input.end.kind === "complete" && (input.end.finalMessageParts?.length ?? 0) > 0
        ? insertReply(db, runRow, input.end.finalMessageParts!, now)
        : undefined;
    const outboxEvents = [
      ...(finalMessage === undefined ? [] : replyOutbox(db, runRow, finalMessage, now)),
      ...routineOutbox(db, runRow, status, endDetail(input.end), now),
    ];
    const engineSession = input.end.kind === "complete" ? input.end.engineSession : undefined;
    handOverEngineSession(
      db,
      runRow.session_id,
      engineSession && {
        ...engineSession,
        lastOrdinal: finalMessage?.ordinal ?? engineSession.lastOrdinal,
      },
      now,
    );

    return {
      won: true,
      run: mapRunRow(readRun(db, input.runId)!),
      terminalEvent: mapRunEventRow(
        db
          .query<RunEventRow, [string, number]>(
            "SELECT * FROM run_events WHERE run_id = ? AND sequence = ?",
          )
          .get(input.runId, sequence)!,
      ),
      ...(finalMessage !== undefined ? { finalMessage } : {}),
      outboxEvents,
    };
  });
}

function insertReply(
  db: Database,
  run: RunRow,
  parts: NonNullable<Extract<RunEnd, { kind: "complete" }>["finalMessageParts"]>,
  now: UtcTimestamp,
): Message {
  const existing = db
    .query<MessageRow, [string]>(
      "SELECT * FROM messages WHERE run_id = ? AND role = 'assistant' ORDER BY ordinal DESC LIMIT 1",
    )
    .get(run.id);
  if (existing) {
    return mapMessageRow(existing);
  }
  const ordinal = db
    .query<{ next_ordinal: number }, [string]>(
      "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM messages WHERE session_id = ?",
    )
    .get(run.session_id)!.next_ordinal;
  const messageId = `msg_${crypto.randomUUID()}`;
  db.query(
    `INSERT INTO messages (id, bot_id, session_id, ordinal, role, parts_json, run_id, created_at)
     VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?)`,
  ).run(messageId, run.bot_id, run.session_id, ordinal, JSON.stringify(parts), run.id, now);
  return mapMessageRow(
    db.query<MessageRow, [string]>("SELECT * FROM messages WHERE id = ?").get(messageId)!,
  );
}

function replyOutbox(
  db: Database,
  run: RunRow,
  message: Message,
  now: UtcTimestamp,
): OutboxEvent[] {
  const bindings = db
    .query<ChannelBindingRow, [string, string]>(
      `SELECT * FROM channel_bindings
       WHERE bot_id = ? AND session_id = ? AND enabled = 1
       ORDER BY created_at ASC, id ASC`,
    )
    .all(run.bot_id, run.session_id);
  const envelope: CloudEvent = {
    specversion: CLOUD_EVENT_SPEC_VERSION,
    id: `chat.replied:${run.id}`,
    source: `/bots/${run.bot_id}`,
    type: CLOUD_EVENT_TYPES.chatReplied,
    time: now,
    subject: `sessions/${run.session_id}/runs/${run.id}`,
    datacontenttype: "application/json",
    data: { botId: run.bot_id, sessionId: run.session_id, runId: run.id, message },
  };
  return insertOutboxForBindings(db, bindings, envelope, now);
}

function routineOutbox(
  db: Database,
  run: RunRow,
  status: TerminalRunStatus,
  detail: string | undefined,
  now: UtcTimestamp,
): OutboxEvent[] {
  if (run.routine_id === null) {
    return [];
  }
  const bindings = db
    .query<ChannelBindingRow, [string]>(
      `SELECT * FROM channel_bindings
       WHERE bot_id = ? AND enabled = 1
       ORDER BY created_at ASC, id ASC`,
    )
    .all(run.bot_id);
  const envelope: CloudEvent = {
    specversion: CLOUD_EVENT_SPEC_VERSION,
    id: `routine.finished:${run.id}`,
    source: `/bots/${run.bot_id}`,
    type: CLOUD_EVENT_TYPES.routineFinished,
    time: now,
    subject: `bots/${run.bot_id}/routines/${run.routine_id}/runs/${run.id}`,
    datacontenttype: "application/json",
    data: {
      botId: run.bot_id,
      routineId: run.routine_id,
      runId: run.id,
      sessionId: run.session_id,
      slot: run.routine_slot ?? run.created_at,
      outcome: status,
      finishedAt: now,
      ...(detail !== undefined ? { detail } : {}),
    },
  };
  return insertOutboxForBindings(db, bindings, envelope, now);
}
