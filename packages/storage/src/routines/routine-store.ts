import {
  formatUtcTimestamp,
  type BotId,
  type EngineKind,
  type Routine,
  type RoutineId,
  type RoutineSlot,
  type RoutineSlotDisposition,
  type RoutineTarget,
  type RunId,
  type SessionId,
  type UtcTimestamp,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { SqliteDatabase } from "../database";
import { conflictError, notFoundError, validationError } from "../errors";
import { ensureMemoryRoutineSlotsMigration } from "../memory/migration";
import {
  ACTIVE_RUN_STATUS_SQL,
  mapBotRow,
  mapRoutineRow,
  type BotRow,
  type RoutineRow,
  type SessionRow,
} from "../rows";

interface RoutineSlotRow {
  readonly routine_id: string;
  readonly slot: string;
  readonly revision: number;
  readonly disposition: string;
  readonly run_id: string | null;
  readonly recorded_at: string;
}

function mapRoutineSlotRow(row: RoutineSlotRow): RoutineSlot {
  return compiledParsers.routineSlot.parse({
    routineId: row.routine_id,
    slot: row.slot,
    revision: row.revision,
    disposition: row.disposition,
    runId: row.run_id,
    recordedAt: row.recorded_at,
  });
}

export type CreateRoutineRecordInput = {
  readonly id?: RoutineId;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly revision?: number;
} & RoutineTarget;

export interface UpdateRoutineRecordInput {
  readonly name?: string;
  readonly cron?: string;
  readonly enabled?: boolean;
  readonly engine?: EngineKind;
  readonly prompt?: string;
  readonly script?: string;
  readonly expectedRevision?: number;
}

export function routineTargetColumns(target: RoutineTarget): {
  readonly prompt: string | null;
  readonly script: string | null;
} {
  return target.engine === "script"
    ? { prompt: null, script: target.script }
    : { prompt: target.prompt, script: null };
}

function routineText(target: RoutineTarget): string {
  return target.engine === "script" ? target.script : target.prompt;
}

function targetKindConflict(existing: Routine, instance: string) {
  return validationError(
    "routine.target_conflict",
    "Routine target cannot change kind",
    `Routine ${existing.id} runs a ${existing.engine === "script" ? "script" : "prompt"}; create a new routine to change it.`,
    instance,
  );
}

function patchedTarget(
  existing: Routine,
  patch: UpdateRoutineRecordInput,
  instance: string,
): RoutineTarget {
  if (existing.engine === "script") {
    if (patch.prompt !== undefined || patch.engine !== undefined) {
      throw targetKindConflict(existing, instance);
    }
    return { engine: "script", script: patch.script ?? existing.script };
  }
  if (patch.script !== undefined) {
    throw targetKindConflict(existing, instance);
  }
  return { engine: patch.engine ?? existing.engine, prompt: patch.prompt ?? existing.prompt };
}

export interface RecordRoutineSlotInput {
  readonly routineId: RoutineId;
  readonly slot: UtcTimestamp;
  readonly revision: number;
  readonly disposition: RoutineSlotDisposition;
  readonly runId: RunId | null;
}

export interface RecordRoutineSlotOutcome {
  readonly inserted: boolean;
  readonly slot: RoutineSlot;
}

export interface SqliteRoutinesOptions {
  readonly database: SqliteDatabase;
}

export class SqliteRoutines {
  readonly database: SqliteDatabase;

  constructor(options: SqliteRoutinesOptions) {
    this.database = options.database;
    ensureMemoryRoutineSlotsMigration(this.database);
  }

  async createRoutine(input: CreateRoutineRecordInput): Promise<Routine> {
    const now = formatUtcTimestamp(this.database.now());
    const routineId = input.id ?? `rt_${crypto.randomUUID()}`;
    const revision = input.revision ?? 1;
    const instance = `/api/bots/${input.botId}/routines`;

    if (
      input.name.trim().length === 0 ||
      input.cron.trim().length === 0 ||
      routineText(input).trim().length === 0
    ) {
      throw validationError(
        "routine.invalid_input",
        "Invalid routine input",
        "Routine name, cron, and prompt or script must be non-empty strings.",
        instance,
      );
    }

    return this.database.inTransactionWithRetry((db) => {
      const botRow = db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(input.botId);
      if (!botRow) {
        throw notFoundError(
          "bot.not_found",
          "Bot not found",
          `Bot ${input.botId} does not exist.`,
          instance,
        );
      }
      const bot = mapBotRow(botRow);
      if (input.engine !== "script" && !bot.allowedEngines.includes(input.engine)) {
        throw validationError(
          "routine.engine_not_allowed",
          "Engine is not allowed for bot",
          `Engine "${input.engine}" is not allowed on bot ${bot.id}.`,
          instance,
        );
      }

      const sessionRow = db
        .query<SessionRow, [string, string]>("SELECT * FROM sessions WHERE id = ? AND bot_id = ?")
        .get(input.sessionId, input.botId);
      if (!sessionRow) {
        throw notFoundError(
          "session.not_found",
          "Session not found in bot scope",
          `Session ${input.sessionId} does not belong to bot ${input.botId}.`,
          instance,
        );
      }

      const { prompt, script } = routineTargetColumns(input);
      db.query(
        `INSERT INTO routines (id, bot_id, session_id, name, cron, enabled, revision, engine, prompt, script, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        routineId,
        input.botId,
        input.sessionId,
        input.name,
        input.cron,
        input.enabled ? 1 : 0,
        revision,
        input.engine,
        prompt,
        script,
        now,
        now,
      );

      const row = db
        .query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?")
        .get(routineId);
      if (!row) {
        throw new Error(`Routine ${routineId} was not persisted`);
      }
      return mapRoutineRow(row);
    });
  }

  getRoutine(routineId: RoutineId): Routine | undefined {
    const row = this.database.db
      .query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?")
      .get(routineId);
    return row ? mapRoutineRow(row) : undefined;
  }

  listRoutines(botId?: BotId): Routine[] {
    if (botId !== undefined) {
      const rows = this.database.db
        .query<RoutineRow, [string]>(
          "SELECT * FROM routines WHERE bot_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(botId);
      return rows.map(mapRoutineRow);
    }
    const rows = this.database.db
      .query<RoutineRow, []>("SELECT * FROM routines ORDER BY created_at ASC, id ASC")
      .all();
    return rows.map(mapRoutineRow);
  }

  async updateRoutine(routineId: RoutineId, patch: UpdateRoutineRecordInput): Promise<Routine> {
    const now = formatUtcTimestamp(this.database.now());
    const instance = `/api/routines/${routineId}`;

    return this.database.inTransactionWithRetry((db) => {
      const existingRow = db
        .query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?")
        .get(routineId);
      if (!existingRow) {
        throw notFoundError(
          "routine.not_found",
          "Routine not found",
          `Routine ${routineId} does not exist.`,
          instance,
        );
      }

      const existing = mapRoutineRow(existingRow);
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== existing.revision) {
        throw conflictError(
          "routine.revision_conflict",
          "Routine revision conflict",
          `Expected routine revision ${patch.expectedRevision} for ${routineId}, but current revision is ${existing.revision}.`,
          instance,
        );
      }

      const nextName = patch.name ?? existing.name;
      const nextCron = patch.cron ?? existing.cron;
      const nextEnabled = patch.enabled ?? existing.enabled;
      const nextTarget = patchedTarget(existing, patch, instance);

      if (
        nextName.trim().length === 0 ||
        nextCron.trim().length === 0 ||
        routineText(nextTarget).trim().length === 0
      ) {
        throw validationError(
          "routine.invalid_input",
          "Invalid routine update",
          "Routine name, cron, and prompt or script must be non-empty strings.",
          instance,
        );
      }

      const botRow = db
        .query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?")
        .get(existing.botId);
      if (!botRow) {
        throw notFoundError(
          "bot.not_found",
          "Bot not found",
          `Bot ${existing.botId} does not exist.`,
          instance,
        );
      }
      const bot = mapBotRow(botRow);
      if (nextTarget.engine !== "script" && !bot.allowedEngines.includes(nextTarget.engine)) {
        throw validationError(
          "routine.engine_not_allowed",
          "Engine is not allowed for bot",
          `Engine "${nextTarget.engine}" is not allowed on bot ${bot.id}.`,
          instance,
        );
      }

      const nextRevision = existing.revision + 1;
      const nextColumns = routineTargetColumns(nextTarget);
      db.query(
        `UPDATE routines
         SET name = ?, cron = ?, enabled = ?, revision = ?, engine = ?, prompt = ?, script = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        nextName,
        nextCron,
        nextEnabled ? 1 : 0,
        nextRevision,
        nextTarget.engine,
        nextColumns.prompt,
        nextColumns.script,
        now,
        routineId,
      );

      const updated = db
        .query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?")
        .get(routineId);
      if (!updated) {
        throw new Error(`Routine ${routineId} disappeared after update`);
      }
      return mapRoutineRow(updated);
    });
  }

  getActiveRunId(sessionId: SessionId): RunId | undefined {
    const row = this.database.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM runs
         WHERE session_id = ? AND status IN ${ACTIVE_RUN_STATUS_SQL}
         LIMIT 1`,
      )
      .get(sessionId);
    return row?.id;
  }

  hasActiveRun(sessionId: SessionId): boolean {
    return this.getActiveRunId(sessionId) !== undefined;
  }

  getSlot(routineId: RoutineId, slot: UtcTimestamp): RoutineSlot | undefined {
    const row = this.database.db
      .query<RoutineSlotRow, [string, string]>(
        "SELECT * FROM routine_slots WHERE routine_id = ? AND slot = ?",
      )
      .get(routineId, slot);
    return row ? mapRoutineSlotRow(row) : undefined;
  }

  getLatestSlot(routineId: RoutineId): RoutineSlot | undefined {
    const row = this.database.db
      .query<RoutineSlotRow, [string]>(
        "SELECT * FROM routine_slots WHERE routine_id = ? ORDER BY slot DESC LIMIT 1",
      )
      .get(routineId);
    return row ? mapRoutineSlotRow(row) : undefined;
  }

  listSlots(routineId: RoutineId, options?: { readonly limit?: number }): RoutineSlot[] {
    const limit = options?.limit ?? 100;
    const rows = this.database.db
      .query<RoutineSlotRow, [string, number]>(
        "SELECT * FROM routine_slots WHERE routine_id = ? ORDER BY slot ASC LIMIT ?",
      )
      .all(routineId, limit);
    return rows.map(mapRoutineSlotRow);
  }

  async recordSlot(input: RecordRoutineSlotInput): Promise<RecordRoutineSlotOutcome> {
    const now = formatUtcTimestamp(this.database.now());
    const validated = compiledParsers.routineSlot.safeParse({
      routineId: input.routineId,
      slot: input.slot,
      revision: input.revision,
      disposition: input.disposition,
      runId: input.runId,
      recordedAt: now,
    });
    if (!validated.success) {
      throw validationError(
        "routine.invalid_slot",
        "Invalid routine slot",
        validated.error.message,
        `/api/routines/${input.routineId}`,
      );
    }

    return this.database.inTransactionWithRetry((db) => {
      const existing = db
        .query<RoutineSlotRow, [string, string]>(
          "SELECT * FROM routine_slots WHERE routine_id = ? AND slot = ?",
        )
        .get(input.routineId, input.slot);
      if (existing) {
        return { inserted: false, slot: mapRoutineSlotRow(existing) };
      }

      const routineRow = db
        .query<{ id: string }, [string]>("SELECT id FROM routines WHERE id = ?")
        .get(input.routineId);
      if (!routineRow) {
        throw notFoundError(
          "routine.not_found",
          "Routine not found",
          `Routine ${input.routineId} does not exist.`,
          `/api/routines/${input.routineId}`,
        );
      }

      db.query(
        `INSERT INTO routine_slots (routine_id, slot, revision, disposition, run_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.routineId, input.slot, input.revision, input.disposition, input.runId, now);

      const created = db
        .query<RoutineSlotRow, [string, string]>(
          "SELECT * FROM routine_slots WHERE routine_id = ? AND slot = ?",
        )
        .get(input.routineId, input.slot);
      if (!created) {
        throw new Error(`Routine slot ${input.routineId}@${input.slot} was not persisted`);
      }
      return { inserted: true, slot: mapRoutineSlotRow(created) };
    });
  }

  async updateSlotDisposition(
    routineId: RoutineId,
    slot: UtcTimestamp,
    disposition: RoutineSlotDisposition,
    runId?: RunId | null,
  ): Promise<RoutineSlot> {
    const now = formatUtcTimestamp(this.database.now());
    const instance = `/api/routines/${routineId}`;

    return this.database.inTransactionWithRetry((db) => {
      const existing = db
        .query<RoutineSlotRow, [string, string]>(
          "SELECT * FROM routine_slots WHERE routine_id = ? AND slot = ?",
        )
        .get(routineId, slot);
      if (!existing) {
        throw notFoundError(
          "routine.slot_not_found",
          "Routine slot not found",
          `Routine slot ${routineId}@${slot} does not exist.`,
          instance,
        );
      }

      const nextRunId = runId !== undefined ? runId : existing.run_id;
      db.query(
        `UPDATE routine_slots
         SET disposition = ?, run_id = ?, recorded_at = ?
         WHERE routine_id = ? AND slot = ?`,
      ).run(disposition, nextRunId, now, routineId, slot);

      const updated = db
        .query<RoutineSlotRow, [string, string]>(
          "SELECT * FROM routine_slots WHERE routine_id = ? AND slot = ?",
        )
        .get(routineId, slot);
      if (!updated) {
        throw new Error(`Routine slot ${routineId}@${slot} disappeared after update`);
      }
      return mapRoutineSlotRow(updated);
    });
  }
}

export function openSqliteRoutines(options: SqliteRoutinesOptions): SqliteRoutines {
  return new SqliteRoutines(options);
}
