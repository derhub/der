import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { RunUsage } from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function openStore(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), "der-run-usage-"));
  tempDirs.push(dir);
  return openSqliteStore({ filename: join(dir, "der.sqlite") });
}

function seed(store: SqliteStore) {
  const bot = store.createBot({
    id: "bot-usage",
    name: "Usage Bot",
    persona: "p",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({ id: "sess-usage", botId: bot.id, title: "Usage" });
  return { bot, session };
}

async function runToCompletion(
  store: SqliteStore,
  seeded: ReturnType<typeof seed>,
  key: string,
  usage?: RunUsage,
) {
  const { run } = await store.admit({
    botId: seeded.bot.id,
    sessionId: seeded.session.id,
    origin: "http",
    idempotencyKey: key,
    input: { parts: [{ type: "text", text: key }] },
  });
  await store.finishRun({
    runId: run.id,
    status: "completed",
    terminalEvent: { chunkKey: `${run.id}:terminal`, chunk: { type: "RUN_FINISHED" } },
    ...(usage !== undefined ? { usage } : {}),
  });
  return run.id;
}

describe("record usage on a finished Run", () => {
  it("reads back every usage field of a Run that finished with usage", async () => {
    const store = openStore();
    try {
      const seeded = seed(store);
      const runId = await runToCompletion(store, seeded, "with-usage", {
        inputTokens: 1200,
        cachedInputTokens: 800,
        cacheWriteTokens: 50,
        outputTokens: 340,
        reportedCostUsd: 0.0123,
      });

      expect(store.getRun(runId)).toMatchObject({
        usage: {
          inputTokens: 1200,
          cachedInputTokens: 800,
          cacheWriteTokens: 50,
          outputTokens: 340,
          reportedCostUsd: 0.0123,
        },
        contextMode: null,
      });
    } finally {
      store.close();
    }
  });

  it("reads back null for the vendor figures a Run did not report", async () => {
    const store = openStore();
    try {
      const seeded = seed(store);
      const runId = await runToCompletion(store, seeded, "partial-usage", {
        inputTokens: 10,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: 2,
        reportedCostUsd: null,
      });

      expect(store.getRun(runId)?.usage).toEqual({
        inputTokens: 10,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: 2,
        reportedCostUsd: null,
      });
    } finally {
      store.close();
    }
  });

  it("reads usage null for a Run that finished without usage", async () => {
    const store = openStore();
    try {
      const seeded = seed(store);
      const runId = await runToCompletion(store, seeded, "no-usage");

      expect(store.getRun(runId)?.usage).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("list the Runs of a session", () => {
  it("lists the newest Run first with its usage", async () => {
    const store = openStore();
    try {
      const seeded = seed(store);
      const first = await runToCompletion(store, seeded, "first");
      const second = await runToCompletion(store, seeded, "second", {
        inputTokens: 7,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: 3,
        reportedCostUsd: null,
      });

      const listed = store.listSessionRuns(seeded.session.id);

      expect(listed.map((run) => [run.id, run.usage?.inputTokens ?? null])).toEqual([
        [second, 7],
        [first, null],
      ]);
    } finally {
      store.close();
    }
  });
});
