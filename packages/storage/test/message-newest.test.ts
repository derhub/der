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

function storeWithMessages(count: number): { store: SqliteStore; sessionId: string } {
  const dir = mkdtempSync(join(tmpdir(), "der-storage-newest-"));
  tempDirs.push(dir);
  const store = openSqliteStore({ filename: join(dir, "der.sqlite") });
  const bot = store.createBot({
    id: "bot-newest",
    name: "Newest Bot",
    persona: "Pages history.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({ id: "sess-newest", botId: bot.id, title: "Long" });
  const insert = store.database.db.query(
    `INSERT INTO messages (id, bot_id, session_id, ordinal, role, parts_json, run_id, created_at)
     VALUES (?, ?, ?, ?, 'user', ?, NULL, '2026-01-01T00:00:00.000Z')`,
  );
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    insert.run(
      `msg-${ordinal}`,
      bot.id,
      session.id,
      ordinal,
      JSON.stringify([{ type: "text", text: `m${ordinal}` }]),
    );
  }
  return { store, sessionId: session.id };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

describe("page a long session's messages", () => {
  it("returns the last 200 messages in ascending order when newest is set", () => {
    const { store, sessionId } = storeWithMessages(250);
    try {
      const page = store.listMessages(sessionId, { limit: 200, newest: true });
      expect(page.map((message) => message.ordinal)).toEqual(range(51, 250));
    } finally {
      store.close();
    }
  });

  it("returns the first 200 messages when newest is not set", () => {
    const { store, sessionId } = storeWithMessages(250);
    try {
      const page = store.listMessages(sessionId, { limit: 200 });
      expect(page.map((message) => message.ordinal)).toEqual(range(1, 200));
    } finally {
      store.close();
    }
  });

  it("returns every message in ascending order when the session is shorter than the limit", () => {
    const { store, sessionId } = storeWithMessages(3);
    try {
      const page = store.listMessages(sessionId, { limit: 200, newest: true });
      expect(page.map((message) => message.ordinal)).toEqual([1, 2, 3]);
    } finally {
      store.close();
    }
  });
});
