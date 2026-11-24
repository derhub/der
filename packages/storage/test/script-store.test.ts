import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "bun:test";
import type { UtcTimestamp } from "@der/domain";
import { formatUtcTimestamp } from "@der/domain";
import { openSqliteScriptStore, openSqliteStore } from "@der/storage";
import { scriptStoreContract, type ScriptStoreHarness } from "./script-store-contract";

async function openSqliteHarness(): Promise<ScriptStoreHarness> {
  const dir = mkdtempSync(join(tmpdir(), "der-script-store-"));
  const filename = join(dir, "der.sqlite");
  let nowMs = Date.parse("2026-11-24T10:00:00.000Z");
  const now = () => new Date(nowMs);
  const opened = [] as { close(): void }[];
  const open = () => {
    const store = openSqliteStore({ filename, now });
    opened.push(store);
    return store;
  };

  const base = open();
  const bot = base.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "Test bot.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = base.createSession({ id: "sess-1", botId: bot.id, title: "Session" });
  let runs = 0;

  return {
    store: openSqliteScriptStore({ database: base.database }),
    reopen: () => {
      base.close();
      return openSqliteScriptStore({ database: open().database });
    },
    async newRun() {
      runs += 1;
      const { run } = await base.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: `req-${runs}`,
        input: { parts: [{ type: "text", text: "go" }] },
      });
      return { runId: run.id, botId: bot.id };
    },
    advance(ms) {
      nowMs += ms;
    },
    now: (): UtcTimestamp => formatUtcTimestamp(now()),
    dispose() {
      for (const store of opened) {
        try {
          store.close();
        } catch {
          // already closed by reopen
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("SQLite script store", () => {
  scriptStoreContract(openSqliteHarness);
});
