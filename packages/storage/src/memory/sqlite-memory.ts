import {
  formatUtcTimestamp,
  type BotId,
  type Memory,
  type MemoryRecord,
  type MemoryWriteInput,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { SqliteDatabase } from "../database";
import { conflictError, notFoundError, validationError } from "../errors";
import type { MemoryProjection, MemoryReconciliationResult } from "./markdown-projection";
import { ensureMemoryRoutineSlotsMigration } from "./migration";

interface MemoryRow {
  readonly id: string;
  readonly bot_id: string;
  readonly version: number;
  readonly markdown: string;
  readonly updated_at: string;
}

function mapMemoryRow(row: MemoryRow): MemoryRecord {
  return compiledParsers.memoryRecord.parse({
    id: row.id,
    botId: row.bot_id,
    version: row.version,
    markdown: row.markdown,
    updatedAt: row.updated_at,
  });
}

export interface SqliteMemoryOptions {
  readonly database: SqliteDatabase;
  readonly projection?: MemoryProjection;
}

export class SqliteMemory implements Memory {
  readonly database: SqliteDatabase;
  readonly projection: MemoryProjection | undefined;

  constructor(options: SqliteMemoryOptions) {
    this.database = options.database;
    this.projection = options.projection;
    ensureMemoryRoutineSlotsMigration(this.database);
  }

  async read(botId: BotId, version?: number): Promise<MemoryRecord | undefined> {
    if (version !== undefined) {
      if (!Number.isInteger(version) || version <= 0) {
        throw validationError(
          "memory.invalid_version",
          "Invalid memory version",
          `Memory version must be a positive integer; received ${version}.`,
          `/api/bots/${botId}/memory`,
        );
      }
      const row = this.database.db
        .query<MemoryRow, [string, number]>(
          "SELECT * FROM memories WHERE bot_id = ? AND version = ?",
        )
        .get(botId, version);
      return row ? mapMemoryRow(row) : undefined;
    }

    const row = this.database.db
      .query<MemoryRow, [string]>(
        "SELECT * FROM memories WHERE bot_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(botId);
    return row ? mapMemoryRow(row) : undefined;
  }

  listVersions(botId: BotId): MemoryRecord[] {
    const rows = this.database.db
      .query<MemoryRow, [string]>("SELECT * FROM memories WHERE bot_id = ? ORDER BY version ASC")
      .all(botId);
    return rows.map(mapMemoryRow);
  }

  async write(input: MemoryWriteInput): Promise<MemoryRecord> {
    const parsed = compiledParsers.memoryWriteInput.safeParse(input);
    if (!parsed.success) {
      throw validationError(
        "memory.invalid_input",
        "Invalid memory write input",
        parsed.error.message,
        `/api/bots/${input.botId ?? "unknown"}/memory`,
      );
    }

    const valid = parsed.data;
    const instance = `/api/bots/${valid.botId}/memory`;
    const now = formatUtcTimestamp(this.database.now());

    const committed = await this.database.inTransactionWithRetry((db) => {
      const botExists = db
        .query<{ id: string }, [string]>("SELECT id FROM bots WHERE id = ?")
        .get(valid.botId);
      if (!botExists) {
        throw notFoundError(
          "bot.not_found",
          "Bot not found",
          `Bot ${valid.botId} does not exist.`,
          instance,
        );
      }

      const latestRow = db
        .query<{ version: number }, [string]>(
          "SELECT COALESCE(MAX(version), 0) AS version FROM memories WHERE bot_id = ?",
        )
        .get(valid.botId);
      const currentVersion = latestRow?.version ?? 0;

      if (valid.expectedVersion !== undefined && valid.expectedVersion !== currentVersion) {
        throw conflictError(
          "memory.version_conflict",
          "Memory version conflict",
          `Expected memory version ${valid.expectedVersion} for bot ${valid.botId}, but current version is ${currentVersion}.`,
          instance,
        );
      }

      const nextVersion = currentVersion + 1;
      const memoryId = `mem_${crypto.randomUUID()}`;

      db.query(
        `INSERT INTO memories (id, bot_id, version, markdown, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(memoryId, valid.botId, nextVersion, valid.markdown, now);

      const inserted = db
        .query<MemoryRow, [string]>("SELECT * FROM memories WHERE id = ?")
        .get(memoryId);
      if (!inserted) {
        throw new Error(`Memory ${memoryId} was not persisted`);
      }
      return mapMemoryRow(inserted);
    });

    if (this.projection) {
      const latest = (await this.read(valid.botId)) ?? committed;
      await this.projection.reconcile(latest);
    }

    return committed;
  }

  async reconcile(botId?: BotId): Promise<readonly MemoryReconciliationResult[]> {
    if (!this.projection) {
      return [];
    }

    if (botId !== undefined) {
      const latest = await this.read(botId);
      if (!latest) {
        return [];
      }
      return [await this.projection.reconcile(latest)];
    }

    const latestRows = this.database.db
      .query<MemoryRow, []>(
        `SELECT m.*
         FROM memories m
         INNER JOIN (
           SELECT bot_id, MAX(version) AS max_version
           FROM memories
           GROUP BY bot_id
         ) latest
           ON m.bot_id = latest.bot_id AND m.version = latest.max_version
         ORDER BY m.bot_id ASC`,
      )
      .all();

    const results: MemoryReconciliationResult[] = [];
    for (const row of latestRows) {
      results.push(await this.projection.reconcile(mapMemoryRow(row)));
    }
    return results;
  }
}

export function openSqliteMemory(options: SqliteMemoryOptions): SqliteMemory {
  return new SqliteMemory(options);
}
