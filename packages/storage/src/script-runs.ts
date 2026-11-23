import { createHash } from "node:crypto";
import {
  formatUtcTimestamp,
  scriptRun as scriptRunSchema,
  type Approval,
  type BotId,
  type ExecuteResult,
  type RunId,
  type ScriptRun,
  type ScriptRunStatus,
  type TerminalScriptRunStatus,
} from "@der/domain";
import type { SqliteDatabase } from "./database";
import { notFoundError } from "./errors";
import { mapApprovalRow, type ApprovalRow } from "./rows";

interface ScriptRunRow {
  readonly id: string;
  readonly run_id: string;
  readonly bot_id: string;
  readonly digest: string;
  readonly occurrence: number;
  readonly source: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly delivered_at: string | null;
}

const TERMINAL_STATUSES: readonly ScriptRunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

function mapScriptRunRow(row: ScriptRunRow): ScriptRun {
  return scriptRunSchema.parse({
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
}

export function digestScriptSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function isTerminalScriptRunStatus(
  status: ScriptRunStatus,
): status is TerminalScriptRunStatus {
  return TERMINAL_STATUSES.includes(status);
}

export interface AcquireScriptRunInput {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly source: string;
}

export interface AcquireScriptRunOutcome {
  readonly scriptRun: ScriptRun;
  readonly created: boolean;
}

const CANCELLED_RESULT: ExecuteResult = {
  ok: false,
  error: { kind: "cancelled", message: "script cancelled" },
  logs: [],
};

const INTERRUPTED_RESULT: ExecuteResult = {
  ok: false,
  error: { kind: "capability", message: "script was interrupted by a server restart" },
  logs: [],
};

export class ScriptRunBusyError extends Error {
  readonly blockedBy: ScriptRun;

  constructor(blockedBy: ScriptRun) {
    super(`ScriptRun ${blockedBy.id} is still ${blockedBy.status} in Run ${blockedBy.runId}.`);
    this.name = "ScriptRunBusyError";
    this.blockedBy = blockedBy;
  }
}

export interface SqliteScriptRunsOptions {
  readonly database: SqliteDatabase;
}

export class SqliteScriptRuns {
  readonly database: SqliteDatabase;

  constructor(options: SqliteScriptRunsOptions) {
    this.database = options.database;
  }

  async acquire(input: AcquireScriptRunInput): Promise<AcquireScriptRunOutcome> {
    const digest = digestScriptSource(input.source);
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransactionWithRetry((db) => {
      const pending = db
        .query<ScriptRunRow, [string, string]>(
          `SELECT * FROM script_runs
           WHERE run_id = ? AND digest = ? AND delivered_at IS NULL
           ORDER BY occurrence DESC LIMIT 1`,
        )
        .get(input.runId, digest);
      if (pending) {
        return { scriptRun: mapScriptRunRow(pending), created: false };
      }

      const active = db
        .query<ScriptRunRow, [string]>(
          `SELECT * FROM script_runs
           WHERE run_id = ? AND status IN ('running', 'waiting_approval')
           ORDER BY created_at ASC, occurrence ASC LIMIT 1`,
        )
        .get(input.runId);
      if (active) {
        throw new ScriptRunBusyError(mapScriptRunRow(active));
      }

      const latest = db
        .query<{ occurrence: number | null }, [string, string]>(
          "SELECT MAX(occurrence) AS occurrence FROM script_runs WHERE run_id = ? AND digest = ?",
        )
        .get(input.runId, digest);
      const id = `sr_${crypto.randomUUID()}`;
      db.query(
        `INSERT INTO script_runs
          (id, run_id, bot_id, digest, occurrence, source, status, result_json, delivered_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)`,
      ).run(
        id,
        input.runId,
        input.botId,
        digest,
        (latest?.occurrence ?? 0) + 1,
        input.source,
        now,
        now,
      );
      const created = db
        .query<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE id = ?")
        .get(id);
      if (!created) {
        throw new Error(`ScriptRun ${id} was not persisted`);
      }
      return { scriptRun: mapScriptRunRow(created), created: true };
    });
  }

  get(id: string): ScriptRun | undefined {
    const row = this.database.db
      .query<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE id = ?")
      .get(id);
    return row ? mapScriptRunRow(row) : undefined;
  }

  listUnfinished(runId: RunId): ScriptRun[] {
    return this.database.db
      .query<ScriptRunRow, [string]>(
        `SELECT * FROM script_runs
         WHERE run_id = ? AND status IN ('running', 'waiting_approval')
         ORDER BY created_at ASC, occurrence ASC`,
      )
      .all(runId)
      .map(mapScriptRunRow);
  }

  listPendingApprovals(id: string): Approval[] {
    const row = this.get(id);
    if (!row) {
      return [];
    }
    const prefix = `${id}:`;
    return this.database.db
      .query<ApprovalRow, [string, number, string]>(
        `SELECT * FROM approvals
         WHERE run_id = ? AND status = 'pending' AND substr(attempt_id, 1, ?) = ?`,
      )
      .all(row.runId, prefix.length, prefix)
      .map(mapApprovalRow);
  }

  async setStatus(id: string, status: "running" | "waiting_approval"): Promise<ScriptRun> {
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransactionWithRetry((db) => {
      db.query(
        `UPDATE script_runs SET status = ?, updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting_approval')`,
      ).run(status, now, id);
      return this.require(
        db.query<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE id = ?").get(id),
        id,
      );
    });
  }

  async interruptAbandoned(): Promise<number> {
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransactionWithRetry(
      (db) =>
        db
          .query(
            `UPDATE script_runs SET status = 'interrupted', result_json = ?, updated_at = ?
             WHERE status IN ('running', 'waiting_approval')`,
          )
          .run(JSON.stringify(INTERRUPTED_RESULT), now).changes,
    );
  }

  async requestCancel(id: string): Promise<void> {
    const now = formatUtcTimestamp(this.database.now());
    await this.database.inTransactionWithRetry((db) => {
      db.query(
        `UPDATE script_runs SET result_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting_approval') AND result_json IS NULL`,
      ).run(JSON.stringify(CANCELLED_RESULT), now, id);
    });
  }

  isCancelRequested(id: string): boolean {
    const row = this.database.db
      .query<{ status: string; result_json: string | null }, [string]>(
        "SELECT status, result_json FROM script_runs WHERE id = ?",
      )
      .get(id);
    if (row === null) {
      return false;
    }
    const active = row.status === "running" || row.status === "waiting_approval";
    return row.status === "cancelled" || (active && row.result_json !== null);
  }

  async finish(
    id: string,
    status: TerminalScriptRunStatus,
    result: ExecuteResult,
  ): Promise<ScriptRun> {
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransactionWithRetry((db) => {
      db.query(
        `UPDATE script_runs SET status = ?, result_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting_approval')`,
      ).run(status, JSON.stringify(result), now, id);
      return this.require(
        db.query<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE id = ?").get(id),
        id,
      );
    });
  }

  async markDelivered(id: string): Promise<ScriptRun> {
    const now = formatUtcTimestamp(this.database.now());
    return this.database.inTransactionWithRetry((db) => {
      db.query(
        `UPDATE script_runs SET delivered_at = COALESCE(delivered_at, ?), updated_at = ?
         WHERE id = ? AND status NOT IN ('running', 'waiting_approval')`,
      ).run(now, now, id);
      return this.require(
        db.query<ScriptRunRow, [string]>("SELECT * FROM script_runs WHERE id = ?").get(id),
        id,
      );
    });
  }

  private require(row: ScriptRunRow | null, id: string): ScriptRun {
    if (!row) {
      throw notFoundError(
        "script_run.not_found",
        "ScriptRun not found",
        `ScriptRun ${id} does not exist.`,
        `/api/script-runs/${id}`,
      );
    }
    return mapScriptRunRow(row);
  }
}

export function openSqliteScriptRuns(options: SqliteScriptRunsOptions): SqliteScriptRuns {
  return new SqliteScriptRuns(options);
}
