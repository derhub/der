import { afterEach, describe, expect, it } from "bun:test";
import { formatUtcTimestamp, type Run } from "@der/domain";
import { createExecuteTool } from "#code-mode/execute";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";
import { admitOwningRun, createNoteHost } from "./fixtures/script-host";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const INLINE_WAIT_MS = 300;
const PUBLISH = `return await step.run("notes.publish", { text: "release" });`;
const APPEND = `return await step.run("notes.append", { text: "a" });`;

async function startHybridServer() {
  const tempDb = createTempDatabase("der-hybrid-execute-");
  const host = createNoteHost();
  const server: RunningServer = await startServer({
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
      scriptInlineWaitMs: INLINE_WAIT_MS,
      seedFixture: true,
    },
    catalog: host.catalog,
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return { server, host };
}

type Owner = Awaited<ReturnType<typeof admitOwningRun>>;

function executeToolFor(server: RunningServer, run: Run, inlineWaitMs = INLINE_WAIT_MS) {
  const tool = createExecuteTool({
    run,
    scriptRunStore: server.scriptRunStore,
    scriptDriver: server.scriptDriver,
    maxResultBytes: 65_536,
    inlineWaitMs,
  });
  return (script: string, key?: string): Promise<unknown> =>
    tool.execute!(key === undefined ? { script } : { script, key }, {
      signal: AbortSignal.timeout(30_000),
    }) as Promise<unknown>;
}

async function endOwningRun(server: RunningServer, owner: Owner) {
  await server.store.finishRun({
    runId: owner.run.id,
    status: "completed",
    terminalEvent: {
      chunkKey: `${owner.run.id}:terminal`,
      chunk: { type: "RUN_FINISHED", runId: owner.run.id },
    },
  });
  await server.scriptDriver.cancelRun(owner.run.id);
}

function approve(server: RunningServer, owner: Owner, approvalId: string) {
  return server.commands.decideApproval({
    approvalId,
    botId: owner.botId,
    sessionId: owner.sessionId,
    runId: owner.run.id,
    status: "approved",
    actor: "operator",
    decidedAt: formatUtcTimestamp(new Date()),
  } as Parameters<RunningServer["coordinator"]["decide"]>[0]);
}

function sessionEvents(server: RunningServer) {
  return server.store.database.db
    .query<{ id: string; state: string; payload_json: string }, []>(
      "SELECT id, state, payload_json FROM session_events ORDER BY rowid",
    )
    .all();
}

function eventRuns(server: RunningServer) {
  return server.store.database.db
    .query<{ id: string }, []>("SELECT id FROM runs WHERE origin = 'event'")
    .all();
}

describe("execute a Script that ends inside the inline wait", () => {
  it("returns the value and enqueues no event", async () => {
    const { server } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-inline");

    const result = await executeToolFor(
      server,
      owner.run,
    )(`return await step.run("notes.read", { key: "a" });`);

    expect(result).toEqual({ ok: true, result: { value: "value-a" }, logs: [], truncated: false });
    expect(sessionEvents(server)).toEqual([]);
  }, 60_000);
});

describe("execute a Script that waits on an Approval past the inline wait", () => {
  it("returns pending with the proposed writes and lets the Run finish", async () => {
    const { server } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-pending");

    const result = await executeToolFor(server, owner.run)(PUBLISH);

    expect(result).toEqual({
      status: "pending",
      executionId: expect.stringMatching(/^sr_/),
      proposedWrites: [{ position: 1, capability: "notes.publish", input: { text: "release" } }],
    });
    expect(server.store.getRun(owner.run.id)?.status).toBe("running");

    await endOwningRun(server, owner);

    expect(server.store.getRun(owner.run.id)?.status).toBe("completed");
  }, 60_000);

  it("returns pending again for a repeated identical call and starts no second execution", async () => {
    const { server } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-repeat");
    const execute = executeToolFor(server, owner.run);

    const first = (await execute(PUBLISH)) as { executionId: string };
    const second = await execute(PUBLISH);

    expect(second).toEqual({
      status: "pending",
      executionId: first.executionId,
      proposedWrites: [{ position: 1, capability: "notes.publish", input: { text: "release" } }],
    });
    expect(
      server.store.database.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM script_runs WHERE run_id = ?")
        .get(owner.run.id)!.n,
    ).toBe(1);
  }, 60_000);

  it("applies the write once and delivers one script.finished event Run when approved after the Run ended", async () => {
    const { server, host } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-late-approval");
    const pending = (await executeToolFor(server, owner.run)(PUBLISH)) as { executionId: string };
    await endOwningRun(server, owner);

    const approval = server.store.getLatestApprovalForRun(owner.run.id)!;
    expect(approval.decision.status).toBe("pending");
    await approve(server, owner, approval.id);

    await waitUntil(async () => sessionEvents(server)[0]?.state === "delivered", {
      timeoutMs: 20_000,
      label: "event delivered",
    });
    expect(host.published).toEqual(["release"]);
    expect(JSON.parse(sessionEvents(server)[0]!.payload_json)).toEqual({
      event: "script.finished",
      executionId: pending.executionId,
      status: "completed",
      result: { ok: true, result: { published: true }, logs: [], truncated: false },
    });
    const [eventRun] = eventRuns(server);
    expect(eventRuns(server)).toHaveLength(1);
    const message = server.store
      .listMessages(owner.sessionId)
      .find((candidate) => candidate.runId === eventRun!.id && candidate.role === "user")!;
    expect(message.parts).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          event: "script.finished",
          executionId: pending.executionId,
          status: "completed",
          result: { ok: true, result: { published: true }, logs: [], truncated: false },
        }),
      },
    ]);
  }, 60_000);

  it("admits a new human Run in the session while the detached execution still waits", async () => {
    const { server } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-next-run");
    await executeToolFor(server, owner.run)(PUBLISH);
    await endOwningRun(server, owner);

    const next = await server.store.admit({
      botId: owner.botId,
      sessionId: owner.sessionId,
      origin: "http",
      idempotencyKey: "hybrid-next-run-human",
      input: { parts: [{ type: "text", text: "next" }] },
    });

    expect(next.run.origin).toBe("http");
    expect(server.store.getLatestApprovalForRun(owner.run.id)?.decision.status).toBe("pending");
  }, 60_000);
});

const PUBLISHED = { ok: true, result: { published: true }, logs: [], truncated: false };

function scriptRunStatus(server: RunningServer, executionId: string) {
  return server.store.database.db
    .query<{ status: string }, [string]>("SELECT status FROM script_runs WHERE id = ?")
    .get(executionId)?.status;
}

async function approvePending(server: RunningServer, owner: Owner) {
  await waitUntil(
    async () => server.store.getLatestApprovalForRun(owner.run.id)?.decision.status === "pending",
    { timeoutMs: 20_000, label: "approval pending" },
  );
  await approve(server, owner, server.store.getLatestApprovalForRun(owner.run.id)!.id);
}

async function finishedExecution(server: RunningServer, owner: Owner, executionId: string) {
  await approvePending(server, owner);
  await waitUntil(async () => scriptRunStatus(server, executionId) === "completed", {
    timeoutMs: 20_000,
    label: "execution completed",
  });
}

describe("repeat an execute with the same Script", () => {
  it("returns the inline result on every identical repeat and applies the write once", async () => {
    const { server, host } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-inline-repeat");
    const execute = executeToolFor(server, owner.run, 5_000);

    const results = [await execute(APPEND), await execute(APPEND), await execute(APPEND)];

    const appended = { ok: true, result: { count: 1 }, logs: [], truncated: false };
    expect({ results, appended: host.appended }).toEqual({
      results: [appended, appended, appended],
      appended: ["a"],
    });
  }, 60_000);

  it("runs the Script again for a new key and returns that run on a repeat of the key", async () => {
    const { server, host } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-new-key");
    const execute = executeToolFor(server, owner.run, 5_000);

    await execute(APPEND);
    const keyed = await execute(APPEND, "second");
    const keyedAgain = await execute(APPEND, "second");

    const second = { ok: true, result: { count: 2 }, logs: [], truncated: false };
    expect({ keyed, keyedAgain, appended: host.appended }).toEqual({
      keyed: second,
      keyedAgain: second,
      appended: ["a", "a"],
    });
  }, 60_000);

  it("returns the stored result of a detached execution on every repeat and applies the write once", async () => {
    const { server, host } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-result-once");
    const execute = executeToolFor(server, owner.run);
    const pending = (await execute(PUBLISH)) as { executionId: string };
    await finishedExecution(server, owner, pending.executionId);

    const repeats = [await execute(PUBLISH), await execute(PUBLISH)];

    expect({ repeats, published: host.published }).toEqual({
      repeats: [PUBLISHED, PUBLISHED],
      published: ["release"],
    });
  }, 60_000);

  it("returns the stored result of an execute whose first call was aborted before the Script finished", async () => {
    const { server, host } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-result-aborted");
    const controller = new AbortController();
    const tool = createExecuteTool({
      run: owner.run,
      scriptRunStore: server.scriptRunStore,
      scriptDriver: server.scriptDriver,
      maxResultBytes: 65_536,
      inlineWaitMs: 5_000,
    });
    const aborted = tool.execute!({ script: PUBLISH }, { signal: controller.signal });
    await waitUntil(
      async () => server.store.getLatestApprovalForRun(owner.run.id)?.decision.status === "pending",
      { timeoutMs: 20_000, label: "approval pending" },
    );
    controller.abort();
    await aborted;
    await approvePending(server, owner);
    await waitUntil(async () => host.published.length === 1, {
      timeoutMs: 20_000,
      label: "write applied",
    });
    await Bun.sleep(100);

    const retried = await executeToolFor(server, owner.run)(PUBLISH);

    expect(retried).toEqual(PUBLISHED);
    expect(host.published).toEqual(["release"]);
  }, 60_000);

  it("still delivers the detached execution's script.finished event once", async () => {
    const { server } = await startHybridServer();
    const owner = await admitOwningRun(server, "hybrid-result-event");
    const execute = executeToolFor(server, owner.run);
    const pending = (await execute(PUBLISH)) as { executionId: string };
    await finishedExecution(server, owner, pending.executionId);

    await execute(PUBLISH);

    expect(sessionEvents(server).map((row) => JSON.parse(row.payload_json).executionId)).toEqual([
      pending.executionId,
    ]);
  }, 60_000);
});

describe("execute a Script that finishes as the inline wait ends", () => {
  it.each([0, 1, 3, 8, 15, 30])(
    "gives the result inline or as one event, never both, with a wait of %ims",
    async (waitMs) => {
      const { server } = await startHybridServer();
      const owner = await admitOwningRun(server, `hybrid-race-${waitMs}`);

      const result = (await executeToolFor(
        server,
        owner.run,
        waitMs,
      )(`return await step.run("notes.read", { key: "k${waitMs}" });`)) as {
        ok?: true;
        status?: "pending";
        executionId?: string;
      };

      if (result.status === "pending") {
        await waitUntil(async () => sessionEvents(server).length === 1, {
          timeoutMs: 10_000,
          label: "script.finished event",
        });
        await Bun.sleep(100);
        expect(
          sessionEvents(server).map((row) => JSON.parse(row.payload_json).executionId),
        ).toEqual([result.executionId]);
      } else {
        expect(result.ok).toBe(true);
        await Bun.sleep(100);
        expect(sessionEvents(server)).toEqual([]);
      }
    },
    60_000,
  );
});
