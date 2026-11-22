import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SqliteDatabase } from "../database";
import { applyMigrations, type StorageMigration } from "../migrations";

const memoryRoutineSlotsPath = resolve(
  import.meta.dirname,
  "../../migrations/002-memory-routine-slots.sql",
);

export const MEMORY_ROUTINE_SLOTS_MIGRATION: StorageMigration = {
  version: "002-memory-routine-slots",
  sql: readFileSync(memoryRoutineSlotsPath, "utf8"),
};

export function ensureMemoryRoutineSlotsMigration(database: SqliteDatabase): readonly string[] {
  return applyMigrations(database.db, [MEMORY_ROUTINE_SLOTS_MIGRATION], database.now);
}
