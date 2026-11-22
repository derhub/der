import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations, CORE_MIGRATIONS, type StorageMigration } from "./migrations";

export interface SqliteDatabaseOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
  readonly maxBusyRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly extraMigrations?: readonly StorageMigration[];
  readonly now?: () => Date;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BUSY_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 15;

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = error.message;
  return (
    message.includes("SQLITE_BUSY") ||
    message.includes("SQLITE_LOCKED") ||
    message.includes("database is locked") ||
    message.includes("database table is locked")
  );
}

export class SqliteDatabase {
  readonly db: Database;
  readonly filename: string;
  readonly busyTimeoutMs: number;
  readonly maxBusyRetries: number;
  readonly retryBaseDelayMs: number;
  readonly now: () => Date;

  constructor(options: SqliteDatabaseOptions) {
    this.filename = options.filename;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.maxBusyRetries = options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.now = options.now ?? (() => new Date());

    if (options.filename !== ":memory:" && !options.filename.startsWith("file:")) {
      mkdirSync(dirname(options.filename), { recursive: true });
    }

    this.db = new Database(options.filename, { create: true, strict: true });
    this.configurePragmas();

    const migrations = options.extraMigrations
      ? [...CORE_MIGRATIONS, ...options.extraMigrations]
      : CORE_MIGRATIONS;
    applyMigrations(this.db, migrations, this.now);
  }

  private configurePragmas(): void {
    this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (this.filename !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  journalMode(): string {
    const row = this.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get();
    return row?.journal_mode ?? "unknown";
  }

  foreignKeysEnabled(): boolean {
    const row = this.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys;").get();
    return row?.foreign_keys === 1;
  }

  busyTimeout(): number {
    const row = this.db.query<{ timeout: number }, []>("PRAGMA busy_timeout;").get();
    return row?.timeout ?? 0;
  }

  inTransaction<T>(fn: (db: Database) => T): T {
    const runner = this.db.transaction(() => fn(this.db));
    return runner.immediate();
  }

  async inTransactionWithRetry<T>(fn: (db: Database) => T): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return this.inTransaction(fn);
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt >= this.maxBusyRetries) {
          throw error;
        }
        attempt += 1;
        const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
        await Bun.sleep(delayMs);
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
