import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { formatUtcTimestamp } from "@der/domain";

export interface StorageMigration {
  readonly version: string;
  readonly sql: string;
  readonly disableForeignKeys?: boolean;
}

const coreMigrationPath = resolve(import.meta.dirname, "../migrations/001-core.sql");
const outboxDestinationsMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/003-outbox-destinations.sql",
);

const capabilityOperationKindMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/004-capability-operation-kind.sql",
);

const scriptRunsMigrationPath = resolve(import.meta.dirname, "../migrations/005-script-runs.sql");

const scriptRoutinesMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/006-script-routines.sql",
);

const runUsageMigrationPath = resolve(import.meta.dirname, "../migrations/007-run-usage.sql");

const engineSessionsMigrationPath = resolve(
  import.meta.dirname,
  "../migrations/008-engine-sessions.sql",
);

export const CORE_MIGRATION: StorageMigration = {
  version: "001-core",
  sql: readFileSync(coreMigrationPath, "utf8"),
};

export const OUTBOX_DESTINATIONS_MIGRATION: StorageMigration = {
  version: "003-outbox-destinations",
  sql: readFileSync(outboxDestinationsMigrationPath, "utf8"),
  disableForeignKeys: true,
};

export const CAPABILITY_OPERATION_KIND_MIGRATION: StorageMigration = {
  version: "004-capability-operation-kind",
  sql: readFileSync(capabilityOperationKindMigrationPath, "utf8"),
  disableForeignKeys: true,
};

export const SCRIPT_RUNS_MIGRATION: StorageMigration = {
  version: "005-script-runs",
  sql: readFileSync(scriptRunsMigrationPath, "utf8"),
};

export const SCRIPT_ROUTINES_MIGRATION: StorageMigration = {
  version: "006-script-routines",
  sql: readFileSync(scriptRoutinesMigrationPath, "utf8"),
  disableForeignKeys: true,
};

export const RUN_USAGE_MIGRATION: StorageMigration = {
  version: "007-run-usage",
  sql: readFileSync(runUsageMigrationPath, "utf8"),
};

export const ENGINE_SESSIONS_MIGRATION: StorageMigration = {
  version: "008-engine-sessions",
  sql: readFileSync(engineSessionsMigrationPath, "utf8"),
};

export const CORE_MIGRATIONS: readonly StorageMigration[] = [
  CORE_MIGRATION,
  OUTBOX_DESTINATIONS_MIGRATION,
  CAPABILITY_OPERATION_KIND_MIGRATION,
  SCRIPT_RUNS_MIGRATION,
  SCRIPT_ROUTINES_MIGRATION,
  RUN_USAGE_MIGRATION,
  ENGINE_SESSIONS_MIGRATION,
];

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
    const foreignKeysRow = migration.disableForeignKeys
      ? db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys;").get()
      : undefined;
    const restoreForeignKeys = foreignKeysRow?.foreign_keys === 1;

    if (restoreForeignKeys) {
      db.exec("PRAGMA foreign_keys = OFF;");
    }

    try {
      const runMigration = db.transaction(() => {
        db.exec(migration.sql);
        if (migration.disableForeignKeys) {
          const violations = db
            .query<Record<string, unknown>, []>("PRAGMA foreign_key_check;")
            .all();
          if (violations.length > 0) {
            throw new Error(
              `Migration ${migration.version} failed foreign_key_check with ${violations.length} violation(s).`,
            );
          }
        }
        db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration.version,
          timestamp,
        );
      });
      runMigration.immediate();
    } finally {
      if (restoreForeignKeys) {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    }

    applied.add(migration.version);
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}
