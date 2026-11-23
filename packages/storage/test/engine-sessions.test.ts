import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
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
  return openSqliteStore({
    filename: join(dir, "der.sqlite"),
    now: () => new Date("2026-03-04T05:06:07.000Z"),
  });
}

function seed(store: SqliteStore) {
  const bot = store.createBot({
    id: "bot-es",
    name: "Engine Session Bot",
    persona: "p",
    defaultEngine: "fixture",
    allowedEngines: ["fixture", "codex"],
  });
  store.createSession({ id: "sess-a", botId: bot.id, title: "A" });
  store.createSession({ id: "sess-b", botId: bot.id, title: "B" });
}

const rowA = {
  sessionId: "sess-a",
  engine: "codex",
  vendorSessionId: "vendor-1",
  baseHash: "base-1",
  contextHash: "ctx-1",
  lastOrdinal: 4,
} as const;

describe("engine session round trip", () => {
  it("returns the saved row, replaces it on a second save and leaves another engine untouched", () => {
    const store = openStore();
    try {
      seed(store);
      expect(store.getEngineSession("sess-a", "codex")).toBeNull();

      store.saveEngineSession(rowA);
      store.saveEngineSession({ ...rowA, engine: "claude-code", vendorSessionId: "vendor-cc" });
      expect(store.getEngineSession("sess-a", "codex")).toEqual({
        ...rowA,
        pendingRunId: null,
        updatedAt: "2026-03-04T05:06:07.000Z",
      });

      store.saveEngineSession({
        ...rowA,
        vendorSessionId: "vendor-2",
        contextHash: "ctx-2",
        lastOrdinal: 9,
      });
      expect(store.getEngineSession("sess-a", "codex")).toEqual({
        ...rowA,
        vendorSessionId: "vendor-2",
        contextHash: "ctx-2",
        lastOrdinal: 9,
        pendingRunId: null,
        updatedAt: "2026-03-04T05:06:07.000Z",
      });
      expect(store.getEngineSession("sess-a", "claude-code")?.vendorSessionId).toBe("vendor-cc");
    } finally {
      store.close();
    }
  });
});

describe("engine session pending", () => {
  it("marks an existing row pending, ignores a missing row and clears on save", () => {
    const store = openStore();
    try {
      seed(store);
      store.markEngineSessionPending("sess-a", "codex", "run-1");
      expect(store.getEngineSession("sess-a", "codex")).toBeNull();

      store.saveEngineSession(rowA);
      store.markEngineSessionPending("sess-a", "codex", "run-1");
      expect(store.getEngineSession("sess-a", "codex")?.pendingRunId).toBe("run-1");

      store.saveEngineSession({ ...rowA, lastOrdinal: 6 });
      expect(store.getEngineSession("sess-a", "codex")?.pendingRunId).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("engine session save from an older finish", () => {
  it.each([
    { case: "an equal last ordinal", lastOrdinal: 9 },
    { case: "a lower last ordinal", lastOrdinal: 4 },
  ])("keeps the stored row and its pending mark on $case", ({ lastOrdinal }) => {
    const store = openStore();
    try {
      seed(store);
      store.saveEngineSession({ ...rowA, vendorSessionId: "vendor-new", lastOrdinal: 9 });
      store.markEngineSessionPending("sess-a", "codex", "run-3");

      store.saveEngineSession({
        ...rowA,
        vendorSessionId: "vendor-old",
        contextHash: "ctx-old",
        lastOrdinal,
      });

      expect(store.getEngineSession("sess-a", "codex")).toEqual({
        ...rowA,
        vendorSessionId: "vendor-new",
        lastOrdinal: 9,
        pendingRunId: "run-3",
        updatedAt: "2026-03-04T05:06:07.000Z",
      });
    } finally {
      store.close();
    }
  });
});

describe("engine session drop", () => {
  it("drops one engine row and deleting the session removes all of its rows", () => {
    const store = openStore();
    try {
      seed(store);
      store.saveEngineSession(rowA);
      store.saveEngineSession({ ...rowA, engine: "claude-code" });
      store.saveEngineSession({ ...rowA, sessionId: "sess-b" });

      store.dropEngineSession("sess-a", "codex");
      expect(store.getEngineSession("sess-a", "codex")).toBeNull();
      expect(store.getEngineSession("sess-a", "claude-code")?.vendorSessionId).toBe("vendor-1");

      store.database.db.query("DELETE FROM sessions WHERE id = ?").run("sess-a");
      expect(store.getEngineSession("sess-a", "claude-code")).toBeNull();
      expect(store.getEngineSession("sess-b", "codex")?.vendorSessionId).toBe("vendor-1");
    } finally {
      store.close();
    }
  });
});
