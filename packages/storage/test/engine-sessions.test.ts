import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { EngineSessionInput, FinishRunInput } from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function openStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), "der-engine-sessions-"));
  tempDirs.push(dir);
  const store = openSqliteStore({
    filename: join(dir, "der.sqlite"),
    now: () => new Date("2026-03-04T05:06:07.000Z"),
  });
  const bot = store.createBot({
    id: "bot-es",
    name: "Engine Session Bot",
    persona: "p",
    defaultEngine: "fixture",
    allowedEngines: ["fixture", "codex", "claude-code"],
  });
  store.createSession({ id: "sess-a", botId: bot.id, title: "A" });
  store.createSession({ id: "sess-b", botId: bot.id, title: "B" });
  return store;
}

const rowA: EngineSessionInput = {
  sessionId: "sess-a",
  engine: "codex",
  vendorSessionId: "vendor-1",
  baseHash: "base-1",
  contextHash: "ctx-1",
  lastOrdinal: 4,
};

async function admitRun(store: SqliteStore, row: EngineSessionInput): Promise<string> {
  const { run } = await store.admit({
    botId: "bot-es",
    sessionId: row.sessionId,
    origin: "http",
    idempotencyKey: `${row.sessionId}:${row.engine}`,
    engine: row.engine,
    input: { parts: [{ type: "text", text: "hello" }] },
  });
  return run.id;
}

function completion(runId: string, row: EngineSessionInput): FinishRunInput {
  return {
    runId,
    status: "completed",
    terminalEvent: { chunkKey: `${runId}:terminal`, chunk: { type: "RUN_FINISHED" } },
    engineSession: row,
  };
}

async function finishWithEngineSession(store: SqliteStore, row: EngineSessionInput) {
  await store.finishRun(completion(await admitRun(store, row), row));
}

describe("store the engine session with the Run's finish", () => {
  it("writes the completed Run, its reply and the engine session at the reply's ordinal", async () => {
    const store = openStore();
    try {
      const runId = await admitRun(store, rowA);

      await store.finishRun({
        ...completion(runId, { ...rowA, lastOrdinal: 1 }),
        finalMessageParts: [{ type: "text", text: "hi" }],
      });

      expect([store.getRun(runId)?.status, store.getEngineSession("sess-a", "codex")]).toEqual([
        "completed",
        { ...rowA, lastOrdinal: 2, updatedAt: "2026-03-04T05:06:07.000Z" },
      ]);
    } finally {
      store.close();
    }
  });

  it("writes nothing when a replayed finish finds the Run already terminal", async () => {
    const store = openStore();
    try {
      const runId = await admitRun(store, rowA);
      await store.finishRun(completion(runId, rowA));
      store.takeEngineSession("sess-a", "codex");

      await store.finishRun(completion(runId, rowA));

      expect(store.getEngineSession("sess-a", "codex")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("leaves the Run unfinished and stores no engine session when the session row is rejected", async () => {
    const store = openStore();
    try {
      const runId = await admitRun(store, rowA);

      const failure = await store.finishRun(completion(runId, { ...rowA, lastOrdinal: -1 })).then(
        () => "finished",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      expect([
        failure,
        store.getRun(runId)?.status,
        store.readRunEventsAfter(runId, 0, 10),
        store.getEngineSession("sess-a", "codex"),
      ]).toEqual(["CHECK constraint failed: last_ordinal >= 0", "queued", [], null]);
    } finally {
      store.close();
    }
  });
});

describe("take the engine session when a Run plans its turn", () => {
  it("returns the engine's row and deletes every row of that session only", async () => {
    const store = openStore();
    try {
      await finishWithEngineSession(store, rowA);
      await finishWithEngineSession(store, { ...rowA, engine: "claude-code" });
      await finishWithEngineSession(store, { ...rowA, sessionId: "sess-b" });

      const taken = store.takeEngineSession("sess-a", "codex");

      expect([
        taken,
        store.getEngineSession("sess-a", "codex"),
        store.getEngineSession("sess-a", "claude-code"),
        store.getEngineSession("sess-b", "codex")?.vendorSessionId,
      ]).toEqual([{ ...rowA, updatedAt: "2026-03-04T05:06:07.000Z" }, null, null, "vendor-1"]);
    } finally {
      store.close();
    }
  });

  it("returns null and still clears the session when this engine has no row", async () => {
    const store = openStore();
    try {
      await finishWithEngineSession(store, { ...rowA, engine: "claude-code" });

      expect([
        store.takeEngineSession("sess-a", "codex"),
        store.getEngineSession("sess-a", "claude-code"),
      ]).toEqual([null, null]);
    } finally {
      store.close();
    }
  });
});

describe("delete a session", () => {
  it("removes its engine sessions and keeps other sessions' rows", async () => {
    const store = openStore();
    try {
      const insert = store.database.db.query(
        `INSERT INTO engine_sessions
           (session_id, engine, vendor_session_id, base_hash, context_hash, last_ordinal, updated_at)
         VALUES (?, 'codex', 'vendor-1', 'base-1', 'ctx-1', 4, '2026-03-04T05:06:07.000Z')`,
      );
      insert.run("sess-a");
      insert.run("sess-b");

      store.database.db.query("DELETE FROM sessions WHERE id = ?").run("sess-a");

      expect([
        store.getEngineSession("sess-a", "codex"),
        store.getEngineSession("sess-b", "codex")?.vendorSessionId,
      ]).toEqual([null, "vendor-1"]);
    } finally {
      store.close();
    }
  });
});
