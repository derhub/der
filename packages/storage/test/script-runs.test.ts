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

describe("legacy active-run terminal row migration", () => {
  it("cleans legacy terminal and reserved-key chunks on active Runs so finishRun succeeds cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "der-legacy-terminal-migration-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "der.sqlite");
    const ts = "2026-11-22T15:00:00.000Z";
    const legacy = new Database(dbPath, { create: true, strict: true });
    legacy.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacy, CORE_MIGRATIONS.slice(0, 11));
    legacy
      .query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, created_at, updated_at)
         VALUES ('bot-legacy', 'Legacy Bot', 'Concise', 'fixture', '["fixture"]', NULL, ?, ?)`,
      )
      .run(ts, ts);
    for (const sid of [
      "sess-reserved-term",
      "sess-reserved-nonterm",
      "sess-engine-term",
      "sess-done",
    ]) {
      legacy
        .query(
          `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
           VALUES (?, 'bot-legacy', ?, 'fixture', ?, ?)`,
        )
        .run(sid, sid, ts, ts);
    }
    const insertRun = legacy.query(
      `INSERT INTO runs (id, bot_id, session_id, origin, engine, status, created_at, updated_at, finished_at)
       VALUES (?, 'bot-legacy', ?, 'http', 'fixture', ?, ?, ?, ?)`,
    );
    insertRun.run("run-reserved-term", "sess-reserved-term", "running", ts, ts, null);
    insertRun.run(
      "run-reserved-nonterm",
      "sess-reserved-nonterm",
      "waiting_approval",
      ts,
      ts,
      null,
    );
    insertRun.run("run-engine-term", "sess-engine-term", "running", ts, ts, null);
    insertRun.run("run-done", "sess-done", "completed", ts, ts, ts);

    const insertEvent = legacy.query(
      `INSERT INTO run_events (run_id, sequence, chunk_key, chunk_json, is_terminal, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(
      "run-reserved-term",
      1,
      "run-reserved-term:started",
      '{"type":"RUN_STARTED"}',
      0,
      ts,
    );
    insertEvent.run(
      "run-reserved-term",
      2,
      "run-reserved-term:terminal",
      '{"type":"RUN_FINISHED"}',
      1,
      ts,
    );
    insertEvent.run(
      "run-reserved-nonterm",
      1,
      "run-reserved-nonterm:started",
      '{"type":"RUN_STARTED"}',
      0,
      ts,
    );
    insertEvent.run(
      "run-reserved-nonterm",
      2,
      "run-reserved-nonterm:terminal",
      '{"type":"TEXT_MESSAGE_CONTENT","delta":"x"}',
      0,
      ts,
    );
    insertEvent.run(
      "run-engine-term",
      1,
      "run-engine-term:started",
      '{"type":"RUN_STARTED"}',
      0,
      ts,
    );
    insertEvent.run(
      "run-engine-term",
      2,
      "run-engine-term:2:RUN_FINISHED",
      '{"type":"RUN_FINISHED"}',
      1,
      ts,
    );
    insertEvent.run("run-done", 1, "run-done:started", '{"type":"RUN_STARTED"}', 0, ts);
    insertEvent.run("run-done", 2, "run-done:terminal", '{"type":"RUN_FINISHED"}', 1, ts);
    legacy.close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      const results = [];
      for (const runId of ["run-reserved-term", "run-reserved-nonterm", "run-engine-term"]) {
        const finished = await store.finishRun({ runId, end: { kind: "server_restarted" } });
        const chunks = store.readRunEventsAfter(runId, 0, 100).map((event) => ({
          type: (event.chunk as { type?: string }).type,
          terminal: event.isTerminal === true,
        }));
        results.push({ runId, won: finished.won, status: finished.run.status, chunks });
      }
      const doneChunks = store.readRunEventsAfter("run-done", 0, 100).map((event) => ({
        type: (event.chunk as { type?: string }).type,
        terminal: event.isTerminal === true,
      }));
      expect({ results, doneStatus: store.getRun("run-done")?.status, doneChunks }).toEqual({
        results: [
          {
            runId: "run-reserved-term",
            won: true,
            status: "interrupted",
            chunks: [
              { type: "RUN_STARTED", terminal: false },
              { type: "RUN_ERROR", terminal: true },
            ],
          },
          {
            runId: "run-reserved-nonterm",
            won: true,
            status: "interrupted",
            chunks: [
              { type: "RUN_STARTED", terminal: false },
              { type: "RUN_ERROR", terminal: true },
            ],
          },
          {
            runId: "run-engine-term",
            won: true,
            status: "interrupted",
            chunks: [
              { type: "RUN_STARTED", terminal: false },
              { type: "RUN_ERROR", terminal: true },
            ],
          },
        ],
        doneStatus: "completed",
        doneChunks: [
          { type: "RUN_STARTED", terminal: false },
          { type: "RUN_FINISHED", terminal: true },
        ],
      });
    } finally {
      store.close();
    }
  });
});
