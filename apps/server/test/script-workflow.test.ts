import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { formatUtcTimestamp } from "@der/domain";
import { startServer, type RunningServer } from "../src/main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";
import {
  admitOwningRun,
  createNoteHost,
  ensureScriptGuest,
  submitScript,
  type NoteHost,
} from "./fixtures/script-host";

const cleanups: (() => Promise<void> | void)[] = [];
let guestArtifactPath = "";

beforeAll(async () => {
  guestArtifactPath = await ensureScriptGuest();
}, 120_000);

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

afterAll(() => {
  const children = Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", "script-child"]);
  expect(children.stdout.toString().trim()).toBe("");
});

async function startDirectServer(options: { readonly scriptMaxCalls?: number } = {}) {
  const tempDb = createTempDatabase("der-script-");
  const host: NoteHost = createNoteHost();
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
      seedFixture: true,
      scriptGuestArtifactPath: guestArtifactPath,
      ...(options.scriptMaxCalls === undefined ? {} : { scriptMaxCalls: options.scriptMaxCalls }),
    },
    catalog: host.catalog,
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return { server, host };
}

async function awaitPendingApproval(server: RunningServer, runId: string) {
  return waitUntil(
    async () => {
      const approval = server.store.getLatestApprovalForRun(runId);
      return approval?.decision.status === "pending" ? approval : false;
    },
    { timeoutMs: 20_000, label: "pending approval" },
  );
}

function decision(
  approval: { readonly id: string },
  owner: {
    readonly run: { readonly id: string };
    readonly botId: string;
    readonly sessionId: string;
  },
  status: "approved" | "denied",
) {
  return {
    approvalId: approval.id,
    botId: owner.botId,
    sessionId: owner.sessionId,
    runId: owner.run.id,
    status,
    actor: "operator",
    decidedAt: formatUtcTimestamp(new Date()),
  } as const;
}

describe("run a script over journaled capability calls", () => {
  it("executes three reads and one ungated write once and records a single effects row for the write", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "calls-1");
    const source = `
      const a = await der.notes.read({ key: "a" });
      const b = await der.notes.read({ key: "b" });
      const c = await der.notes.read({ key: "c" });
      const written = await der.notes.append({ text: a.value + b.value + c.value });
      return { written, first: a.value };
    `;

    const scriptRun = await submitScript(server, owner, source);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: true,
      result: { written: { count: 1 }, first: "value-a" },
      logs: [],
      truncated: false,
    });
    expect(host.reads).toEqual(["a", "b", "c"]);
    expect(host.appended).toEqual(["value-avalue-bvalue-c"]);
    const writeEffect = server.store.getEffect({
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "notes.append",
      canonicalArguments: { text: "value-avalue-bvalue-c" },
      attemptId: `${scriptRun.id}:4`,
    });
    expect(writeEffect?.status).toBe("completed");
    expect(writeEffect?.outcome).toEqual({ ok: true, value: { count: 1 } });
    const readEffect = server.store.getEffect({
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "notes.read",
      canonicalArguments: { key: "a" },
      attemptId: `${scriptRun.id}:1`,
    });
    expect(readEffect).toBeUndefined();
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("completed");
  }, 60_000);

  it("runs the calls once when the same script run is submitted twice", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "calls-2");

    const first = await submitScript(server, owner, `return der.notes.read({ key: "x" });`);
    const second = await submitScript(server, owner, `return der.notes.read({ key: "x" });`);
    const result = await server.scriptRuns!.attach(first.id, AbortSignal.timeout(30_000));

    expect(second.id).toBe(first.id);
    expect(result).toEqual({ ok: true, result: { value: "value-x" }, logs: [], truncated: false });
    expect(host.reads).toEqual(["x"]);
  }, 60_000);
});

describe("ask for approval inside a script", () => {
  it("parks on one pending approval and completes with one effect after it is approved", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "approval-1");
    const scriptRun = await submitScript(
      server,
      owner,
      `return der.notes.publish({ text: "release" });`,
    );

    const approval = await awaitPendingApproval(server, owner.run.id);

    expect(approval.effect).toEqual({
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "notes.publish",
      canonicalArguments: { text: "release" },
      attemptId: `${scriptRun.id}:1`,
    });
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("waiting_approval");
    expect(server.store.getRun(owner.run.id)?.status).toBe("waiting_approval");
    expect(host.published).toEqual([]);

    await server.coordinator.decide(decision(approval, owner, "approved"));
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: true,
      result: { published: true },
      logs: [],
      truncated: false,
    });
    expect(host.published).toEqual(["release"]);
    const effect = server.store.getEffect({ ...approval.effect, operationKind: "capability" });
    expect(effect?.status).toBe("completed");
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("completed");
    expect(server.store.getRun(owner.run.id)?.status).toBe("running");
  }, 60_000);

  it("fails with kind denied, records no effect and returns the owning run to running when the approval is denied", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "approval-2");
    const scriptRun = await submitScript(
      server,
      owner,
      `
        try { await der.notes.publish({ text: "release" }); } catch (error) { console.log("caught"); }
        return "carried on";
      `,
    );
    const approval = await awaitPendingApproval(server, owner.run.id);

    await server.coordinator.decide(decision(approval, owner, "denied"));
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "denied",
        message: "Approval for notes.publish was denied",
        call: "notes.publish",
      },
      logs: ["caught"],
    });
    expect(host.published).toEqual([]);
    expect(
      server.store.getEffect({ ...approval.effect, operationKind: "capability" }),
    ).toBeUndefined();
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("failed");
    expect(server.store.getRun(owner.run.id)?.status).toBe("running");
  }, 60_000);
});

describe("replay a write against the effects ledger", () => {
  async function seededScript(server: RunningServer, key: string) {
    const owner = await admitOwningRun(server, key);
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
    const begun = await server.store.beginEffect(effect);
    return { owner, scriptRun, effect, effectId: begun.effect.id };
  }

  it("returns the recorded outcome of a completed write without calling the capability again", async () => {
    const { server, host } = await startDirectServer();
    const { scriptRun, effectId } = await seededScript(server, "ledger-1");
    await server.store.completeEffect(effectId, { ok: true, value: { count: 41 } });

    await server.scriptRuns!.submit(scriptRun.id);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({ ok: true, result: { count: 41 }, logs: [], truncated: false });
    expect(host.appended).toEqual([]);
  }, 60_000);

  it("interrupts the run without calling the capability again when a started write has no recorded outcome", async () => {
    const { server, host } = await startDirectServer();
    const { owner, scriptRun, effect } = await seededScript(server, "ledger-2");

    await server.scriptRuns!.submit(scriptRun.id);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

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
  }, 60_000);
});

describe("stop a script", () => {
  it("fails with kind limit when the script exceeds the call cap", async () => {
    const { server, host } = await startDirectServer({ scriptMaxCalls: 3 });
    const owner = await admitOwningRun(server, "limit-1");
    const scriptRun = await submitScript(
      server,
      owner,
      `
        const keys = ["a", "b", "c", "d", "e"];
        const values = [];
        for (const key of keys) values.push((await der.notes.read({ key })).value);
        return values;
      `,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "limit", message: "call limit of 3 exceeded" },
      logs: [],
    });
    expect(host.reads).toEqual(["a", "b", "c"]);
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("failed");
  }, 60_000);

  it("ends cancelled, expires the pending approval and leaves no child process when cancelled during an approval", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "cancel-1");
    const scriptRun = await submitScript(
      server,
      owner,
      `return der.notes.publish({ text: "release" });`,
    );
    const approval = await awaitPendingApproval(server, owner.run.id);

    await server.scriptRuns!.cancel(scriptRun.id);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "script cancelled" },
      logs: [],
    });
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("expired");
    expect(host.published).toEqual([]);
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("cancelled");
    const children = Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", "script-child"]);
    expect(children.stdout.toString().trim()).toBe("");
  }, 60_000);
});
