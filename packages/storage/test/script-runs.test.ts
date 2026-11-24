import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { applyMigrations, CORE_MIGRATIONS, openSqliteStore } from "@der/storage";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("script steps migration", () => {
  it("keeps script runs of every status when migrating from 006", () => {
    const dir = mkdtempSync(join(tmpdir(), "der-script-steps-migration-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "der.sqlite");
    const ts = "2026-11-22T15:00:00.000Z";
    const legacy = new Database(dbPath, { create: true, strict: true });
    legacy.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacy, CORE_MIGRATIONS.slice(0, 5));
    legacy
      .query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, created_at, updated_at)
         VALUES ('bot-old', 'Old Bot', 'Concise', 'fixture', '["fixture"]', NULL, ?, ?)`,
      )
      .run(ts, ts);
    legacy
      .query(
        `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
         VALUES ('sess-old', 'bot-old', 'Old Session', 'fixture', ?, ?)`,
      )
      .run(ts, ts);
    legacy
      .query(
        `INSERT INTO runs (id, bot_id, session_id, origin, engine, status, created_at, updated_at)
         VALUES ('run-old', 'bot-old', 'sess-old', 'web', 'fixture', 'running', ?, ?)`,
      )
      .run(ts, ts);
    const insert = legacy.query(
      `INSERT INTO script_runs (id, run_id, bot_id, digest, occurrence, source, status, result_json, created_at, updated_at)
       VALUES (?, 'run-old', 'bot-old', 'abc', ?, 'return 1', ?, ?, ?, ?)`,
    );
    insert.run("sr-1", 1, "interrupted", '{"ok":true}', ts, ts);
    insert.run("sr-2", 2, "running", null, ts, ts);
    legacy.close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      const db = store.database.db;
      expect(
        db
          .query(
            "SELECT id, status, result_json, seed, lease_owner, lease_until, detached_at FROM script_runs ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: "sr-1",
          status: "interrupted",
          result_json: '{"ok":true}',
          seed: 0,
          lease_owner: null,
          lease_until: null,
          detached_at: null,
        },
        {
          id: "sr-2",
          status: "running",
          result_json: null,
          seed: 0,
          lease_owner: null,
          lease_until: null,
          detached_at: null,
        },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
