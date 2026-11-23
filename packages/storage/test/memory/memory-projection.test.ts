import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@der/domain";
import { openSqliteStore } from "@der/storage";
import {
  createMemoryProjection,
  MEMORY_ROUTINE_SLOTS_MIGRATION,
  openSqliteMemory,
} from "@der/storage/memory";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Bot-scoped versioned SQLite Memory and Markdown projection", () => {
  it("stores monotonically versioned Memory per Bot and reads latest or specific versions without cross-bot leakage", async () => {
    const dir = createTempDir("der-memory-versions-");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 5, 1, 10, 0, tick++));
    const store = openSqliteStore({
      filename: join(dir, "der.sqlite"),
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
      now,
    });
    const projection = createMemoryProjection(join(dir, "memory-md"));
    const memory = openSqliteMemory({ database: store.database, projection });

    try {
      const botA = store.createBot({
        id: "bot-alpha",
        name: "Alpha",
        persona: "Alpha bot",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });
      const botB = store.createBot({
        id: "bot-beta",
        name: "Beta",
        persona: "Beta bot",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });

      expect(await memory.read(botA.id)).toBeUndefined();

      const v1 = await memory.write({
        botId: botA.id,
        expectedVersion: 0,
        markdown: "# Alpha\n\nPrefers concise reports.\n",
      });
      const v2 = await memory.write({
        botId: botA.id,
        expectedVersion: 1,
        markdown: "# Alpha\n\nPrefers concise reports and UTC timestamps.\n",
      });
      const b1 = await memory.write({
        botId: botB.id,
        markdown: "# Beta\n\nSeparate bot memory.\n",
      });

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(b1.version).toBe(1);

      expect(await memory.read(botA.id)).toEqual(v2);
      expect(await memory.read(botA.id, 1)).toEqual(v1);
      expect(await memory.read(botA.id, 2)).toEqual(v2);
      expect(await memory.read(botA.id, 3)).toBeUndefined();
      expect(await memory.read(botB.id)).toEqual(b1);
      expect(memory.listVersions(botA.id)).toEqual([v1, v2]);

      const alphaPath = projection.pathForBot(botA.id);
      expect(readFileSync(alphaPath, "utf8")).toBe(v2.markdown);
      expect(readFileSync(projection.pathForBot(botB.id), "utf8")).toBe(b1.markdown);
      expect(readdirSync(join(dir, "memory-md")).sort()).toEqual(["bot-alpha.md", "bot-beta.md"]);
    } finally {
      store.close();
    }
  });

  it("rejects stale expectedVersion writes with a 409 conflict and missing bots with 404", async () => {
    const dir = createTempDir("der-memory-conflict-");
    const store = openSqliteStore({
      filename: join(dir, "der.sqlite"),
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
    });
    const memory = openSqliteMemory({ database: store.database });

    try {
      const bot = store.createBot({
        id: "bot-cas",
        name: "CAS Bot",
        persona: "Strict",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });

      await memory.write({ botId: bot.id, expectedVersion: 0, markdown: "v1" });

      let conflictErr: unknown;
      try {
        await memory.write({ botId: bot.id, expectedVersion: 0, markdown: "stale" });
      } catch (error) {
        conflictErr = error;
      }
      expect(conflictErr).toBeInstanceOf(DomainError);
      expect((conflictErr as DomainError).status).toBe(409);
      expect((conflictErr as DomainError).code).toBe("memory.version_conflict");

      let missingErr: unknown;
      try {
        await memory.write({ botId: "bot-does-not-exist", markdown: "orphan" });
      } catch (error) {
        missingErr = error;
      }
      expect(missingErr).toBeInstanceOf(DomainError);
      expect((missingErr as DomainError).status).toBe(404);
      expect((missingErr as DomainError).code).toBe("bot.not_found");
    } finally {
      store.close();
    }
  });

  it("reconciles missing and stale Markdown projections atomically from SQLite", async () => {
    const dir = createTempDir("der-memory-reconcile-");
    const projectionDir = join(dir, "projected");
    const store = openSqliteStore({
      filename: join(dir, "der.sqlite"),
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
    });
    const projection = createMemoryProjection(projectionDir);
    const memory = openSqliteMemory({ database: store.database, projection });

    try {
      const botMissing = store.createBot({
        id: "bot-missing",
        name: "Missing",
        persona: "P",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });
      const botStale = store.createBot({
        id: "bot-stale",
        name: "Stale",
        persona: "P",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });
      const botFresh = store.createBot({
        id: "bot-fresh",
        name: "Fresh",
        persona: "P",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });

      await memory.write({ botId: botMissing.id, markdown: "authoritative missing\n" });
      await memory.write({ botId: botStale.id, markdown: "authoritative stale v2\n" });
      await memory.write({ botId: botFresh.id, markdown: "authoritative fresh\n" });

      unlinkSync(projection.pathForBot(botMissing.id));
      writeFileSync(projection.pathForBot(botStale.id), "corrupted stale drift\n", "utf8");

      const results = await memory.reconcile();
      const byBot = new Map(results.map((entry) => [entry.botId, entry]));

      expect(byBot.get(botMissing.id)?.status).toBe("created");
      expect(byBot.get(botStale.id)?.status).toBe("rebuilt");
      expect(byBot.get(botFresh.id)?.status).toBe("unchanged");

      expect(readFileSync(projection.pathForBot(botMissing.id), "utf8")).toBe(
        "authoritative missing\n",
      );
      expect(readFileSync(projection.pathForBot(botStale.id), "utf8")).toBe(
        "authoritative stale v2\n",
      );
      expect(readdirSync(projectionDir).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      store.close();
    }
  });

  it.each([
    { label: "parent traversal", botId: "../escape" },
    { label: "nested slash", botId: "nested/bot" },
    { label: "backslash", botId: "win\\bot" },
    { label: "empty id", botId: "" },
  ])("rejects unsafe projection bot ID ($label)", ({ botId }) => {
    const dir = createTempDir("der-memory-unsafe-");
    const projection = createMemoryProjection(join(dir, "md"));

    let caught: unknown;
    try {
      projection.pathForBot(botId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("memory.invalid_projection_id");
  });
});
