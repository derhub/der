import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { formatUtcTimestamp } from "@der/domain";
import { startServer, type RunningServer } from "#main";
import {
  allocateLocalTcpNumber,
  createTempDatabase,
  ensureLocalRestate,
  registerRestateDeployment,
  waitUntil,
  type LocalRestateHandle,
  type TempDatabaseHandle,
} from "./fixtures/restate-harness";
import { createNoteHost, type NoteHost } from "./fixtures/script-host";

let restateHandle: LocalRestateHandle | undefined;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  restateHandle = await ensureLocalRestate();
}, 150_000);

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

afterAll(async () => {
  await restateHandle?.stop();
}, 30_000);

async function startRestateServer(
  tempDb: TempDatabaseHandle,
  restateListen: number,
  host: NoteHost,
  seedFixture: boolean,
): Promise<RunningServer> {
  const restate = restateHandle!;
  const server = await startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateHost: "127.0.0.1",
      restateListen,
      restateIngressUrl: restate.ingressUrl,
      restateAdminUrl: restate.adminUrl,
      restateMode: "restate",
      databasePath: tempDb.dbPath,
      memoryProjectionDir: `${tempDb.dir}/memory`,
      skillsRootDir: `${tempDb.dir}/skills`,
      workspaceRootDir: `${tempDb.dir}/workspaces`,
      enabledEngines: ["fixture"],
      approvalTimeoutMs: 300_000,
      seedFixture,
    },
    catalog: host.catalog,
  });
  await registerRestateDeployment(restate.adminUrl, server.restateUrl!, { force: true });
  return server;
}

const WAIT_PAST_RESTATE_TIMEOUTS_MS = 150_000;

const PUBLISH = `return await der.notes.publish({ text: "release" });`;

async function createScriptRoutine(server: RunningServer, script: string) {
  return server.routineSchedule.configure("rt-restate", {
    kind: "create",
    botId: server.seededFixture!.bot.id,
    sessionId: server.seededFixture!.session.id,
    name: "Nightly",
    cron: "0 3 * * *",
    enabled: true,
    engine: "script",
    script,
  });
}

function fire(server: RunningServer, day: string) {
  return server.routineSchedule.tick("rt-restate", {
    revision: 1,
    scheduledSlot: `${day}T03:00:00.000Z`,
    nowOverride: `${day}T03:00:30.000Z`,
  });
}

function pendingApproval(server: RunningServer, runId: string) {
  return waitUntil(
    async () => {
      const latest = server.store.getLatestApprovalForRun(runId);
      return latest?.decision.status === "pending" ? latest : false;
    },
    { timeoutMs: 60_000, label: "pending approval" },
  );
}

function approvalCount(server: RunningServer, runId: string): number {
  return server.store.database.db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?")
    .get(runId)!.n;
}

describe("a script routine under Restate", () => {
  it("fires: a due script routine completes its run with the script's result", async () => {
    const tempDb = createTempDatabase("der-script-routine-restate-");
    cleanups.push(() => tempDb.cleanup());
    const host = createNoteHost();
    const server = await startRestateServer(tempDb, await allocateLocalTcpNumber(), host, true);
    cleanups.push(() => server.close());
    await createScriptRoutine(server, `return await der.notes.read({ key: "a" });`);

    const tick = await fire(server, "2026-06-01");
    const run = await waitUntil(
      async () => {
        const current = server.store.getRun(tick.runId!);
        return current?.status === "completed" ? current : false;
      },
      { timeoutMs: 60_000, label: "script routine run" },
    );

    expect(tick.disposition).toBe("admitted");
    expect(run).toMatchObject({ engine: "script", origin: "routine", routineId: "rt-restate" });
    const result = server.store
      .readRunEventsAfter(run.id, 0)
      .map((event) => event.chunk as { type: string; content?: string })
      .find((chunk) => chunk.type === "TOOL_CALL_RESULT");
    expect(JSON.parse(result!.content!)).toEqual({
      ok: true,
      result: { value: "value-a" },
      logs: [],
      truncated: false,
    });
    expect(host.reads).toEqual(["a"]);
  }, 120_000);

  it("restart: a server restart while the script waits on an approval leaves one pending approval and one effect after approval", async () => {
    const tempDb = createTempDatabase("der-script-routine-restart-");
    cleanups.push(() => tempDb.cleanup());
    const restateListen = await allocateLocalTcpNumber();
    const host = createNoteHost();
    let first: RunningServer | undefined = await startRestateServer(
      tempDb,
      restateListen,
      host,
      true,
    );
    cleanups.push(async () => {
      await first?.close();
    });
    await createScriptRoutine(first, PUBLISH);
    const tick = await fire(first, "2026-06-01");
    const runId = tick.runId!;
    const approval = await pendingApproval(first, runId);
    expect(first.store.getRun(runId)?.status).toBe("waiting_approval");

    const closing = first;
    first = undefined;
    await closing.close();
    const replacement = await startRestateServer(tempDb, restateListen, host, false);
    cleanups.push(() => replacement.close());

    await replacement.coordinator.decide({
      approvalId: approval.id,
      botId: replacement.store.getRun(runId)!.botId,
      sessionId: replacement.store.getRun(runId)!.sessionId,
      runId,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    const run = await waitUntil(
      async () => {
        const current = replacement.store.getRun(runId);
        return current?.status === "completed" ? current : false;
      },
      { timeoutMs: 120_000, label: "approved script routine run after restart" },
    );

    expect(run.status).toBe("completed");
    expect(
      replacement.store
        .readRunEventsAfter(runId, 0)
        .map((event) => (event.chunk as { type: string }).type),
    ).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "CUSTOM",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(approvalCount(replacement, runId)).toBe(1);
    expect(host.published).toEqual(["release"]);
    expect(
      replacement.store.getEffect({ ...approval.effect, operationKind: "capability" })?.status,
    ).toBe("completed");
    expect(
      replacement.store.database.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM script_runs WHERE run_id = ?")
        .get(runId)!.n,
    ).toBe(1);
  }, 300_000);

  it("wait: a script parked on an approval past the Restate inactivity and abort timeouts completes once approved with one approval and one effect", async () => {
    const tempDb = createTempDatabase("der-script-routine-wait-");
    cleanups.push(() => tempDb.cleanup());
    const host = createNoteHost();
    const server = await startRestateServer(tempDb, await allocateLocalTcpNumber(), host, true);
    cleanups.push(() => server.close());
    await createScriptRoutine(server, PUBLISH);
    const tick = await fire(server, "2026-06-01");
    const runId = tick.runId!;
    const approval = await pendingApproval(server, runId);

    await Bun.sleep(WAIT_PAST_RESTATE_TIMEOUTS_MS);

    expect(server.store.getRun(runId)?.status).toBe("waiting_approval");
    expect(approvalCount(server, runId)).toBe(1);
    await server.coordinator.decide({
      approvalId: approval.id,
      botId: server.seededFixture!.bot.id,
      sessionId: server.seededFixture!.session.id,
      runId,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    await waitUntil(
      async () => (server.store.getRun(runId)?.status === "completed" ? true : false),
      { timeoutMs: 120_000, label: "approved script routine run after a long wait" },
    );

    expect(approvalCount(server, runId)).toBe(1);
    expect(host.published).toEqual(["release"]);
    expect(
      server.store.getEffect({ ...approval.effect, operationKind: "capability" })?.status,
    ).toBe("completed");
  }, 420_000);
});
