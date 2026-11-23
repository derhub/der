import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as z from "zod";
import {
  defineCapability,
  formatUtcTimestamp,
  type Capability,
  type Engine,
  type EngineEvent,
  type EngineKind,
  type Run,
} from "@der/domain";
import { createExecuteTool } from "#code-mode/execute";
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
import {
  admitOwningRun,
  createNoteHost,
  submitScript,
  type NoteHost,
} from "./fixtures/script-host";

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
  extra: {
    readonly approvalTimeoutMs?: number;
    readonly engines?: ReadonlyMap<EngineKind, Engine>;
  } = {},
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
      approvalTimeoutMs: extra.approvalTimeoutMs ?? 120_000,
      seedFixture,
    },
    catalog: host.catalog,
    ...(extra.engines === undefined ? {} : { engines: extra.engines }),
  });
  await registerRestateDeployment(restate.adminUrl, server.restateUrl!, { force: true });
  return server;
}

describe("recover a script run across a server restart", () => {
  it("restart: a script run parked on an approval completes after approval with every earlier call executed once", async () => {
    const tempDb = createTempDatabase("der-script-recovery-");
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
    const owner = await admitOwningRun(first, "recovery-1");
    const scriptRun = await submitScript(
      first,
      owner,
      `
        const a = await der.notes.read({ key: "a" });
        const b = await der.notes.read({ key: "b" });
        const published = await der.notes.publish({ text: a.value + b.value });
        const c = await der.notes.read({ key: "c" });
        return { published, c: c.value };
      `,
    );

    const approval = await waitUntil(
      async () => {
        const latest = first!.store.getLatestApprovalForRun(owner.run.id);
        return latest?.decision.status === "pending" ? latest : false;
      },
      { timeoutMs: 60_000, label: "pending approval before restart" },
    );
    expect(host.reads).toEqual(["a", "b"]);
    expect(host.published).toEqual([]);

    const closing = first;
    first = undefined;
    await closing.close();
    const replacement = await startRestateServer(tempDb, restateListen, host, false);
    cleanups.push(() => replacement.close());

    await replacement.coordinator.decide({
      approvalId: approval.id,
      botId: owner.botId,
      sessionId: owner.sessionId,
      runId: owner.run.id,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    const result = await replacement.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(90_000));

    expect(result).toEqual({
      ok: true,
      result: { published: { published: true }, c: "value-c" },
      logs: [],
      truncated: false,
    });
    expect(host.reads).toEqual(["a", "b", "c"]);
    expect(host.published).toEqual(["value-avalue-b"]);
    expect(
      replacement.store.getEffect({ ...approval.effect, operationKind: "capability" })?.status,
    ).toBe("completed");
    expect(replacement.scriptRunStore.get(scriptRun.id)?.status).toBe("completed");
  }, 240_000);

  it("predicate: an approval rule that answers differently after a restart still follows its first answer", async () => {
    const tempDb = createTempDatabase("der-script-predicate-");
    cleanups.push(() => tempDb.cleanup());
    const restateListen = await allocateLocalTcpNumber();
    const host = createNoteHost();
    const applied: string[] = [];
    let evaluations = 0;
    host.catalog.add(
      defineCapability({
        id: "ledger.post",
        description: "Post an entry",
        input: z.object({ text: z.string() }),
        output: z.object({ posted: z.boolean() }),
        effect: "write",
        approval: () => {
          evaluations += 1;
          return evaluations === 1;
        },
        async execute(input) {
          applied.push(input.text);
          return { posted: true };
        },
      }) as unknown as Capability,
    );

    let first: RunningServer | undefined = await startRestateServer(
      tempDb,
      restateListen,
      host,
      true,
    );
    cleanups.push(async () => {
      await first?.close();
    });
    const owner = await admitOwningRun(first, "recovery-predicate");
    const scriptRun = await submitScript(
      first,
      owner,
      `return der.ledger.post({ text: "entry" });`,
    );
    const approval = await awaitPendingApproval(first, owner.run.id);

    const closing = first;
    first = undefined;
    await closing.close();
    const replacement = await startRestateServer(tempDb, restateListen, host, false);
    cleanups.push(() => replacement.close());
    await replacement.coordinator.decide({
      approvalId: approval.id,
      botId: owner.botId,
      sessionId: owner.sessionId,
      runId: owner.run.id,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    const result = await replacement.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(90_000));

    expect(result).toEqual({ ok: true, result: { posted: true }, logs: [], truncated: false });
    expect(applied).toEqual(["entry"]);
  }, 240_000);
});

describe("replay a script against its journal", () => {
  it("deterministic: a script branching on Date.now and Math.random across ten calls completes without a journal mismatch", async () => {
    const tempDb = createTempDatabase("der-script-deterministic-");
    cleanups.push(() => tempDb.cleanup());
    const host = createNoteHost();
    const server = await startRestateServer(tempDb, await allocateLocalTcpNumber(), host, true);
    cleanups.push(() => server.close());
    const owner = await admitOwningRun(server, "deterministic-1");

    const scriptRun = await submitScript(
      server,
      owner,
      `
        const keys = [];
        for (let i = 0; i < 10; i++) {
          const key = (Math.random() < 0.5 ? "lo" : "hi") + "-" + (Date.now() % 1000);
          keys.push((await der.notes.read({ key })).value);
        }
        return keys;
      `,
    );
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(120_000));

    expect(result.ok).toBe(true);
    expect(host.reads).toHaveLength(10);
    expect(result.ok && result.result).toEqual(host.reads.map((key) => `value-${key}`));
  }, 180_000);
});

const PUBLISH = `return der.notes.publish({ text: "release" });`;

function awaitPendingApproval(server: RunningServer, runId: string) {
  return waitUntil(
    async () => {
      const latest = server.store.getLatestApprovalForRun(runId);
      return latest?.decision.status === "pending" ? latest : false;
    },
    { timeoutMs: 60_000, label: "pending approval" },
  );
}

async function startOwned(
  key: string,
  extra: Parameters<typeof startRestateServer>[4] = {},
): Promise<{
  readonly server: RunningServer;
  readonly host: NoteHost;
  readonly owner: Awaited<ReturnType<typeof admitOwningRun>>;
}> {
  const tempDb = createTempDatabase("der-script-restate-");
  const host = createNoteHost();
  const server = await startRestateServer(
    tempDb,
    await allocateLocalTcpNumber(),
    host,
    true,
    extra,
  );
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return { server, host, owner: await admitOwningRun(server, key) };
}

describe("end a parked script run under Restate", () => {
  it("cancel: a script run parked on an approval ends cancelled, expires the approval and records no effect", async () => {
    const { server, host, owner } = await startOwned("restate-cancel");
    const scriptRun = await submitScript(server, owner, PUBLISH);
    const approval = await awaitPendingApproval(server, owner.run.id);

    await server.scriptRuns!.cancel(scriptRun.id);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(60_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "script cancelled" },
      logs: [],
    });
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("expired");
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("cancelled");
    expect(host.published).toEqual([]);
    expect(
      server.store.getEffect({ ...approval.effect, operationKind: "capability" }),
    ).toBeUndefined();
  }, 120_000);

  it("expired: an approval that times out fails the script run with kind expired and records no effect", async () => {
    const { server, host, owner } = await startOwned("restate-expired", {
      approvalTimeoutMs: 2_000,
    });
    const scriptRun = await submitScript(server, owner, PUBLISH);

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(90_000));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "expired",
        message: "Approval for notes.publish expired",
        call: "notes.publish",
      },
      logs: [],
    });
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("failed");
    expect(host.published).toEqual([]);
    const approval = server.store.getLatestApprovalForRun(owner.run.id)!;
    expect(approval.decision.status).toBe("expired");
    expect(
      server.store.getEffect({ ...approval.effect, operationKind: "capability" }),
    ).toBeUndefined();
  }, 120_000);
});

describe("replay a write against the effects ledger under Restate", () => {
  it("unknown: a started write with no recorded outcome interrupts the script run and the run without calling the capability", async () => {
    const { server, host, owner } = await startOwned("restate-unknown");
    const { scriptRun } = await server.scriptRunStore.acquire({
      runId: owner.run.id,
      botId: owner.botId,
      source: `return der.notes.append({ text: "tick" });`,
    });
    const effect = {
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "notes.append",
      canonicalArguments: { text: "tick" },
      attemptId: `${scriptRun.id}:1`,
    } as const;
    await server.store.beginEffect(effect);

    await server.scriptRuns!.submit(scriptRun.id);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(90_000));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "capability",
        message: `Effect capability:notes.append (${effect.attemptId}) had a prior started marker with uncertain outcome.`,
      },
      logs: [],
    });
    expect(host.appended).toEqual([]);
    expect(server.store.getEffect(effect)?.status).toBe("unknown");
    expect(server.store.getRun(owner.run.id)?.status).toBe("interrupted");
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("interrupted");
  }, 120_000);
});

describe("pick a script back up under Restate", () => {
  it("attach: an aborted execute followed by the same script returns one result with one effect", async () => {
    const { server, host, owner } = await startOwned("restate-attach");
    const execute = createExecuteTool({
      run: owner.run,
      scriptRunStore: server.scriptRunStore,
      scriptRuns: server.scriptRuns!,
      maxResultBytes: 65_536,
    });
    const call = (signal: AbortSignal) => execute.execute!({ script: PUBLISH }, { signal });
    const cut = new AbortController();

    const first = call(cut.signal);
    const approval = await awaitPendingApproval(server, owner.run.id);
    cut.abort();
    const aborted = await first;

    expect(aborted).toEqual({
      ok: false,
      error: {
        kind: "cancelled",
        message:
          "execute was aborted before the script finished; call execute with the same script to pick the run back up",
      },
      logs: [],
    });
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("pending");

    await server.coordinator.decide({
      approvalId: approval.id,
      botId: owner.botId,
      sessionId: owner.sessionId,
      runId: owner.run.id,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    const second = await call(AbortSignal.timeout(90_000));

    expect(second).toEqual({ ok: true, result: { published: true }, logs: [], truncated: false });
    expect(host.published).toEqual(["release"]);
    expect(
      server.store.database.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM script_runs WHERE run_id = ?")
        .get(owner.run.id)!.n,
    ).toBe(1);
  }, 150_000);
});

describe("end a run that owns a parked script under Restate", () => {
  it("run end: a run that finishes cancels its parked script run and expires the approval", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedEngine: Engine = {
      kind: "fixture",
      async *run(run: Run): AsyncIterable<EngineEvent> {
        yield {
          type: "chunk",
          chunkKey: `${run.id}:started`,
          chunk: { type: "RUN_STARTED", threadId: run.sessionId, runId: run.id },
        };
        await gate;
        yield { type: "completed" };
      },
    };
    const tempDb = createTempDatabase("der-script-run-end-");
    cleanups.push(() => tempDb.cleanup());
    const host = createNoteHost();
    const server = await startRestateServer(tempDb, await allocateLocalTcpNumber(), host, true, {
      engines: new Map<EngineKind, Engine>([["fixture", gatedEngine]]),
    });
    cleanups.push(() => server.close());
    const botId = server.seededFixture!.bot.id;
    const { run } = await server.coordinator.admit({
      botId,
      sessionId: server.seededFixture!.session.id,
      origin: "http",
      idempotencyKey: "restate-run-end",
      input: { parts: [{ type: "text", text: "owner" }] },
    });
    await waitUntil(async () => server.store.getRun(run.id)?.status === "running", {
      timeoutMs: 30_000,
      label: "run started",
    });
    const { scriptRun } = await server.scriptRunStore.acquire({
      runId: run.id,
      botId,
      source: PUBLISH,
    });
    await server.scriptRuns!.submit(scriptRun.id);
    const approval = await awaitPendingApproval(server, run.id);

    release();
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(90_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "script cancelled" },
      logs: [],
    });
    await waitUntil(async () => server.store.getRun(run.id)?.status === "completed", {
      timeoutMs: 30_000,
      label: "run completed",
    });
    expect(server.scriptRunStore.listUnfinished(run.id)).toEqual([]);
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("expired");
    expect(host.published).toEqual([]);
  }, 150_000);
});

describe("end a script run that hits an unexpected failure under Restate", () => {
  it("predicate throws: the call fails with kind capability and records no effect", async () => {
    const { server, host, owner } = await startOwned("restate-predicate-throws");
    const applied: string[] = [];
    host.catalog.add(
      defineCapability({
        id: "ledger.post",
        description: "Post an entry",
        input: z.object({ text: z.string() }),
        output: z.object({ posted: z.boolean() }),
        effect: "write",
        approval: () => {
          throw new Error("rule broke");
        },
        async execute(input) {
          applied.push(input.text);
          return { posted: true };
        },
      }) as unknown as Capability,
    );
    const scriptRun = await submitScript(
      server,
      owner,
      `return der.ledger.post({ text: "entry" });`,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "capability", message: "rule broke", call: "ledger.post" },
      logs: [],
    });
    expect(applied).toEqual([]);
    expect(server.store.getLatestApprovalForRun(owner.run.id)).toBeUndefined();
  }, 120_000);

  it("bounded: a finish step that keeps failing ends the script run failed instead of retrying forever", async () => {
    const { server, owner } = await startOwned("restate-bounded");
    server.store.database.db.run(
      `CREATE TRIGGER refuse_completed BEFORE UPDATE ON script_runs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    const scriptRun = await submitScript(server, owner, `return 1;`);

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(60_000));

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "capability", message: expect.stringContaining("disk full") },
    });
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("failed");
  }, 120_000);
});
