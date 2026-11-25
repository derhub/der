import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { RunRequest } from "@der/domain";
import { applyMigrations, CORE_MIGRATIONS, openSqliteStore, type SqliteStore } from "@der/storage";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "der-session-events-"));
  tempDirs.push(dir);
  return join(dir, "der.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seed(store: SqliteStore) {
  store.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  store.createSession({ id: "sess-1", botId: "bot-1", title: "One" });
  store.createSession({ id: "sess-2", botId: "bot-1", title: "Two" });
}

async function runToEnd(
  store: SqliteStore,
  origin: RunRequest["origin"],
  key: string,
  sessionId = "sess-1",
) {
  const admission = await store.admit({
    botId: "bot-1",
    sessionId,
    origin,
    idempotencyKey: key,
    input: { parts: [{ type: "text", text: key }] },
  });
  await store.finishRun({ runId: admission.run.id, end: { kind: "complete" } });
  return admission.run;
}

describe("migrate runs to accept the event origin", () => {
  it("keeps runs of every origin intact and then admits an event Run", async () => {
    const dbPath = tempDbPath();
    const ts = "2026-11-22T15:00:00.000Z";
    const legacy = new Database(dbPath, { create: true, strict: true });
    legacy.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacy, CORE_MIGRATIONS.slice(0, 9));
    legacy
      .query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, created_at, updated_at)
         VALUES ('bot-old', 'Old', '', 'fixture', '["fixture"]', NULL, ?, ?)`,
      )
      .run(ts, ts);
    legacy
      .query(
        `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
         VALUES ('sess-old', 'bot-old', 'Old', NULL, ?, ?)`,
      )
      .run(ts, ts);
    for (const origin of ["http", "web", "telegram", "routine"]) {
      legacy
        .query(
          `INSERT INTO runs (
             id, bot_id, session_id, origin, engine, status, created_at, updated_at,
             input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, reported_cost_usd, context_mode
           )
           VALUES (?, 'bot-old', 'sess-old', ?, 'fixture', 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `run-${origin}`,
          origin,
          ts,
          ts,
          origin === "http" ? 100 : null,
          origin === "http" ? 25 : null,
          origin === "http" ? 10 : null,
          origin === "http" ? 40 : null,
          origin === "http" ? 0.05 : null,
          origin === "http" ? "resumed" : null,
        );
    }
    legacy.close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      const rows = store.database.db
        .query<{ id: string; origin: string; status: string }, []>(
          "SELECT id, origin, status FROM runs ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        { id: "run-http", origin: "http", status: "completed" },
        { id: "run-routine", origin: "routine", status: "completed" },
        { id: "run-telegram", origin: "telegram", status: "completed" },
        { id: "run-web", origin: "web", status: "completed" },
      ]);
      expect(store.getRun("run-http")).toMatchObject({
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          cacheWriteTokens: 10,
          outputTokens: 40,
          reportedCostUsd: 0.05,
        },
        contextMode: "resumed",
      });

      const admitted = await store.admit({
        botId: "bot-old",
        sessionId: "sess-old",
        origin: "event",
        idempotencyKey: "evt-1",
        input: { parts: [{ type: "text", text: "go" }] },
      });
      expect(admitted.run.origin).toBe("event");
    } finally {
      store.close();
    }
  });
});

describe("count the event chain of a session", () => {
  it("counts event Runs after the latest Run of another origin", async () => {
    const store = openSqliteStore({ filename: tempDbPath() });
    try {
      seed(store);
      await runToEnd(store, "event", "e0");
      await runToEnd(store, "http", "h1");
      await runToEnd(store, "event", "e1");
      await runToEnd(store, "event", "e2");
      expect(store.countEventChain("sess-1")).toBe(2);

      await runToEnd(store, "web", "w1");
      expect(store.countEventChain("sess-1")).toBe(0);

      await runToEnd(store, "event", "e3");
      expect(store.countEventChain("sess-1")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("keeps counting through a routine Run and resets only on a Run a human started", async () => {
    const store = openSqliteStore({ filename: tempDbPath() });
    try {
      seed(store);
      await runToEnd(store, "event", "e1");
      await runToEnd(store, "event", "e2");
      await runToEnd(store, "event", "e3");
      await runToEnd(store, "routine", "r1");
      const afterRoutine = store.countEventChain("sess-1");
      await runToEnd(store, "http", "h1");

      expect([afterRoutine, store.countEventChain("sess-1")]).toEqual([3, 0]);
    } finally {
      store.close();
    }
  });

  it("counts only the session's own Runs", async () => {
    const store = openSqliteStore({ filename: tempDbPath() });
    try {
      seed(store);
      await runToEnd(store, "event", "e1", "sess-2");
      await runToEnd(store, "event", "e2", "sess-2");
      expect(store.countEventChain("sess-1")).toBe(0);
      expect(store.countEventChain("sess-2")).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("queue session events", () => {
  it("lists pending events oldest first and drops a delivered one from the count", () => {
    const store = openSqliteStore({ filename: tempDbPath() });
    try {
      seed(store);
      const first = store.enqueueSessionEvent({
        id: "evt-a",
        botId: "bot-1",
        sessionId: "sess-1",
        kind: "script.finished",
        payload: { n: 1 },
      });
      store.enqueueSessionEvent({
        id: "evt-b",
        botId: "bot-1",
        sessionId: "sess-1",
        kind: "script.finished",
        payload: { n: 2 },
      });
      expect(store.listPendingSessionEvents().map((event) => event.id)).toEqual(["evt-a", "evt-b"]);
      expect(store.countPendingSessionEvents("sess-1")).toBe(2);
      expect(store.listSessions("bot-1").map((s) => [s.id, s.pendingEventCount])).toEqual([
        ["sess-1", 2],
        ["sess-2", 0],
      ]);

      store.markSessionEventDelivered(first.id, "run-x");
      expect(store.listPendingSessionEvents().map((event) => event.id)).toEqual(["evt-b"]);
      expect(store.countPendingSessionEvents("sess-1")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("reports the Run already admitted under an event's id", async () => {
    const store = openSqliteStore({ filename: tempDbPath() });
    try {
      seed(store);
      store.enqueueSessionEvent({
        id: "evt-a",
        botId: "bot-1",
        sessionId: "sess-1",
        kind: "script.finished",
        payload: {},
      });
      const run = await runToEnd(store, "event", "evt-a");
      expect(store.listPendingSessionEvents().map((event) => [event.id, event.runId])).toEqual([
        ["evt-a", run.id],
      ]);
    } finally {
      store.close();
    }
  });
});
