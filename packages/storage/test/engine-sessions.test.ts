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

function insertRow(store: SqliteStore, sessionId: string, engine: string): void {
  store.database.db
    .query(
      `INSERT INTO engine_sessions
         (session_id, engine, vendor_session_id, base_hash, context_hash, last_ordinal, updated_at)
       VALUES (?, ?, 'vendor-0', 'base-0', 'ctx-0', 1, '2026-03-04T05:06:07.000Z')`,
    )
    .run(sessionId, engine);
}

async function admitRun(store: SqliteStore, row: EngineSessionInput, text = "hello") {
  const { run } = await store.admit({
    botId: "bot-es",
    sessionId: row.sessionId,
    origin: "http",
    idempotencyKey: `${row.sessionId}:${text}`,
    engine: row.engine,
    input: { parts: [{ type: "text", text }] },
  });
  return run.id;
}

function completion(runId: string, row?: EngineSessionInput): FinishRunInput {
  return {
    runId,
    end: {
      kind: "complete",
      ...(row !== undefined ? { engineSession: row } : {}),
    },
  };
}

const planResumed = (stored: unknown) => ({ contextMode: "resumed" as const, stored });

describe("hand the engine session over with the Run's finish", () => {
  it("writes the completed Run, its reply and the engine session at the reply's ordinal", async () => {
    const store = openStore();
    try {
      const runId = await admitRun(store, rowA);

      await store.finishRun({
        runId,
        end: {
          kind: "complete",
          finalMessageParts: [{ type: "text", text: "hi" }],
          engineSession: { ...rowA, lastOrdinal: 1 },
        },
      });

      expect([store.getRun(runId)?.status, store.getEngineSession("sess-a", "codex")]).toEqual([
        "completed",
        { ...rowA, lastOrdinal: 2, updatedAt: "2026-03-04T05:06:07.000Z" },
      ]);
    } finally {
      store.close();
    }
  });

  it.each([
    { handedOver: "none", row: undefined, codex: null },
    {
      handedOver: "its own row",
      row: rowA,
      codex: { ...rowA, updatedAt: "2026-03-04T05:06:07.000Z" },
    },
  ])(
    "replaces every engine session of the session when the Run hands over $handedOver",
    async ({ row, codex }) => {
      const store = openStore();
      try {
        insertRow(store, "sess-a", "codex");
        insertRow(store, "sess-a", "claude-code");
        insertRow(store, "sess-b", "codex");
        const runId = await admitRun(store, rowA);

        await store.finishRun(completion(runId, row));

        expect([
          store.getEngineSession("sess-a", "codex"),
          store.getEngineSession("sess-a", "claude-code"),
          store.getEngineSession("sess-b", "codex")?.vendorSessionId,
        ]).toEqual([codex, null, "vendor-0"]);
      } finally {
        store.close();
      }
    },
  );

  it("writes nothing when a replayed finish finds the Run already terminal", async () => {
    const store = openStore();
    try {
      const runId = await admitRun(store, rowA);
      await store.finishRun(completion(runId));

      await store.finishRun(completion(runId, rowA));

      expect(store.getEngineSession("sess-a", "codex")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("keeps the successor's engine session when a finished Run is finished again under another key", async () => {
    const store = openStore();
    try {
      const first = await admitRun(store, rowA, "first");
      await store.finishRun(completion(first, rowA));
      const second = await admitRun(store, rowA, "second");
      await store.finishRun(completion(second, { ...rowA, vendorSessionId: "vendor-b" }));

      await store.finishRun(completion(first));

      expect(store.getEngineSession("sess-a", "codex")?.vendorSessionId).toBe("vendor-b");
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
  it("plans with the engine's row, deletes every row of that session only and records the mode", async () => {
    const store = openStore();
    try {
      insertRow(store, "sess-a", "codex");
      insertRow(store, "sess-a", "claude-code");
      insertRow(store, "sess-b", "codex");
      const runId = await admitRun(store, rowA);

      const planned = store.takeEngineSession(runId, planResumed);

      expect([
        planned,
        store.getRun(runId)?.contextMode,
        store.getEngineSession("sess-a", "codex"),
        store.getEngineSession("sess-a", "claude-code"),
        store.getEngineSession("sess-b", "codex")?.vendorSessionId,
      ]).toEqual([
        {
          contextMode: "resumed",
          stored: {
            sessionId: "sess-a",
            engine: "codex",
            vendorSessionId: "vendor-0",
            baseHash: "base-0",
            contextHash: "ctx-0",
            lastOrdinal: 1,
            updatedAt: "2026-03-04T05:06:07.000Z",
          },
        },
        "resumed",
        null,
        null,
        "vendor-0",
      ]);
    } finally {
      store.close();
    }
  });

  it("changes nothing and does not plan once an interrupt ended the Run and a successor finished", async () => {
    const store = openStore();
    try {
      const stale = await admitRun(store, rowA, "first");
      await store.finishRun({
        runId: stale,
        end: { kind: "interrupt", detail: "interrupted" },
      });
      await store.finishRun(completion(await admitRun(store, rowA, "second"), rowA));
      const plannedWith: unknown[] = [];

      const planned = store.takeEngineSession(stale, (stored) => {
        plannedWith.push(stored);
        return planResumed(stored);
      });

      expect([
        planned,
        plannedWith,
        store.getRun(stale)?.contextMode,
        store.getEngineSession("sess-a", "codex")?.vendorSessionId,
      ]).toEqual([undefined, [], null, "vendor-1"]);
    } finally {
      store.close();
    }
  });
});

describe("delete a session", () => {
  it("removes its engine sessions and keeps other sessions' rows", async () => {
    const store = openStore();
    try {
      insertRow(store, "sess-a", "codex");
      insertRow(store, "sess-b", "codex");

      store.database.db.query("DELETE FROM sessions WHERE id = ?").run("sess-a");

      expect([
        store.getEngineSession("sess-a", "codex"),
        store.getEngineSession("sess-b", "codex")?.vendorSessionId,
      ]).toEqual([null, "vendor-0"]);
    } finally {
      store.close();
    }
  });
});
