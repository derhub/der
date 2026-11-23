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
      approvalTimeoutMs: 120_000,
      seedFixture,
    },
    catalog: host.catalog,
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
