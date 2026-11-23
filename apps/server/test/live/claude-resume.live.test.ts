import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "@der/domain";
import { startServer } from "#main";
import { createTempDatabase, waitUntil } from "../fixtures/restate-harness";

const TURNS = 10;
const LIVE = process.env["DER_LIVE_CLAUDE"] === "1";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

// Needs Docker and the owner's Claude login in the engine-home volume; run it by hand:
// (cd apps/server && DER_LIVE_CLAUDE=1 bun test test/live/claude-resume.live.test.ts)
describe.skipIf(!LIVE)("hold one long Claude Code session at a steady cache cost", () => {
  it("writes under 1,000 cache tokens per Run after turn 1 and does not grow by turn 10", async () => {
    const tempDb = createTempDatabase("der-live-claude-resume-");
    const workspaceDir = join(tempDb.dir, "workspaces");
    mkdirSync(workspaceDir, { recursive: true });
    const server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateMode: "direct",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: join(tempDb.dir, "memory"),
        skillsRootDir: join(tempDb.dir, "skills"),
        workspaceRootDir: workspaceDir,
        enabledEngines: ["claude-code"],
      },
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });
    const bot = server.store.createBot({
      id: "bot-live-claude",
      name: "Live Claude",
      persona: "Answer in one short sentence.",
      defaultEngine: "claude-code",
      allowedEngines: ["claude-code"],
    });
    const session = server.store.createSession({
      id: "sess-live-claude",
      botId: bot.id,
      title: "Ten turns",
      engine: "claude-code",
    });

    const runs: Run[] = [];
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const { run } = await server.coordinator.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: `live-claude-turn-${turn}`,
        input: { parts: [{ type: "text", text: `Turn ${turn}: name one colour.` }] },
      });
      runs.push(
        await waitUntil(
          async () => {
            const current = server.store.getRun(run.id);
            return current?.status === "completed" || current?.status === "failed"
              ? current
              : undefined;
          },
          { timeoutMs: 180_000, intervalMs: 500, label: `live turn ${turn}` },
        ),
      );
    }

    const cacheWrites = runs.map((run) => run.usage?.cacheWriteTokens ?? null);
    const afterFirst = cacheWrites.slice(1);
    expect(runs.map((run) => run.status)).toEqual(Array(TURNS).fill("completed"));
    expect(afterFirst.every((tokens) => tokens !== null && tokens < 1_000)).toBe(true);
    expect(cacheWrites[TURNS - 1]!).toBeLessThanOrEqual(cacheWrites[1]!);
  }, 2_400_000);
});
