import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { formatUtcTimestamp } from "@der/domain";

export interface StorageMigration {
  readonly version: string;
  readonly sql: string;
}

const coreMigrationPath = resolve(import.meta.dirname, "../migrations/001-core.sql");

export const CORE_MIGRATION: StorageMigration = {
  version: "001-core",
  sql: readFileSync(coreMigrationPath, "utf8"),
};

export const CORE_MIGRATIONS: readonly StorageMigration[] = [CORE_MIGRATION];

export function applyMigrations(
  db: Database,
  migrations: readonly StorageMigration[] = CORE_MIGRATIONS,
  now: () => Date = () => new Date(),
): readonly string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .query<{ version: string }, []>("SELECT version FROM schema_migrations")
    .all();
  const applied = new Set(appliedRows.map((row) => row.version));
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    const timestamp = formatUtcTimestamp(now());
    const runMigration = db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        timestamp,
      );
    });
    runMigration.immediate();
    applied.add(migration.version);
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}
