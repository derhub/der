import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExecuteResult } from "@der/domain";
import {
  applyMigrations,
  CORE_MIGRATIONS,
  openSqliteScriptRuns,
  openSqliteStore,
  ScriptRunBusyError,
  type SqliteStore,
} from "@der/storage";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function openFixture() {
  const dir = mkdtempSync(join(tmpdir(), "der-script-runs-"));
  tempDirs.push(dir);
  const store: SqliteStore = openSqliteStore({ filename: join(dir, "der.sqlite") });
  const bot = store.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "Test bot.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({ id: "sess-1", botId: bot.id, title: "Session" });
  const { run } = await store.admit({
    botId: bot.id,
    sessionId: session.id,
    origin: "web",
    idempotencyKey: "req-1",
    input: { parts: [{ type: "text", text: "go" }] },
  });
  const scriptRuns = openSqliteScriptRuns({ database: store.database });
  return { store, scriptRuns, bot, session, run };
}

const done: ExecuteResult = { ok: true, result: 3, logs: ["a"], truncated: false };

describe("acquire a script run", () => {
  it("creates occurrence 1 in running status with the source digest", async () => {
    const { scriptRuns, run, bot } = await openFixture();

    const { scriptRun, created } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    expect(created).toBe(true);
    expect(scriptRun).toEqual({
      id: scriptRun.id,
      runId: run.id,
      botId: bot.id,
      digest: "486d9affb60dbb0063b03d8e23a6ccf6364ce203dc3a9f56f20e750eb41ecade",
      occurrence: 1,
      source: "return 1",
      status: "running",
      result: null,
      deliveredAt: null,
    });
    expect(scriptRun.id).toMatch(/^sr_/);
  });

  it("returns the same undelivered script run for the same source in the same run", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const first = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    const second = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    expect(second.created).toBe(false);
    expect(second.scriptRun.id).toBe(first.scriptRun.id);
  });

  it("creates occurrence 2 once the first result was delivered", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const first = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });
    await scriptRuns.finish(first.scriptRun.id, "completed", done);
    await scriptRuns.markDelivered(first.scriptRun.id);

    const second = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    expect(second.created).toBe(true);
    expect(second.scriptRun.occurrence).toBe(2);
    expect(second.scriptRun.id).not.toBe(first.scriptRun.id);
  });

  it("keeps different sources apart", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const one = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });
    await scriptRuns.finish(one.scriptRun.id, "completed", done);

    const two = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 2" });

    expect(two.created).toBe(true);
    expect(two.scriptRun.digest).not.toBe(one.scriptRun.digest);
    expect(two.scriptRun.occurrence).toBe(1);
  });
});

describe("run one script at a time per run", () => {
  it.each(["running", "waiting_approval"] as const)(
    "refuses a different script while another is %s",
    async (status) => {
      const { scriptRuns, run, bot } = await openFixture();
      const first = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });
      await scriptRuns.setStatus(first.scriptRun.id, status);

      const refused = await scriptRuns
        .acquire({ runId: run.id, botId: bot.id, source: "return 2" })
        .catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(ScriptRunBusyError);
      expect((refused as ScriptRunBusyError).blockedBy.id).toBe(first.scriptRun.id);
    },
  );

  it("creates one row when two different scripts are acquired at once", async () => {
    const { scriptRuns, run, bot } = await openFixture();

    const outcomes = await Promise.allSettled(
      ["return 1", "return 2", "return 3"].map((source) =>
        scriptRuns.acquire({ runId: run.id, botId: bot.id, source }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(scriptRuns.listUnfinished(run.id)).toHaveLength(1);
  });

  it("still returns the running script run for the identical script", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const first = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    const again = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    expect(again.scriptRun.id).toBe(first.scriptRun.id);
    expect(again.created).toBe(false);
  });

  it("allows a different script in another run while one is running", async () => {
    const { store, scriptRuns, run, bot } = await openFixture();
    await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });
    const otherSession = store.createSession({ id: "sess-2", botId: bot.id, title: "Other" });
    const other = await store.admit({
      botId: bot.id,
      sessionId: otherSession.id,
      origin: "web",
      idempotencyKey: "req-2",
      input: { parts: [{ type: "text", text: "again" }] },
    });

    const outcome = await scriptRuns.acquire({
      runId: other.run.id,
      botId: bot.id,
      source: "return 2",
    });

    expect(outcome.created).toBe(true);
  });
});

describe("request a cancel without ending the script run", () => {
  it("keeps the row active while reporting the cancel", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    await scriptRuns.requestCancel(scriptRun.id);

    expect(scriptRuns.isCancelRequested(scriptRun.id)).toBe(true);
    expect(scriptRuns.get(scriptRun.id)?.status).toBe("running");
  });

  it("does not report a cancel for a script run nobody cancelled or one that finished", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });
    expect(scriptRuns.isCancelRequested(scriptRun.id)).toBe(false);

    await scriptRuns.finish(scriptRun.id, "completed", done);
    await scriptRuns.requestCancel(scriptRun.id);

    expect(scriptRuns.isCancelRequested(scriptRun.id)).toBe(false);
  });
});

describe("finish a script run", () => {
  it("stores the result and keeps the first terminal outcome", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    await scriptRuns.finish(scriptRun.id, "completed", done);
    const second = await scriptRuns.finish(scriptRun.id, "failed", {
      ok: false,
      error: { kind: "script", message: "late" },
      logs: [],
    });

    expect(second.status).toBe("completed");
    expect(second.result).toEqual(done);
    expect(scriptRuns.get(scriptRun.id)?.result).toEqual(done);
  });

  it("does not mark a running script run delivered", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    const marked = await scriptRuns.markDelivered(scriptRun.id);

    expect(marked.deliveredAt).toBeNull();
  });

  it("lists only unfinished script runs of the owning run", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const closed = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "b" });
    await scriptRuns.finish(closed.scriptRun.id, "cancelled", {
      ok: false,
      error: { kind: "cancelled", message: "x" },
      logs: [],
    });
    const open = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "a" });
    await scriptRuns.setStatus(open.scriptRun.id, "waiting_approval");

    expect(scriptRuns.listUnfinished(run.id).map((entry) => [entry.id, entry.status])).toEqual([
      [open.scriptRun.id, "waiting_approval"],
    ]);
  });
});

describe("pending approvals of a script run", () => {
  it("returns only approvals whose attempt belongs to the script run", async () => {
    const { store, scriptRuns, run, bot, session } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });
    const request = (attemptId: string, operationId: string) =>
      store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect: {
          runId: run.id,
          operationKind: "capability",
          operationId,
          canonicalArguments: {},
          attemptId,
        },
        prompt: "ok?",
        awakeable: `awk-${attemptId}`,
        deadline: "2099-01-01T00:00:00.000Z",
      });
    const mine = await request(`${scriptRun.id}:1`, "notes.append");
    await request("sr_other:1", "notes.append");

    expect(scriptRuns.listPendingApprovals(scriptRun.id).map((entry) => entry.id)).toEqual([
      mine.approval.id,
    ]);
  });
});

describe("find a write in doubt", () => {
  const identity = (runId: string, attemptId: string) =>
    ({
      runId,
      operationKind: "capability",
      operationId: "ledger.post",
      canonicalArguments: { text: "entry" },
      attemptId,
    }) as const;

  it("finds an unknown effect of the run", async () => {
    const { store, run } = await openFixture();
    const begun = await store.beginEffect(identity(run.id, "att-1"));
    await store.markEffectUnknown(begun.effect.id);

    const found = store.findWriteInDoubt(run.id);

    expect(found?.id).toBe(begun.effect.id);
    expect(found?.status).toBe("unknown");
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "finds a started effect whose script run ended %s",
    async (status) => {
      const { store, scriptRuns, run, bot } = await openFixture();
      const { scriptRun } = await scriptRuns.acquire({
        runId: run.id,
        botId: bot.id,
        source: "return 1",
      });
      const begun = await store.beginEffect(identity(run.id, `${scriptRun.id}:1`));
      await scriptRuns.finish(scriptRun.id, status, done);

      expect(store.findWriteInDoubt(run.id)?.id).toBe(begun.effect.id);
    },
  );

  it.each(["running", "waiting_approval"] as const)(
    "ignores a started effect whose script run is %s",
    async (status) => {
      const { store, scriptRuns, run, bot } = await openFixture();
      const { scriptRun } = await scriptRuns.acquire({
        runId: run.id,
        botId: bot.id,
        source: "return 1",
      });
      await scriptRuns.setStatus(scriptRun.id, status);
      await store.beginEffect(identity(run.id, `${scriptRun.id}:1`));

      expect(store.findWriteInDoubt(run.id)).toBeUndefined();
    },
  );

  it("ignores a started effect that belongs to no script run", async () => {
    const { store, run } = await openFixture();
    await store.beginEffect(identity(run.id, "att-engine"));

    expect(store.findWriteInDoubt(run.id)).toBeUndefined();
  });

  it("ignores a completed effect of a finished script run", async () => {
    const { store, scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });
    const begun = await store.beginEffect(identity(run.id, `${scriptRun.id}:1`));
    await store.completeEffect(begun.effect.id, { ok: true, value: null });
    await scriptRuns.finish(scriptRun.id, "completed", done);

    expect(store.findWriteInDoubt(run.id)).toBeUndefined();
  });

  it("ignores an unknown effect of another run", async () => {
    const { store, run, bot } = await openFixture();
    const otherSession = store.createSession({ id: "sess-2", botId: bot.id, title: "Other" });
    const other = await store.admit({
      botId: bot.id,
      sessionId: otherSession.id,
      origin: "web",
      idempotencyKey: "req-2",
      input: { parts: [{ type: "text", text: "again" }] },
    });
    const begun = await store.beginEffect(identity(other.run.id, "att-1"));
    await store.markEffectUnknown(begun.effect.id);

    expect(store.findWriteInDoubt(run.id)).toBeUndefined();
  });
});

describe("interrupt script runs left active by a previous process", () => {
  it("finishes running and waiting script runs as interrupted and leaves finished ones alone", async () => {
    const { store, scriptRuns, run, bot } = await openFixture();
    const finished = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "a" });
    await scriptRuns.finish(finished.scriptRun.id, "completed", done);
    const waiting = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "b" });
    await scriptRuns.setStatus(waiting.scriptRun.id, "waiting_approval");
    const otherSession = store.createSession({ id: "sess-2", botId: bot.id, title: "Other" });
    const other = await store.admit({
      botId: bot.id,
      sessionId: otherSession.id,
      origin: "web",
      idempotencyKey: "req-2",
      input: { parts: [{ type: "text", text: "again" }] },
    });
    const running = await scriptRuns.acquire({ runId: other.run.id, botId: bot.id, source: "c" });

    const changed = await scriptRuns.interruptAbandoned();

    expect(changed).toBe(2);
    expect(scriptRuns.get(finished.scriptRun.id)?.status).toBe("completed");
    for (const id of [waiting.scriptRun.id, running.scriptRun.id]) {
      expect(scriptRuns.get(id)).toMatchObject({
        status: "interrupted",
        result: {
          ok: false,
          error: { kind: "capability", message: "script was interrupted by a server restart" },
          logs: [],
        },
      });
    }
  });

  it("makes a started effect of an interrupted script run a write in doubt", async () => {
    const { store, scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });
    const begun = await store.beginEffect({
      runId: run.id,
      operationKind: "capability",
      operationId: "ledger.post",
      canonicalArguments: { text: "entry" },
      attemptId: `${scriptRun.id}:1`,
    });
    expect(store.findWriteInDoubt(run.id)).toBeUndefined();

    await scriptRuns.interruptAbandoned();

    expect(store.findWriteInDoubt(run.id)?.id).toBe(begun.effect.id);
  });
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
