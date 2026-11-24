import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { DomainError, type RunEvent } from "@der/domain";
import {
  applyMigrations,
  canonicalizeJson,
  CAPABILITY_OPERATION_KIND_MIGRATION,
  CORE_MIGRATION,
  fingerprintJson,
  openSqliteStore,
  OUTBOX_DESTINATIONS_MIGRATION,
  SCRIPT_RUNS_MIGRATION,
  type SqliteStore,
  type StorageMigration,
} from "@der/storage";

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "der-storage-"));
  tempDirs.push(dir);
  return join(dir, "der.sqlite");
}

function makeFixedClock(iso: string): { now: () => Date; advanceMs: (ms: number) => void } {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

function seedFixture(store: SqliteStore) {
  const bot = store.createBot({
    id: "bot-fixture",
    name: "Fixture Bot",
    persona: "Deterministic test coworker.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture", "codex"],
  });
  const session = store.createSession({
    id: "sess-fixture",
    botId: bot.id,
    title: "Fixture Session",
  });
  const binding = store.upsertChannelBinding({
    id: "bind-fixture",
    integration: "fixture",
    externalChatId: "chat-fixture-1",
    externalActorId: "actor-fixture-1",
    botId: bot.id,
    sessionId: session.id,
    enabled: true,
  });
  return { bot, session, binding };
}

async function expectDomainRejection(
  action: () => Promise<unknown>,
  expected: { readonly status: number; readonly code: string },
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect(caught).toMatchObject(expected);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("configure SQLite WAL, foreign keys, busy timeout, and migration seam", () => {
  it("enables WAL mode, foreign keys, busy timeout, and applies extra migrations idempotently", () => {
    const dbPath = createTempDbPath();
    const extraMigration: StorageMigration = {
      version: "002-memory-seam-test",
      sql: "CREATE TABLE seam_probe (id TEXT PRIMARY KEY);",
    };

    const store = openSqliteStore({
      filename: dbPath,
      busyTimeoutMs: 4200,
      extraMigrations: [extraMigration],
    });

    try {
      expect(store.database.journalMode()).toBe("wal");
      expect(store.database.foreignKeysEnabled()).toBe(true);
      expect(store.database.busyTimeout()).toBe(4200);

      const applied = store.database.db
        .query<{ version: string }, []>(
          "SELECT version FROM schema_migrations ORDER BY version ASC",
        )
        .all();
      expect(applied.map((row) => row.version)).toEqual([
        "001-core",
        "002-memory-seam-test",
        "003-outbox-destinations",
        "004-capability-operation-kind",
        "005-script-runs",
        "006-script-routines",
        "007-run-usage",
        "008-engine-sessions",
      ]);
    } finally {
      store.close();
    }

    const reopened = openSqliteStore({
      filename: dbPath,
      extraMigrations: [extraMigration],
    });
    try {
      const applied = reopened.database.db
        .query<{ version: string }, []>(
          "SELECT version FROM schema_migrations ORDER BY version ASC",
        )
        .all();
      expect(applied.map((row) => row.version)).toEqual([
        "001-core",
        "002-memory-seam-test",
        "003-outbox-destinations",
        "004-capability-operation-kind",
        "005-script-runs",
        "006-script-routines",
        "007-run-usage",
        "008-engine-sessions",
      ]);
    } finally {
      reopened.close();
    }
  });
});

describe("capability operation kind", () => {
  it("stores and reads back an approval and an effect of kind capability", async () => {
    const store = openSqliteStore({
      filename: createTempDbPath(),
      now: makeFixedClock("2026-11-22T15:00:00Z").now,
    });
    try {
      const { bot, session } = seedFixture(store);
      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "req-capability",
        input: { parts: [{ type: "text", text: "Run script" }] },
      });
      const effect = {
        runId: run.id,
        operationKind: "capability" as const,
        operationId: "notes.append",
        canonicalArguments: { text: "hello" },
        attemptId: "sr_1:1",
      };

      const requested = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect,
        prompt: "Append note?",
        awakeable: "awk_capability_1",
        deadline: "2026-11-22T15:05:00Z",
      });
      expect(requested.approval.effect).toEqual(effect);

      await store.decide({
        approvalId: requested.approval.id,
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        status: "approved",
        actor: "operator",
        decidedAt: "2026-11-22T15:01:00Z",
      });
      const started = await store.beginEffect(effect, { approvalId: requested.approval.id });
      await store.completeEffect(started.effect.id, { id: "n1" });

      expect(store.getEffect(effect)).toMatchObject({
        identity: effect,
        status: "completed",
        outcome: { id: "n1" },
      });
    } finally {
      store.close();
    }
  });

  it("keeps approvals and effects written before 004 and still rejects an unknown kind", () => {
    const dbPath = createTempDbPath();
    const ts = "2026-11-22T15:00:00.000Z";
    const legacyDb = new Database(dbPath, { create: true, strict: true });
    legacyDb.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacyDb, [CORE_MIGRATION, OUTBOX_DESTINATIONS_MIGRATION]);
    legacyDb
      .query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, created_at, updated_at)
         VALUES ('bot-old', 'Old Bot', 'Concise', 'fixture', '["fixture"]', NULL, ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
         VALUES ('sess-old', 'bot-old', 'Old Session', 'fixture', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO runs (id, bot_id, session_id, origin, engine, status, created_at, updated_at)
         VALUES ('run-old', 'bot-old', 'sess-old', 'web', 'fixture', 'running', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO approvals (id, bot_id, session_id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, prompt, awakeable, deadline, status, created_at, updated_at)
         VALUES ('appr-old', 'bot-old', 'sess-old', 'run-old', 'mcp', 'github.create_issue', '{"title":"x"}', 'attempt-old', 'Create?', 'awk_old', ?, 'pending', ?, ?)`,
      )
      .run(ts, ts, ts);
    legacyDb
      .query(
        `INSERT INTO effects (id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, status, started_at, updated_at)
         VALUES ('eff-old', 'run-old', 'mcp', 'github.create_issue', '{"title":"x"}', 'attempt-old', 'started', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb.close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      const db = store.database.db;
      expect(db.query("SELECT id, operation_kind FROM approvals").all()).toEqual([
        { id: "appr-old", operation_kind: "mcp" },
      ]);
      expect(db.query("SELECT id, operation_kind, status FROM effects").all()).toEqual([
        { id: "eff-old", operation_kind: "mcp", status: "started" },
      ]);
      expect(() =>
        db
          .query(
            `INSERT INTO effects (id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, status, started_at, updated_at)
             VALUES ('eff-bad', 'run-old', 'bogus', 'x', '{}', 'a', 'started', ?, ?)`,
          )
          .run(ts, ts),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });
});

describe("script routines migration", () => {
  const ts = "2026-11-22T15:00:00.000Z";

  function createDatabaseAt005(dbPath: string): Database {
    const legacyDb = new Database(dbPath, { create: true, strict: true });
    legacyDb.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacyDb, [
      CORE_MIGRATION,
      OUTBOX_DESTINATIONS_MIGRATION,
      CAPABILITY_OPERATION_KIND_MIGRATION,
      SCRIPT_RUNS_MIGRATION,
    ]);
    legacyDb
      .query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, created_at, updated_at)
         VALUES ('bot-old', 'Old Bot', 'Concise', 'fixture', '["fixture"]', NULL, ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
         VALUES ('sess-old', 'bot-old', 'Old Session', 'fixture', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO routines (id, bot_id, session_id, name, cron, enabled, revision, engine, prompt, created_at, updated_at)
         VALUES ('rt-old', 'bot-old', 'sess-old', 'Morning', '0 8 * * *', 1, 3, 'fixture', 'Summarize', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO runs (id, bot_id, session_id, origin, engine, status, routine_id, routine_slot, created_at, updated_at)
         VALUES ('run-old', 'bot-old', 'sess-old', 'routine', 'fixture', 'running', 'rt-old', '2026-11-22T08:00:00.000Z', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO approvals (id, bot_id, session_id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, prompt, awakeable, deadline, status, created_at, updated_at)
         VALUES ('appr-old', 'bot-old', 'sess-old', 'run-old', 'capability', 'notes.append', '{}', 'attempt-old', 'Append?', 'awk_old', ?, 'pending', ?, ?)`,
      )
      .run(ts, ts, ts);
    legacyDb
      .query(
        `INSERT INTO script_runs (id, run_id, bot_id, digest, occurrence, source, status, created_at, updated_at)
         VALUES ('sr-old', 'run-old', 'bot-old', 'abc', 1, 'return 1', 'running', ?, ?)`,
      )
      .run(ts, ts);
    return legacyDb;
  }

  it("keeps prompt routines, runs and the rows that reference them", () => {
    const dbPath = createTempDbPath();
    createDatabaseAt005(dbPath).close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      const db = store.database.db;
      expect(db.query("SELECT id, engine, prompt, script, revision FROM routines").all()).toEqual([
        { id: "rt-old", engine: "fixture", prompt: "Summarize", script: null, revision: 3 },
      ]);
      expect(
        db.query("SELECT id, origin, engine, status, routine_id, routine_slot FROM runs").all(),
      ).toEqual([
        {
          id: "run-old",
          origin: "routine",
          engine: "fixture",
          status: "running",
          routine_id: "rt-old",
          routine_slot: "2026-11-22T08:00:00.000Z",
        },
      ]);
      expect(db.query("SELECT id, run_id FROM approvals").all()).toEqual([
        { id: "appr-old", run_id: "run-old" },
      ]);
      expect(db.query("SELECT id, run_id FROM script_runs").all()).toEqual([
        { id: "sr-old", run_id: "run-old" },
      ]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(store.getRoutine("rt-old")).toEqual({
        id: "rt-old",
        botId: "bot-old",
        sessionId: "sess-old",
        name: "Morning",
        cron: "0 8 * * *",
        enabled: true,
        revision: 3,
        engine: "fixture",
        prompt: "Summarize",
        script: null,
        createdAt: ts,
        updatedAt: ts,
      });
    } finally {
      store.close();
    }
  });

  it("keeps the one active run per session after the rebuild", () => {
    const dbPath = createTempDbPath();
    createDatabaseAt005(dbPath).close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      expect(() =>
        store.database.db
          .query(
            `INSERT INTO runs (id, bot_id, session_id, origin, engine, status, created_at, updated_at)
             VALUES ('run-second', 'bot-old', 'sess-old', 'web', 'fixture', 'queued', ?, ?)`,
          )
          .run(ts, ts),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      store.close();
    }
  });

  it.each([
    { name: "both prompt and script", engine: "fixture", prompt: "'p'", script: "'return 1'" },
    { name: "neither prompt nor script", engine: "fixture", prompt: "NULL", script: "NULL" },
    { name: "a script with a chat engine", engine: "codex", prompt: "NULL", script: "'return 1'" },
    { name: "a prompt with engine script", engine: "script", prompt: "'p'", script: "NULL" },
  ])("the table rejects a routine with $name", ({ engine, prompt, script }) => {
    const store = openSqliteStore({ filename: createTempDbPath() });
    try {
      const { session } = seedFixture(store);
      expect(() =>
        store.database.db
          .query(
            `INSERT INTO routines (id, bot_id, session_id, name, cron, enabled, revision, engine, prompt, script, created_at, updated_at)
             VALUES ('rt-bad', 'bot-fixture', '${session.id}', 'Bad', '* * * * *', 1, 1, '${engine}', ${prompt}, ${script}, ?, ?)`,
          )
          .run(ts, ts),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });

  it("stores a script routine and a script run for it", async () => {
    const store = openSqliteStore({ filename: createTempDbPath() });
    try {
      const { bot, session } = seedFixture(store);
      const routine = store.createRoutine({
        id: "rt-script",
        botId: bot.id,
        sessionId: session.id,
        name: "Ping",
        cron: "* * * * *",
        enabled: true,
        engine: "script",
        script: "return 1",
      });
      expect(routine).toMatchObject({ engine: "script", prompt: null, script: "return 1" });

      const admission = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "routine",
        idempotencyKey: "routine:rt-script:slot",
        engine: "script",
        input: { parts: [{ type: "text", text: "Ping" }] },
        routineId: "rt-script",
        routineSlot: "2026-11-22T15:00:00.000Z",
      });
      expect(admission.run.engine).toBe("script");
    } finally {
      store.close();
    }
  });

  it("refuses a script run for a prompt routine and for a non-routine origin", async () => {
    const store = openSqliteStore({ filename: createTempDbPath() });
    try {
      const { bot, session } = seedFixture(store);
      store.createRoutine({
        id: "rt-prompt",
        botId: bot.id,
        sessionId: session.id,
        name: "Prompt",
        cron: "* * * * *",
        enabled: true,
        engine: "fixture",
        prompt: "hello",
      });
      const request = {
        botId: bot.id,
        sessionId: session.id,
        idempotencyKey: "k1",
        engine: "script" as const,
        input: { parts: [{ type: "text" as const, text: "x" }] },
      };
      await expectDomainRejection(
        () =>
          store.admit({
            ...request,
            origin: "routine",
            routineId: "rt-prompt",
            routineSlot: "2026-11-22T15:00:00.000Z",
          }),
        { status: 409, code: "routine.scope_mismatch" },
      );
      await expectDomainRejection(() => store.admit({ ...request, origin: "http" }), {
        status: 400,
        code: "run.invalid_request",
      });
    } finally {
      store.close();
    }
  });
});

describe("admit runs with scoped idempotency and single active run", () => {
  it("preserves array order and scalar semantics while normalizing object key order in fingerprints", async () => {
    const first = await fingerprintJson({ b: 1, a: [1, "1", true, "true", null] });
    const reorderedKeys = await fingerprintJson({ a: [1, "1", true, "true", null], b: 1 });
    const reorderedArray = await fingerprintJson({ a: ["1", 1, true, "true", null], b: 1 });
    const changedScalar = await fingerprintJson({ a: [1, 1, true, "true", null], b: 1 });

    expect(first).toBe(reorderedKeys);
    expect(first).not.toBe(reorderedArray);
    expect(first).not.toBe(changedScalar);
    expect(canonicalizeJson({ z: 1, a: [true, "true"] })).toBe('{"a":[true,"true"],"z":1}');
  });

  it("returns the original Run on exact idempotency replay even while the Run is active", async () => {
    const clock = makeFixedClock("2026-11-22T15:00:00Z");
    const store = openSqliteStore({ filename: createTempDbPath(), now: clock.now });
    try {
      const { bot, session } = seedFixture(store);

      const first = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "req-1",
        input: {
          parts: [
            { type: "data", mimeType: "application/json", data: { b: 2, a: [1, "1"] } },
            { type: "text", text: "Run fixture" },
          ],
        },
      });

      expect(first.isDuplicate).toBe(false);
      expect(first.run.status).toBe("queued");
      expect(first.initialMessage.ordinal).toBe(1);

      const replay = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "req-1",
        input: {
          parts: [
            { type: "data", mimeType: "application/json", data: { a: [1, "1"], b: 2 } },
            { type: "text", text: "Run fixture" },
          ],
        },
      });

      expect(replay.isDuplicate).toBe(true);
      expect(replay.run.id).toBe(first.run.id);
      expect(replay.initialMessage.id).toBe(first.initialMessage.id);
      expect(store.listMessages(session.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects idempotency key reuse with changed payload and blocks a second active Run in the same session", async () => {
    const store = openSqliteStore({ filename: createTempDbPath() });
    try {
      const { bot, session } = seedFixture(store);
      const otherSession = store.createSession({
        id: "sess-other",
        botId: bot.id,
        title: "Second Session",
      });

      await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "req-1",
        input: { parts: [{ type: "text", text: "First payload" }] },
      });

      await expectDomainRejection(
        () =>
          store.admit({
            botId: bot.id,
            sessionId: session.id,
            origin: "web",
            idempotencyKey: "req-1",
            input: { parts: [{ type: "text", text: "Mutated payload" }] },
          }),
        { status: 409, code: "idempotency.conflict" },
      );

      await expectDomainRejection(
        () =>
          store.admit({
            botId: bot.id,
            sessionId: session.id,
            origin: "web",
            idempotencyKey: "req-2",
            input: { parts: [{ type: "text", text: "Competing active run" }] },
          }),
        { status: 409, code: "run.active_conflict" },
      );

      const otherAdmission = await store.admit({
        botId: bot.id,
        sessionId: otherSession.id,
        origin: "web",
        idempotencyKey: "req-1",
        input: { parts: [{ type: "text", text: "Independent session" }] },
      });
      expect(otherAdmission.isDuplicate).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("append bounded run events and replay exclusively after cursor", () => {
  it("batches events, deduplicates replayed chunk keys, and replays strictly after cursor", async () => {
    const store = openSqliteStore({
      filename: createTempDbPath(),
      maxEventBatchSize: 2,
      replayPageSize: 2,
    });
    try {
      const { bot, session } = seedFixture(store);
      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "req-stream",
        input: { parts: [{ type: "text", text: "Stream chunks" }] },
      });

      const batch = await store.appendRunEvents(run.id, [
        { chunkKey: `${run.id}:1`, chunk: { type: "RUN_STARTED", runId: run.id } },
        { chunkKey: `${run.id}:2`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "hel" } },
        { chunkKey: `${run.id}:3`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "lo" } },
        { chunkKey: `${run.id}:2`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "hel" } },
        {
          chunkKey: `${run.id}:4`,
          chunk: { type: "RUN_FINISHED", runId: run.id },
          isTerminal: true,
        },
      ]);

      expect(batch.map((event) => event.sequence)).toEqual([1, 2, 3, 2, 4]);
      expect(store.getRunStreamState(run.id)).toEqual({
        highWaterMark: 4,
        terminalSequence: 4,
        status: "queued",
      });

      const replayed: RunEvent[] = [];
      for await (const event of store.replay(run.id, 2)) {
        replayed.push(event);
      }
      expect(replayed.map((event) => event.sequence)).toEqual([3, 4]);

      await expectDomainRejection(
        () =>
          store.appendRunEvents(run.id, [
            { chunkKey: `${run.id}:5`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "late" } },
          ]),
        { status: 409, code: "run.already_terminal" },
      );
    } finally {
      store.close();
    }
  });
});

describe("persist approvals, transactional outbox rows, and exact-operation effect certainty", () => {
  it("commits approvals and der.approval.requested outbox atomically, enforces scope/expiry/replay, and guards effect authorization", async () => {
    const clock = makeFixedClock("2026-11-22T15:00:00Z");
    const store = openSqliteStore({ filename: createTempDbPath(), now: clock.now });
    try {
      const { bot, session, binding } = seedFixture(store);
      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "req-appr",
        input: { parts: [{ type: "text", text: "Execute host fixture" }] },
      });

      const effect = {
        runId: run.id,
        operationKind: "fixture" as const,
        operationId: "fixture.write",
        canonicalArguments: { b: 2, a: "value" },
        attemptId: "attempt-1",
      };

      const requested = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect,
        prompt: "Apply fixture write?",
        awakeable: "awk_test_1",
        deadline: "2026-11-22T15:05:00Z",
      });

      expect(requested.isDuplicate).toBe(false);
      expect(requested.approval.decision.status).toBe("pending");
      expect(requested.outboxEvents).toHaveLength(1);
      expect(requested.outboxEvents[0]?.bindingId).toBe(binding.id);
      expect(requested.outboxEvents[0]?.envelope.type).toBe("der.approval.requested");
      expect(store.getRun(run.id)?.status).toBe("waiting_approval");

      const duplicateRequest = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect: { ...effect, canonicalArguments: { a: "value", b: 2 } },
        prompt: "Apply fixture write?",
        awakeable: "awk_test_1",
        deadline: "2026-11-22T15:05:00Z",
      });
      expect(duplicateRequest.isDuplicate).toBe(true);
      expect(duplicateRequest.approval.id).toBe(requested.approval.id);

      await expectDomainRejection(
        () =>
          store.decide({
            approvalId: requested.approval.id,
            botId: bot.id,
            sessionId: "sess-wrong",
            runId: run.id,
            status: "approved",
            actor: "operator",
            decidedAt: "2026-11-22T15:01:00Z",
          }),
        { status: 409, code: "approval.scope_mismatch" },
      );

      clock.advanceMs(60_000);
      const approved = await store.decide({
        approvalId: requested.approval.id,
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        status: "approved",
        actor: "operator",
        decidedAt: "2020-01-01T00:00:00Z",
      });
      expect(approved.decision).toEqual({
        status: "approved",
        actor: "operator",
        decidedAt: "2026-11-22T15:01:00.000Z",
      });

      const replayed = await store.decide({
        approvalId: requested.approval.id,
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        status: "approved",
        actor: "operator",
        decidedAt: "2026-11-22T15:02:00Z",
      });
      expect(replayed.decision).toEqual(approved.decision);

      await expectDomainRejection(
        () =>
          store.decide({
            approvalId: requested.approval.id,
            botId: bot.id,
            sessionId: session.id,
            runId: run.id,
            status: "denied",
            actor: "operator",
            decidedAt: "2026-11-22T15:02:00Z",
          }),
        { status: 409, code: "approval.decision_conflict" },
      );

      await expectDomainRejection(
        () =>
          store.beginEffect(
            { ...effect, canonicalArguments: { a: "tampered", b: 2 } },
            { approvalId: requested.approval.id },
          ),
        { status: 409, code: "effect.authorization_mismatch" },
      );

      const started = await store.beginEffect(
        { ...effect, canonicalArguments: { a: "value", b: 2 } },
        { approvalId: requested.approval.id },
      );
      expect(started.kind).toBe("started");

      const ambiguous = await store.beginEffect(effect, { approvalId: requested.approval.id });
      expect(ambiguous.kind).toBe("ambiguous");

      const completedRecord = await store.completeEffect(started.effect.id, { applied: true });
      expect(completedRecord.status).toBe("completed");
      expect(completedRecord.outcome).toEqual({ applied: true });

      const reused = await store.beginEffect(effect, { approvalId: requested.approval.id });
      expect(reused.kind).toBe("completed");
      expect(reused.effect.outcome).toEqual({ applied: true });
    } finally {
      store.close();
    }
  });

  it("expires a pending approval at deadline and emits der.chat.replied and der.routine.finished outbox rows atomically", async () => {
    const clock = makeFixedClock("2026-11-22T16:00:00Z");
    const store = openSqliteStore({ filename: createTempDbPath(), now: clock.now });
    try {
      const { bot, session, binding } = seedFixture(store);
      const otherSession = store.createSession({
        id: "sess-bot-binding",
        botId: bot.id,
        title: "Second Session",
      });
      const botLevelBinding = store.upsertChannelBinding({
        id: "bind-other-session",
        integration: "fixture",
        externalChatId: "chat-fixture-2",
        externalActorId: "actor-fixture-2",
        botId: bot.id,
        sessionId: otherSession.id,
        enabled: true,
      });
      const routine = store.createRoutine({
        id: "rt-1",
        botId: bot.id,
        sessionId: session.id,
        name: "Hourly fixture check",
        cron: "0 * * * *",
        enabled: true,
        engine: "fixture",
        prompt: "Check system state",
      });

      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "routine",
        idempotencyKey: "rt-1:2026-11-22T16:00:00Z",
        routineId: routine.id,
        routineSlot: "2026-11-22T16:00:00Z",
        input: { parts: [{ type: "text", text: "Check system state" }] },
      });

      const requested = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect: {
          runId: run.id,
          operationKind: "fixture",
          operationId: "fixture.expire",
          canonicalArguments: { step: 1 },
          attemptId: "attempt-1",
        },
        prompt: "Approve before timeout?",
        awakeable: "awk_expire_1",
        deadline: "2026-11-22T16:01:00Z",
      });

      clock.advanceMs(2 * 60_000);
      let expiredError: unknown;
      try {
        await store.decide({
          approvalId: requested.approval.id,
          botId: bot.id,
          sessionId: session.id,
          runId: run.id,
          status: "approved",
          actor: "operator",
          decidedAt: "2026-11-22T16:00:30Z",
        });
      } catch (error) {
        expiredError = error;
      }
      expect(expiredError).toBeInstanceOf(DomainError);
      expect(expiredError).toMatchObject({ status: 409, code: "approval.expired" });
      expect(store.getApproval(requested.approval.id)?.decision.status).toBe("expired");

      const finished = await store.finishRun({
        runId: run.id,
        status: "completed",
        terminalEvent: {
          chunkKey: `${run.id}:terminal`,
          chunk: { type: "RUN_FINISHED", runId: run.id },
        },
        finalMessageParts: [{ type: "text", text: "Completed after expiry." }],
        detail: "Routine finished cleanly.",
      });

      expect(finished.run.status).toBe("completed");
      expect(finished.finalMessage?.ordinal).toBe(2);
      const chatOutbox = finished.outboxEvents.filter(
        (event) => event.envelope.type === "der.chat.replied",
      );
      const routineOutbox = finished.outboxEvents.filter(
        (event) => event.envelope.type === "der.routine.finished",
      );
      expect(chatOutbox.map((event) => event.bindingId)).toEqual([binding.id]);
      expect(routineOutbox.map((event) => event.bindingId)).toEqual([
        binding.id,
        botLevelBinding.id,
      ]);

      const firstOutbox = chatOutbox[0];
      expect(firstOutbox).toBeDefined();
      if (firstOutbox) {
        const retrying = await store.recordOutboxDelivery(firstOutbox.id, {
          status: "retryable",
          retryAfterMs: 10_000,
          detail: "Temporary timeout",
        });
        expect(retrying.state).toBe("retrying");
        expect(retrying.attempts).toBe(1);
        expect(store.listDueOutboxEvents("2026-11-22T16:02:05Z").map((e) => e.id)).not.toContain(
          firstOutbox.id,
        );
        expect(store.listDueOutboxEvents("2026-11-22T16:02:15Z").map((e) => e.id)).toContain(
          firstOutbox.id,
        );

        const delivered = await store.recordOutboxDelivery(firstOutbox.id, {
          status: "delivered",
          externalMessageId: "ext-msg-1",
          deliveredAt: "2026-11-22T16:02:15Z",
        });
        expect(delivered.state).toBe("delivered");
        expect(delivered.attempts).toBe(2);
      }
    } finally {
      store.close();
    }
  });

  it("migrates 001-core channel_bindings preserving outbox_events foreign keys and persists custom OutboxSink kinds", async () => {
    const dbPath = createTempDbPath();
    const legacyDb = new Database(dbPath, { create: true, strict: true });
    legacyDb.exec("PRAGMA foreign_keys = ON;");
    applyMigrations(legacyDb, [CORE_MIGRATION], () => new Date("2026-11-22T15:00:00Z"));

    const ts = "2026-11-22T15:00:00.000Z";
    legacyDb
      .query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, created_at, updated_at)
         VALUES ('bot-mig', 'Mig Bot', 'Concise', 'fixture', '["fixture"]', NULL, ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
         VALUES ('sess-mig', 'bot-mig', 'Mig Session', 'fixture', ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO channel_bindings (id, integration, external_chat_id, external_actor_id, bot_id, session_id, enabled, created_at, updated_at)
         VALUES ('bind-legacy', 'fixture', 'chat-1', 'actor-1', 'bot-mig', 'sess-mig', 1, ?, ?)`,
      )
      .run(ts, ts);
    legacyDb
      .query(
        `INSERT INTO outbox_events (id, binding_id, event_id, envelope_json, state, attempts, next_retry_at, delivered_at, last_error, created_at, updated_at)
         VALUES ('outbox-legacy-1', 'bind-legacy', 'evt-legacy-1', ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        JSON.stringify({
          specversion: "1.0",
          id: "evt-legacy-1",
          source: "/bots/bot-mig",
          type: "der.chat.replied",
          time: ts,
          subject: "sessions/sess-mig/runs/run-legacy",
          datacontenttype: "application/json",
          data: {
            botId: "bot-mig",
            sessionId: "sess-mig",
            runId: "run-legacy",
            message: {
              id: "msg-legacy",
              botId: "bot-mig",
              sessionId: "sess-mig",
              ordinal: 1,
              role: "assistant",
              parts: [{ type: "text", text: "Legacy reply" }],
              runId: "run-legacy",
              createdAt: ts,
            },
          },
        }),
        ts,
        ts,
      );
    legacyDb.close();

    const store = openSqliteStore({ filename: dbPath });
    try {
      expect(store.database.foreignKeysEnabled()).toBe(true);
      expect(store.listChannelBindings({ botId: "bot-mig" }).map((b) => b.id)).toEqual([
        "bind-legacy",
      ]);
      expect(store.listOutboxEvents({ bindingId: "bind-legacy" }).map((e) => e.id)).toEqual([
        "outbox-legacy-1",
      ]);

      const webhookBinding = store.upsertChannelBinding({
        id: "bind-webhook",
        integration: "webhook",
        externalChatId: "https://hooks.example.invalid/der",
        externalActorId: "webhook-operator",
        botId: "bot-mig",
        sessionId: "sess-mig",
        enabled: true,
      });
      expect(webhookBinding.integration).toBe("webhook");

      const destinations = store.listOutboxDestinations({ kind: "webhook" });
      expect(destinations).toHaveLength(1);
      expect(destinations[0]).toMatchObject({
        id: "bind-webhook",
        kind: "webhook",
        target: "https://hooks.example.invalid/der",
      });

      const { run } = await store.admit({
        botId: "bot-mig",
        sessionId: "sess-mig",
        origin: "web",
        idempotencyKey: "webhook-run-1",
        input: { parts: [{ type: "text", text: "Notify webhook" }] },
      });
      const finished = await store.finishRun({
        runId: run.id,
        status: "completed",
        terminalEvent: {
          chunkKey: `${run.id}:terminal`,
          chunk: { type: "RUN_FINISHED", runId: run.id },
        },
        finalMessageParts: [{ type: "text", text: "Webhook payload ready." }],
      });
      expect(finished.outboxEvents.map((event) => event.bindingId)).toContain("bind-webhook");
    } finally {
      store.close();
    }
  });

  it("deserializes historical approvals and effects with removed legacy operation_kind as legacy", async () => {
    const store = openSqliteStore({ filename: createTempDbPath() });
    try {
      const { bot, session } = seedFixture(store);
      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: "legacy-op-kind-1",
        input: { parts: [{ type: "text", text: "Historical run" }] },
      });
      const ts = "2026-11-22T15:00:00.000Z";
      store.database.db
        .query(
          `INSERT INTO approvals
            (id, bot_id, session_id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, prompt, awakeable, deadline, status, actor, decided_at, created_at, updated_at)
           VALUES ('appr-legacy-1', ?, ?, ?, 'home-assistant', 'light.turn_on', '{"entity":"lamp"}', 'att-legacy', 'Turn on lamp?', 'awk-legacy', ?, 'approved', 'operator', ?, ?, ?)`,
        )
        .run(bot.id, session.id, run.id, ts, ts, ts, ts);
      store.database.db
        .query(
          `INSERT INTO effects
            (id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, status, outcome_json, started_at, updated_at)
           VALUES ('eff-legacy-1', ?, 'home-assistant', 'light.turn_on', '{"entity":"lamp"}', 'att-legacy', 'completed', '{"ok":true}', ?, ?)`,
        )
        .run(run.id, ts, ts);

      const byId = store.getApproval("appr-legacy-1");
      expect(byId?.effect.operationKind).toBe("legacy");
      expect(byId?.effect.operationId).toBe("light.turn_on");

      const latest = store.getLatestApprovalForRun(run.id);
      expect(latest?.id).toBe("appr-legacy-1");
      expect(latest?.effect.operationKind).toBe("legacy");

      const legacyEffect = store.getEffect({
        runId: run.id,
        operationKind: "home-assistant" as unknown as Parameters<
          SqliteStore["getEffect"]
        >[0]["operationKind"],
        operationId: "light.turn_on",
        canonicalArguments: { entity: "lamp" },
        attemptId: "att-legacy",
      });
      expect(legacyEffect?.id).toBe("eff-legacy-1");
      expect(legacyEffect?.identity.operationKind).toBe("legacy");
      expect(legacyEffect?.identity.operationId).toBe("light.turn_on");
    } finally {
      store.close();
    }
  });
});
