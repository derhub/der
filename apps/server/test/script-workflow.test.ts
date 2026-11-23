import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod";
import { defineCapability, formatUtcTimestamp, type Capability } from "@der/domain";
import { ScriptRunBusyError } from "@der/storage";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";
import {
  admitOwningRun,
  createNoteHost,
  submitScript,
  type NoteHost,
} from "./fixtures/script-host";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function startDirectServer(
  options: {
    readonly scriptMaxCalls?: number;
    readonly scriptOutputBytes?: number;
    readonly scriptActiveMs?: number;
  } = {},
) {
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
      ...(options.scriptMaxCalls === undefined ? {} : { scriptMaxCalls: options.scriptMaxCalls }),
      ...(options.scriptOutputBytes === undefined
        ? {}
        : { scriptOutputBytes: options.scriptOutputBytes }),
      ...(options.scriptActiveMs === undefined ? {} : { scriptActiveMs: options.scriptActiveMs }),
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
  }, 60_000);
});

describe("run a call whose approval rule fails", () => {
  it("predicate throws: the call fails with kind capability and records no effect", async () => {
    const { server, host } = await startDirectServer();
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
    const owner = await admitOwningRun(server, "predicate-throws");
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
  }, 60_000);
});

function ledgerCapability(applied: string[], delayMs = 0): Capability {
  return defineCapability({
    id: "ledger.post",
    description: "Post an entry",
    input: z.object({ text: z.string() }),
    output: z.object({ posted: z.boolean() }),
    effect: "write",
    approval: "none",
    async execute(input) {
      await Bun.sleep(delayMs);
      applied.push(input.text);
      return { posted: true };
    },
  }) as unknown as Capability;
}

const RETRY_THE_WRITE = `
  const seen = [];
  for (let i = 0; i < 2; i++) {
    try { await der.ledger.post({ text: "entry" }); seen.push("ok"); } catch (e) { seen.push("caught"); }
  }
  return seen;
`;

describe("keep a write at most once when the store fails around it", () => {
  it("store fault: a store that refuses every effect update never lets the script write twice", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const owner = await admitOwningRun(server, "store-fault-refuse-all");
    server.store.database.db.run(
      "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const scriptRun = await submitScript(server, owner, RETRY_THE_WRITE);

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toMatchObject({ ok: false });
    expect(applied).toEqual(["entry"]);
    expect(server.scriptRunStore.get(scriptRun.id)?.status).not.toBe("completed");
  }, 60_000);

  it("store fault: a later run of the same script after an interrupted one does not call the capability again", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const owner = await admitOwningRun(server, "store-fault-rerun");
    server.store.database.db.run(
      "CREATE TRIGGER refuse_completion BEFORE UPDATE ON effects WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const first = await submitScript(server, owner, RETRY_THE_WRITE);
    await server.scriptRuns!.attach(first.id, AbortSignal.timeout(30_000));
    await server.scriptRunStore.markDelivered(first.id);

    const second = await submitScript(server, owner, RETRY_THE_WRITE);
    const result = await server.scriptRuns!.attach(second.id, AbortSignal.timeout(30_000));

    expect(second.id).not.toBe(first.id);
    expect(result).toMatchObject({ ok: false });
    expect(applied).toEqual(["entry"]);
  }, 60_000);
});

describe("end a script on a host failure instead of telling the script", () => {
  it("not catchable: a host step that fails inside a call ends the script before its catch block calls again", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const owner = await admitOwningRun(server, "not-catchable");
    server.store.database.db.run(
      "CREATE TRIGGER refuse_running BEFORE UPDATE ON script_runs WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const scriptRun = await submitScript(
      server,
      owner,
      `try { await der.ledger.post({ text: "entry" }); } catch (e) { await der.notes.read({ key: "after-catch" }); } return 1;`,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toMatchObject({ ok: false });
    expect(host.reads).toEqual([]);
    expect(applied).toEqual([]);
  }, 60_000);
});

describe("refuse to start a script run while a write in the run is in doubt", () => {
  it("in doubt: a second script run after a store fault interrupts the run and calls no capability", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const owner = await admitOwningRun(server, "in-doubt-direct");
    const source = `await der.ledger.post({ text: "entry" }); return 1;`;
    server.store.database.db.run(
      "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const first = await submitScript(server, owner, source);
    await server.scriptRuns!.attach(first.id, AbortSignal.timeout(30_000));
    server.store.database.db.run("DROP TRIGGER refuse_updates");
    await server.scriptRunStore.markDelivered(first.id);

    const second = await submitScript(server, owner, source);
    const result = await server.scriptRuns!.attach(second.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "capability",
        message: `The outcome of a previous write in this Run (capability:ledger.post, ${first.id}:1) is unknown, so the Run was interrupted.`,
      },
      logs: [],
    });
    expect(applied).toEqual(["entry"]);
    expect(server.scriptRunStore.get(second.id)?.status).toBe("interrupted");
    expect(server.store.getRun(owner.run.id)?.status).toBe("interrupted");
    expect(
      server.store
        .readRunEventsAfter(owner.run.id, 0)
        .map((event) => event.chunk as { type: string; code?: string })
        .some((chunk) => chunk.type === "RUN_ERROR" && chunk.code === "effect.outcome_uncertain"),
    ).toBe(true);
  }, 60_000);

  it("in doubt: a finished run accepts no further script run and calls no capability", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const owner = await admitOwningRun(server, "in-doubt-finished");
    const doubtful = await server.store.beginEffect({
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "ledger.post",
      canonicalArguments: { text: "entry" },
      attemptId: "seed:1",
    });
    await server.store.markEffectUnknown(doubtful.effect.id);
    const first = await submitScript(server, owner, `return 1;`);
    await server.scriptRuns!.attach(first.id, AbortSignal.timeout(30_000));
    await server.scriptRunStore.markDelivered(first.id);

    const later = await submitScript(
      server,
      owner,
      `await der.ledger.post({ text: "again" }); return 2;`,
    );
    const result = await server.scriptRuns!.attach(later.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "capability",
        message: `owning Run ${owner.run.id} has ended as interrupted`,
      },
      logs: [],
    });
    expect(applied).toEqual([]);
  }, 60_000);
});

describe("run one script at a time in a run", () => {
  it("one at a time: a different script sent while another is running is refused and calls no capability", async () => {
    const { server, host } = await startDirectServer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const applied: string[] = [];
    host.catalog.add(
      defineCapability({
        id: "ledger.post",
        description: "Post an entry",
        input: z.object({ text: z.string() }),
        output: z.object({ posted: z.boolean() }),
        effect: "write",
        approval: "none",
        async execute(input) {
          started.push(input.text);
          await gate;
          applied.push(input.text);
          return { posted: true };
        },
      }) as unknown as Capability,
    );
    const owner = await admitOwningRun(server, "one-at-a-time");
    const writing = await submitScript(
      server,
      owner,
      `return await der.ledger.post({ text: "entry" });`,
    );
    await waitUntil(async () => started.length === 1, {
      timeoutMs: 10_000,
      label: "write started",
    });

    const refused = await submitScript(
      server,
      owner,
      `return await der.ledger.post({ text: "entry" });\n// different`,
    ).catch((error: unknown) => error);
    release();
    const writeResult = await server.scriptRuns!.attach(writing.id, AbortSignal.timeout(30_000));

    expect(refused).toBeInstanceOf(ScriptRunBusyError);
    expect(writeResult).toEqual({ ok: true, result: { posted: true }, logs: [], truncated: false });
    expect(applied).toEqual(["entry"]);
  }, 60_000);
});

describe("settle a script run only after every call it issued", () => {
  it("without await: a write issued and not awaited is recorded completed before the result is reported", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied, 300));
    const owner = await admitOwningRun(server, "without-await-ok");
    const scriptRun = await submitScript(
      server,
      owner,
      `der.ledger.post({ text: "entry" }); return 1;`,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({ ok: true, result: 1, logs: [], truncated: false });
    expect(applied).toEqual(["entry"]);
    expect(
      server.store.getEffect({
        runId: owner.run.id,
        operationKind: "capability",
        operationId: "ledger.post",
        canonicalArguments: { text: "entry" },
        attemptId: `${scriptRun.id}:1`,
      })?.status,
    ).toBe("completed");
  }, 60_000);

  it("without await: a write that cannot be recorded after the script returned ends the script run interrupted", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied, 300));
    const owner = await admitOwningRun(server, "without-await-fault");
    server.store.database.db.run(
      "CREATE TRIGGER refuse_completion BEFORE UPDATE ON effects WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const scriptRun = await submitScript(
      server,
      owner,
      `der.ledger.post({ text: "entry" }); return 1;`,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toMatchObject({ ok: false, error: { kind: "capability" } });
    expect(applied).toEqual(["entry"]);
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("interrupted");
    expect(server.store.getRun(owner.run.id)?.status).toBe("interrupted");
  }, 60_000);

  it("without await: an unawaited write parked on an approval holds the script run until it is decided", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "without-await-approval");
    const scriptRun = await submitScript(
      server,
      owner,
      `der.notes.publish({ text: "release" }); return 1;`,
    );
    const approval = await awaitPendingApproval(server, owner.run.id);
    const attaching = server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));
    await Bun.sleep(300);

    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("waiting_approval");
    await server.coordinator.decide(decision(approval, owner, "approved"));

    expect(await attaching).toEqual({ ok: true, result: 1, logs: [], truncated: false });
    expect(host.published).toEqual(["release"]);
  }, 60_000);

  it("without await: cancelling a script run whose unawaited write waits on an approval ends it cancelled", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "without-await-cancel");
    const scriptRun = await submitScript(
      server,
      owner,
      `der.notes.publish({ text: "release" }); return 1;`,
    );
    await awaitPendingApproval(server, owner.run.id);

    await server.scriptRuns!.cancel(scriptRun.id);
    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "script cancelled" },
      logs: [],
    });
    expect(host.published).toEqual([]);
  }, 60_000);
});

describe("report a result the store cannot hold", () => {
  it("deep: a result nested 7000 levels ends as a script error naming an unstorable result", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "deep-result");
    const scriptRun = await submitScript(
      server,
      owner,
      `let nested = []; for (let i = 0; i < 7000; i++) nested = [nested]; return nested;`,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "script", message: "script produced a result the host cannot store" },
      logs: [],
    });
  }, 60_000);
});

function gateCapability(): {
  readonly capability: Capability;
  readonly reached: Promise<void>;
  readonly release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const capability = defineCapability({
    id: "gate.wait",
    description: "Wait for the test",
    input: z.object({}),
    output: z.object({ open: z.boolean() }),
    effect: "read",
    approval: "none",
    async execute() {
      markReached();
      await gate;
      return { open: true };
    },
  }) as unknown as Capability;
  return { capability, reached, release };
}

const WAIT_THEN_WRITE = `await der.gate.wait({}); await der.ledger.post({ text: "entry" }); return 1;`;

describe("refuse a write when the run changed under a running script", () => {
  it("refuses: a write reached while the run has a write in doubt calls no capability and begins no effect", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const gate = gateCapability();
    host.catalog.add(gate.capability);
    const owner = await admitOwningRun(server, "refuses-doubt");
    const scriptRun = await submitScript(server, owner, WAIT_THEN_WRITE);
    await gate.reached;
    const seeded = await server.store.beginEffect({
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "ledger.post",
      canonicalArguments: { text: "seeded" },
      attemptId: "seed:1",
    });
    await server.store.markEffectUnknown(seeded.effect.id);
    gate.release();

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "capability",
        message:
          "The outcome of a previous write in this Run (capability:ledger.post, seed:1) is unknown, so the Run was interrupted.",
      },
      logs: [],
    });
    expect(applied).toEqual([]);
    expect(server.store.database.db.query("SELECT attempt_id FROM effects").all()).toEqual([
      { attempt_id: "seed:1" },
    ]);
    expect(server.store.getRun(owner.run.id)?.status).toBe("interrupted");
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("interrupted");
  }, 60_000);

  it("refuses: a write reached after the run ended calls no capability and begins no effect", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(ledgerCapability(applied));
    const gate = gateCapability();
    host.catalog.add(gate.capability);
    const owner = await admitOwningRun(server, "refuses-ended");
    const scriptRun = await submitScript(server, owner, WAIT_THEN_WRITE);
    await gate.reached;
    await server.store.finishRun({
      runId: owner.run.id,
      status: "cancelled",
      terminalEvent: {
        chunkKey: `${owner.run.id}:terminal`,
        chunk: {
          type: "RUN_ERROR",
          message: "stopped",
          code: "run.cancelled",
          runId: owner.run.id,
          threadId: owner.sessionId,
        },
      },
    });
    gate.release();

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toEqual({
      ok: false,
      error: { kind: "capability", message: `owning Run ${owner.run.id} has ended as cancelled` },
      logs: [],
    });
    expect(applied).toEqual([]);
    expect(server.store.database.db.query("SELECT attempt_id FROM effects").all()).toEqual([]);
  }, 60_000);
});

describe("let a write finish before the script run settles", () => {
  it("outlives: a write in flight when the script hits its time limit is recorded before the script run ends", async () => {
    const { server, host } = await startDirectServer({ scriptActiveMs: 400 });
    const applied: string[] = [];
    host.catalog.add(
      defineCapability({
        id: "ledger.post",
        description: "Post an entry",
        input: z.object({ text: z.string() }),
        output: z.object({ posted: z.boolean() }),
        effect: "write",
        approval: "none",
        async execute(input) {
          await Bun.sleep(500);
          applied.push(input.text);
          throw new Error("socket reset after send");
        },
      }) as unknown as Capability,
    );
    const owner = await admitOwningRun(server, "outlives-limit");
    const scriptRun = await submitScript(
      server,
      owner,
      `der.ledger.post({ text: "entry" }); for (;;) {}`,
    );

    const result = await server.scriptRuns!.attach(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result).toMatchObject({ ok: false, error: { kind: "capability" } });
    expect(applied).toEqual(["entry"]);
    expect(
      server.store.getEffect({
        runId: owner.run.id,
        operationKind: "capability",
        operationId: "ledger.post",
        canonicalArguments: { text: "entry" },
        attemptId: `${scriptRun.id}:1`,
      })?.status,
    ).toBe("unknown");
    expect(server.scriptRunStore.get(scriptRun.id)?.status).toBe("interrupted");
    expect(server.store.getRun(owner.run.id)?.status).toBe("interrupted");
  }, 60_000);
});

describe("cancel a script run whose write is in flight", () => {
  it("cancel: the script run is not terminal until its write is recorded, and a later script is not refused", async () => {
    const { server, host } = await startDirectServer();
    const applied: string[] = [];
    host.catalog.add(
      defineCapability({
        id: "ledger.post",
        description: "Post an entry",
        input: z.object({ text: z.string() }),
        output: z.object({ posted: z.boolean() }),
        effect: "write",
        approval: "none",
        async execute(input) {
          await Bun.sleep(800);
          applied.push(input.text);
          return { posted: true };
        },
      }) as unknown as Capability,
    );
    const owner = await admitOwningRun(server, "cancel-in-flight");
    const writing = await submitScript(
      server,
      owner,
      `return await der.ledger.post({ text: "entry" });`,
    );
    await waitUntil(
      async () =>
        server.scriptRunStore.get(writing.id)?.status === "running" &&
        server.store.database.db.query("SELECT 1 FROM effects").all().length === 1,
      { timeoutMs: 10_000, label: "write started" },
    );

    await server.scriptRuns!.cancel(writing.id);

    const effect = server.store.getEffect({
      runId: owner.run.id,
      operationKind: "capability",
      operationId: "ledger.post",
      canonicalArguments: { text: "entry" },
      attemptId: `${writing.id}:1`,
    });
    expect(effect?.status).toBe("completed");
    expect(server.scriptRunStore.get(writing.id)?.status).toBe("cancelled");
    await server.scriptRunStore.markDelivered(writing.id);
    const later = await submitScript(server, owner, `return 2;`);
    expect(await server.scriptRuns!.attach(later.id, AbortSignal.timeout(30_000))).toEqual({
      ok: true,
      result: 2,
      logs: [],
      truncated: false,
    });
  }, 60_000);

  it("cancel: a write that never returns is abandoned after the grace and the script run ends cancelled", async () => {
    const { server, host } = await startDirectServer();
    host.catalog.add(
      defineCapability({
        id: "ledger.post",
        description: "Post an entry",
        input: z.object({ text: z.string() }),
        output: z.object({ posted: z.boolean() }),
        effect: "write",
        approval: "none",
        execute: () => new Promise<{ posted: boolean }>(() => {}),
      }) as unknown as Capability,
    );
    const owner = await admitOwningRun(server, "cancel-never-returns");
    const writing = await submitScript(
      server,
      owner,
      `return await der.ledger.post({ text: "entry" });`,
    );
    await waitUntil(
      async () => server.store.database.db.query("SELECT 1 FROM effects").all().length === 1,
      { timeoutMs: 10_000, label: "write started" },
    );

    await server.scriptRuns!.cancel(writing.id);

    expect(server.scriptRunStore.get(writing.id)?.status).toBe("cancelled");
  }, 60_000);
});
