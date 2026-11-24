import { afterEach, describe, expect, it } from "bun:test";
import type { Engine, EngineEvent, EngineKind, Run } from "@der/domain";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const REPORTED = {
  inputTokens: 1050,
  cachedInputTokens: 900,
  cacheWriteTokens: null,
  outputTokens: 40,
  reportedCostUsd: 0.0123,
};

function usageEngine(usage: typeof REPORTED | undefined): Engine {
  return {
    kind: "fixture",
    async *run(run: Run): AsyncIterable<EngineEvent> {
      yield {
        type: "chunk",
        chunkKey: `${run.id}:started`,
        chunk: { type: "RUN_STARTED", threadId: run.sessionId, runId: run.id },
      };
      yield { type: "completed", ...(usage !== undefined ? { usage } : {}) };
    },
  };
}

async function startUsageServer(engine: Engine): Promise<RunningServer> {
  const tempDb = createTempDatabase("der-run-usage-");
  const server = await startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateMode: "direct",
      databasePath: tempDb.dbPath,
      memoryProjectionDir: `${tempDb.dir}/memory`,
      skillsRootDir: `${tempDb.dir}/skills`,
      workspaceRootDir: `${tempDb.dir}/workspaces`,
      enabledEngines: ["fixture"],
      approvalTimeoutMs: 30_000,
      seedFixture: true,
    },
    engines: new Map<EngineKind, Engine>([["fixture", engine]]),
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return server;
}

async function completedRun(server: RunningServer, key: string): Promise<Run> {
  const { run } = await server.coordinator.admit({
    botId: server.seededFixture!.bot.id,
    sessionId: server.seededFixture!.session.id,
    origin: "http",
    idempotencyKey: key,
    input: { parts: [{ type: "text", text: key }] },
  });
  await waitUntil(async () => server.store.getRun(run.id)?.status === "completed", {
    timeoutMs: 10_000,
    label: `run ${key} completed`,
  });
  return run;
}

describe("serve the usage a Run recorded", () => {
  it("returns the engine's usage from the Run route and lists the Run under its session", async () => {
    const server = await startUsageServer(usageEngine(REPORTED));
    const run = await completedRun(server, "usage-reported");

    const detail = (await (await fetch(`${server.url}/api/runs/${run.id}`)).json()) as {
      run: Run;
    };
    const listed = (await (
      await fetch(`${server.url}/api/sessions/${run.sessionId}/runs`)
    ).json()) as { runs: Run[] };

    expect([detail.run.usage, detail.run.contextMode]).toEqual([REPORTED, null]);
    expect(listed.runs.map((entry) => [entry.id, entry.usage, entry.contextMode])).toEqual([
      [run.id, REPORTED, null],
    ]);
  }, 60_000);

  it("lists the newest Run first and reports usage null for a Run whose engine gave none", async () => {
    const server = await startUsageServer(usageEngine(undefined));
    const first = await completedRun(server, "usage-none-1");
    const second = await completedRun(server, "usage-none-2");

    const listed = (await (
      await fetch(`${server.url}/api/sessions/${first.sessionId}/runs`)
    ).json()) as { runs: Run[] };

    expect(listed.runs.map((entry) => [entry.id, entry.usage])).toEqual([
      [second.id, null],
      [first.id, null],
    ]);
  }, 60_000);

  it("answers 404 session.not_found for a session that does not exist", async () => {
    const server = await startUsageServer(usageEngine(undefined));

    const response = await fetch(`${server.url}/api/sessions/sess-missing/runs`);

    expect([response.status, ((await response.json()) as { code: string }).code]).toEqual([
      404,
      "session.not_found",
    ]);
  }, 60_000);
});
