import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  applyMigrations,
  CORE_MIGRATIONS,
  openSqliteScriptStore,
  openSqliteStore,
} from "@der/storage";

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

describe("script run key migration", () => {
  it("keeps every execution with an empty key when migrating from 011 and returns the latest occurrence", () => {
    const dir = mkdtempSync(join(tmpdir(), "der-script-key-migration-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "der.sqlite");
    const ts = "2026-11-22T15:00:00.000Z";
    const legacy = new Database(dbPath, { create: true, strict: true });
    legacy.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacy, CORE_MIGRATIONS.slice(0, 10));
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
      `INSERT INTO script_runs (id, run_id, bot_id, digest, occurrence, source, status, result_json, delivered_at, created_at, updated_at)
       VALUES (?, 'run-old', 'bot-old', ?, ?, 'return 1', ?, ?, ?, ?, ?)`,
    );
    const digest = "486d9affb60dbb0063b03d8e23a6ccf6364ce203dc3a9f56f20e750eb41ecade";
    insert.run(
      "sr-1",
      digest,
      1,
      "completed",
      '{"ok":true,"result":1,"logs":[],"truncated":false}',
      ts,
      ts,
      ts,
    );
    insert.run("sr-2", digest, 2, "running", null, null, ts, ts);
    legacy
      .query(
        `INSERT INTO script_steps (script_run_id, position, capability, effect, decision, input_hash, input_json, status)
         VALUES ('sr-1', 1, 'notes.append', 'write', 'allow', 'h', '{}', 'done')`,
      )
      .run();
    legacy.close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      const db = store.database.db;
      expect(
        db.query("SELECT id, occurrence, status, key FROM script_runs ORDER BY id").all(),
      ).toEqual([
        { id: "sr-1", occurrence: 1, status: "completed", key: "" },
        { id: "sr-2", occurrence: 2, status: "running", key: "" },
      ]);
      expect(db.query("SELECT script_run_id, position FROM script_steps").all()).toEqual([
        { script_run_id: "sr-1", position: 1 },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const scripts = openSqliteScriptStore({ database: store.database });
      expect(
        scripts.acquire({ runId: "run-old", botId: "bot-old", source: "return 1", seed: 1 }).id,
      ).toBe("sr-2");
    } finally {
      store.close();
    }
  });
});
