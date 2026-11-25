import { createHash } from "node:crypto";
import {
  formatUtcTimestamp,
  scriptRun as scriptRunSchema,
  type AcquireScript,
  type DeliveryMark,
  type FinishResult,
  type JsonValue,
  type NewStep,
  type ScriptEnd,
  type ScriptExecution,
  type ScriptRunId,
  type ScriptStore,
  type StepOutcome,
  type StoredStep,
  type UtcTimestamp,
} from "@der/domain";
import type { SqliteDatabase } from "./database";
import { notFoundError } from "./errors";
import { ACTIVE_RUN_STATUS_SQL } from "./rows";
import { recordApprovalDecided } from "./run-lifecycle";
import { enqueueSessionEvent } from "./session-events";

interface ExecutionRow {
  readonly id: string;
  readonly run_id: string;
  readonly bot_id: string;
  readonly digest: string;
  readonly key: string;
  readonly occurrence: number;
  readonly source: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly seed: number;
  readonly created_at: string;
  readonly lease_owner: string | null;
  readonly lease_until: string | null;
  readonly detached_at: string | null;
  readonly delivered_at: string | null;
}

interface StepRow {
  readonly position: number;
  readonly capability: string;
  readonly effect: string;
  readonly decision: string;
  readonly input_hash: string;
  readonly input_json: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly error_json: string | null;
  readonly seq: number | null;
  readonly batch: number | null;
  readonly round: number | null;
}

const ACTIVE = "('running', 'waiting_approval')";

function mapExecution(row: ExecutionRow): ScriptExecution {
  const parsed = scriptRunSchema.parse({
    id: row.id,
    runId: row.run_id,
    botId: row.bot_id,
    digest: row.digest,
    occurrence: row.occurrence,
    source: row.source,
    status: row.status,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
    deliveredAt: row.delivered_at,
  });
  return {
    id: parsed.id,
    runId: parsed.runId,
    botId: parsed.botId,
    digest: parsed.digest,
    key: row.key,
    occurrence: parsed.occurrence,
    source: parsed.source,
    status: parsed.status,
    result: parsed.result,
    seed: row.seed,
    createdAt: row.created_at as UtcTimestamp,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until as UtcTimestamp | null,
    detachedAt: row.detached_at as UtcTimestamp | null,
  };
}

function parseJson(text: string | null): JsonValue | null {
  return text === null ? null : (JSON.parse(text) as JsonValue);
}

function mapStep(row: StepRow): StoredStep {
  return {
    position: row.position,
    capability: row.capability,
    effect: row.effect as StoredStep["effect"],
    decision: row.decision as StoredStep["decision"],
    inputHash: row.input_hash,
    input: JSON.parse(row.input_json) as JsonValue,
    status: row.status as StoredStep["status"],
    result: parseJson(row.result_json),
    error: parseJson(row.error_json),
    seq: row.seq,
    batch: row.batch,
    round: row.round,
  };
}

export interface SqliteScriptStoreOptions {
  readonly database: SqliteDatabase;
}

export class SqliteScriptStore implements ScriptStore {
  readonly database: SqliteDatabase;

  constructor(options: SqliteScriptStoreOptions) {
    this.database = options.database;
  }

  acquire(input: AcquireScript): ScriptExecution {
    const digest = createHash("sha256").update(input.source).digest("hex");
    const key = input.key ?? "";
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransaction((db) => {
      const existing = db
        .query<ExecutionRow, [string, string, string]>(
          `SELECT * FROM script_runs
           WHERE run_id = ? AND digest = ? AND key = ?
           ORDER BY occurrence DESC LIMIT 1`,
        )
        .get(input.runId, digest, key);
      if (existing) {
        return mapExecution(existing);
      }
      const id = `sr_${crypto.randomUUID()}`;
      db.query(
        `INSERT INTO script_runs
          (id, run_id, bot_id, digest, key, occurrence, source, status, seed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'running', ?, ?, ?)`,
      ).run(id, input.runId, input.botId, digest, key, input.source, input.seed, now, now);
      return this.#execution(db, id);
    });
  }

  load(id: ScriptRunId): { execution: ScriptExecution; steps: readonly StoredStep[] } {
    const execution = this.#execution(this.database.db, id);
    const steps = this.database.db
      .query<StepRow, [string]>(
        "SELECT * FROM script_steps WHERE script_run_id = ? ORDER BY position",
      )
      .all(id)
      .map(mapStep);
    return { execution, steps };
  }

  registerSteps(id: ScriptRunId, steps: readonly NewStep[]): readonly StoredStep[] {
    return this.database.inTransaction((db) => {
      const insert = db.query(
        `INSERT OR IGNORE INTO script_steps
          (script_run_id, position, capability, effect, decision, input_hash, input_json, status, round)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      const select = db.query<StepRow, [string, number]>(
        "SELECT * FROM script_steps WHERE script_run_id = ? AND position = ?",
      );
      return steps.map((step) => {
        insert.run(
          id,
          step.position,
          step.capability,
          step.effect,
          step.decision,
          step.inputHash,
          JSON.stringify(step.input),
          step.round ?? null,
        );
        return mapStep(select.get(id, step.position)!);
      });
    });
  }

  completeStep(id: ScriptRunId, position: number, outcome: StepOutcome): void {
    this.database.db
      .query(
        `UPDATE script_steps SET status = ?, result_json = ?, error_json = ?
         WHERE script_run_id = ? AND position = ? AND status = 'pending'`,
      )
      .run(
        outcome.status,
        outcome.result === undefined ? null : JSON.stringify(outcome.result),
        outcome.error === undefined ? null : JSON.stringify(outcome.error),
        id,
        position,
      );
  }

  markDelivered(id: ScriptRunId, positions: readonly number[]): readonly DeliveryMark[] {
    return this.database.inTransaction((db) => {
      const select = db.query<StepRow, [string, number]>(
        "SELECT * FROM script_steps WHERE script_run_id = ? AND position = ?",
      );
      const undelivered = positions.filter((position) => {
        const step = select.get(id, position);
        if (!step) {
          throw new Error(`ScriptRun ${id} has no step at position ${position}.`);
        }
        return step.seq === null;
      });
      if (undelivered.length > 0) {
        const last = db
          .query<{ seq: number | null; batch: number | null }, [string]>(
            "SELECT MAX(seq) AS seq, MAX(batch) AS batch FROM script_steps WHERE script_run_id = ?",
          )
          .get(id)!;
        const batch = (last.batch ?? 0) + 1;
        const update = db.query(
          "UPDATE script_steps SET seq = ?, batch = ? WHERE script_run_id = ? AND position = ?",
        );
        undelivered.forEach((position, index) => {
          update.run((last.seq ?? 0) + 1 + index, batch, id, position);
        });
      }
      return positions.map((position) => {
        const step = select.get(id, position)!;
        return { position, seq: step.seq!, batch: step.batch! };
      });
    });
  }

  finish(id: ScriptRunId, end: ScriptEnd): FinishResult {
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransaction((db) => {
      const changed =
        db
          .query(
            `UPDATE script_runs SET status = ?, result_json = ?, updated_at = ?
             WHERE id = ? AND status IN ${ACTIVE}`,
          )
          .run(end.status, JSON.stringify(end.result), now, id).changes === 1;
      const execution = this.#execution(db, id);
      const detached = execution.detachedAt !== null;
      if (changed && detached) {
        const run = db
          .query<{ session_id: string }, [string]>("SELECT session_id FROM runs WHERE id = ?")
          .get(execution.runId);
        enqueueSessionEvent(
          db,
          {
            botId: execution.botId,
            sessionId: run!.session_id,
            kind: "script.finished",
            payload: {
              event: "script.finished",
              executionId: id,
              status: end.status,
              result: end.result as unknown as JsonValue,
            },
          },
          now,
        );
      }
      return { execution, detached };
    });
  }

  detach(id: ScriptRunId): boolean {
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransaction((db) => {
      const changed =
        db
          .query(
            `UPDATE script_runs SET detached_at = ?
             WHERE id = ? AND detached_at IS NULL AND status IN ${ACTIVE}`,
          )
          .run(now, id).changes === 1;
      if (changed) {
        recordApprovalDecided(db, this.#execution(db, id).runId, now);
      }
      return changed;
    });
  }

  takeLease(id: ScriptRunId, owner: string, until: UtcTimestamp): boolean {
    const now = formatUtcTimestamp(this.database.now());
    return (
      this.database.db
        .query(
          `UPDATE script_runs SET lease_owner = ?, lease_until = ?
           WHERE id = ? AND status IN ${ACTIVE}
             AND (lease_owner IS NULL OR lease_owner = ? OR lease_until <= ?)`,
        )
        .run(owner, until, id, owner, now).changes === 1
    );
  }

  releaseLease(id: ScriptRunId, owner: string): void {
    this.database.db
      .query(
        "UPDATE script_runs SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?",
      )
      .run(id, owner);
  }

  listDrivable(now: UtcTimestamp): readonly ScriptRunId[] {
    return this.database.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM script_runs
         WHERE status IN ${ACTIVE} AND (lease_owner IS NULL OR lease_until <= ?)
         ORDER BY created_at, occurrence, id`,
      )
      .all(now)
      .map((row) => row.id);
  }

  listInDoubtWithActiveRun(): readonly ScriptRunId[] {
    return this.database.db
      .query<{ id: string }, []>(
        `SELECT s.id FROM script_runs s JOIN runs r ON r.id = s.run_id
         WHERE s.status = 'in_doubt' AND r.status IN ${ACTIVE_RUN_STATUS_SQL}
         ORDER BY s.created_at, s.occurrence, s.id`,
      )
      .all()
      .map((row) => row.id);
  }

  #execution(db: SqliteDatabase["db"], id: string): ScriptExecution {
    const row = db.query<ExecutionRow, [string]>("SELECT * FROM script_runs WHERE id = ?").get(id);
    if (!row) {
      throw notFoundError(
        "script_run.not_found",
        "ScriptRun not found",
        `ScriptRun ${id} does not exist.`,
        `/api/script-runs/${id}`,
      );
    }
    return mapExecution(row);
  }
}

export function openSqliteScriptStore(options: SqliteScriptStoreOptions): SqliteScriptStore {
  return new SqliteScriptStore(options);
}
