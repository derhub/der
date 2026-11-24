import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod";
import { defineCapability, type Engine, type FinishRunInput } from "@der/domain";
import type { SqliteStore } from "@der/storage";
import { executeEngineStage, finalizeDirectRunStep } from "#workflows/index";
import { openScriptFixture } from "./fixtures/script-host";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type OpenDriver = Awaited<ReturnType<typeof openScriptFixture>>["openDriver"];

async function setup(limits?: Parameters<OpenDriver>[1], options?: Parameters<OpenDriver>[2]) {
  const fixture = await openScriptFixture();
  const execution = fixture.openDriver(fixture.store, limits, options);
  cleanups.push(async () => {
    await execution.driver.close();
    fixture.store.close();
    fixture.database.cleanup();
  });
  return { ...fixture, ...execution };
}

const PUBLISH = `return await step.run("notes.publish", { text: "release" });`;

describe("drive a registered step", () => {
  it("refuses a refinement-invalid input before storing any step from the same drain", async () => {
    const { store, run, host, acquire, driver, scripts } = await setup();
    const invoked: string[] = [];
    host.catalog.add(
      defineCapability({
        id: "notes.refined",
        description: "Accept nonreserved text.",
        input: z.object({ text: z.string().refine((text) => text !== "reserved") }),
        output: z.string(),
        effect: "write",
        approval: "none",
        execute: async ({ text }) => {
          invoked.push(text);
          return text;
        },
      }),
    );
    const { id } = acquire(`
      await step.all([
        step.run("notes.append", { text: "valid" }),
        step.run("notes.refined", { text: "reserved" }),
      ]);
    `);
    await driver.kick(id);
    expect(scripts.load(id)).toMatchObject({
      execution: {
        status: "failed",
        result: {
          ok: false,
          error: {
            kind: "capability",
            message: expect.stringContaining('Invalid input for capability "notes.refined"'),
          },
        },
      },
      steps: [],
    });
    expect(invoked).toEqual([]);
    expect(host.appended).toEqual([]);
    expect(store.listPendingApprovalsForRun(run.id)).toEqual([]);
  });

  it("starts six 50 ms reads concurrently", async () => {
    const { host, acquire, driver, scripts } = await setup();
    let started = 0;
    const allStarted = Promise.withResolvers<void>();
    host.catalog.add(
      defineCapability({
        id: "notes.concurrent",
        description: "Read a note from the external store.",
        input: z.number(),
        output: z.number(),
        effect: "read",
        approval: "none",
        async execute(value) {
          if (++started === 6) allStarted.resolve();
          await Bun.sleep(50);
          return value * 2;
        },
      }),
    );
    const { id } = acquire(
      `return await step.all([1,2,3,4,5,6].map(n => step.run("notes.concurrent", n)));`,
    );
    const start = performance.now();
    const driving = driver.kick(id);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        allStarted.promise,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error("the six reads did not overlap")), 500);
        }),
      ]);
    } finally {
      clearTimeout(watchdog);
    }
    await driving;
    expect(performance.now() - start).toBeLessThan(150);
    expect(scripts.load(id).execution.result).toEqual({
      ok: true,
      result: [2, 4, 6, 8, 10, 12],
      logs: [],
      truncated: false,
    });
  });

  it("lists already applied writes when the next drain exceeds the step limit", async () => {
    const { host, acquire, driver, scripts } = await setup({ maxSteps: 1 });
    const { id } = acquire(`
      await step.run("notes.append", { text: "applied" });
      await step.run("notes.append", { text: "refused" });
    `);
    await driver.kick(id);
    expect(scripts.load(id).execution.result).toMatchObject({
      ok: false,
      error: {
        kind: "limit",
        message: "step limit of 1 exceeded. Already applied: #1 notes.append.",
      },
    });
    expect(scripts.load(id).steps.map(({ status }) => status)).toEqual(["done"]);
    expect(host.appended).toEqual(["applied"]);
  });

  it("preserves syntax error line numbers", async () => {
    const { acquire, driver, scripts } = await setup();
    const { id } = acquire("const valid = 1;\nconst invalid = ;");
    await driver.kick(id);
    expect(scripts.load(id).execution.result).toMatchObject({
      ok: false,
      error: {
        kind: "script",
        line: 2,
        message: expect.stringContaining("SyntaxError"),
      },
    });
  });
});

describe("decide Script Approvals", () => {
  it.each([
    { catchDenial: true, status: "completed" },
    { catchDenial: false, status: "failed" },
  ])(
    "settles independent writes when one Approval is denied and the Script ends $status",
    async ({ catchDenial, status }) => {
      const { host, store, run, acquire, driver, scripts, decide } = await setup();
      const { id } = acquire(`
      const group = step.all(["a","b","c"].map(text => step.run("notes.publish", { text })));
      ${
        catchDenial
          ? "try { return await group; } catch (error) { return { kind: error.kind, step: error.step, input: error.input }; }"
          : "return await group;"
      }
    `);
      await driver.kick(id);
      const pending = store.listPendingApprovalsForRun(run.id);
      expect(pending.map(({ effect }) => effect.canonicalArguments)).toEqual([
        { text: "a" },
        { text: "b" },
        { text: "c" },
      ]);
      expect(scripts.load(id).steps.map(({ round }) => round)).toEqual([1, 1, 1]);
      expect(host.published).toEqual([]);
      await driver.kick(id);
      expect(
        store.listPendingApprovalsForRun(run.id).map(({ id: approvalId }) => approvalId),
      ).toEqual(pending.map(({ id: approvalId }) => approvalId));

      await driver.decide(decide(pending[1]!, "denied"));
      await driver.decide(decide(pending[0]!, "approved"));
      await driver.decide(decide(pending[2]!, "approved"));
      const result = await driver.wait(id, AbortSignal.timeout(3000));

      expect(scripts.load(id).execution.status).toBe(status);
      expect(result).toEqual(
        catchDenial
          ? {
              ok: true,
              result: { kind: "denied", step: 2, input: { text: "b" } },
              truncated: false,
              logs: [],
            }
          : {
              ok: false,
              error: {
                kind: "denied",
                call: "notes.publish",
                message: "approval for write 2 (notes.publish) was denied",
              },
              logs: [],
            },
      );
      expect(host.published).toEqual(["a", "c"]);
      expect(store.listPendingApprovalsForRun(run.id)).toEqual([]);
    },
  );

  it("fails for an unobserved rejection after applying its independent write", async () => {
    const { host, store, run, acquire, driver, decide } = await setup();
    const { id } = acquire(`
      step.run("notes.publish", { text: "denied" });
      step.run("notes.append", { text: "applied" });
      return 42;
    `);
    await driver.kick(id);
    const [approval] = store.listPendingApprovalsForRun(run.id);
    await driver.decide(decide(approval!, "denied"));
    expect(await driver.wait(id, AbortSignal.timeout(3000))).toMatchObject({
      ok: false,
      error: { kind: "denied", message: expect.stringContaining("never awaited") },
    });
    expect(host.appended).toEqual(["applied"]);
    expect(host.published).toEqual([]);
  });

  it("expires an overdue Approval in the sweep", async () => {
    const { host, store, run, acquire, driver, advance } = await setup();
    const { id } = acquire(PUBLISH);
    await driver.kick(id);
    const [approval] = store.listPendingApprovalsForRun(run.id);
    advance(5001);
    await driver.sweep();
    expect(await driver.wait(id, AbortSignal.timeout(3000))).toMatchObject({
      ok: false,
      error: { kind: "expired", call: "notes.publish" },
    });
    expect(store.getApproval(approval!.id)?.decision.status).toBe("expired");
    expect(store.listPendingApprovalsForRun(run.id)).toEqual([]);
    expect(host.published).toEqual([]);
  });

  it("withdraws pending Approval and skips the write after the owning Run ends", async () => {
    const { host, store, run, acquire, driver, scripts } = await setup();
    const { id } = acquire(PUBLISH);
    await driver.kick(id);
    await store.finishRun({
      runId: run.id,
      status: "cancelled",
      terminalEvent: {
        chunkKey: "cancelled",
        chunk: { type: "RUN_ERROR", message: "cancelled", code: "run.cancelled" },
      },
    });
    await driver.cancelRun(run.id);

    expect(scripts.load(id)).toMatchObject({
      execution: { status: "cancelled", result: { ok: false, error: { kind: "cancelled" } } },
      steps: [{ status: "skipped" }],
    });
    expect(store.listPendingApprovalsForRun(run.id)).toEqual([]);
    expect(host.published).toEqual([]);
  });
});

describe("preserve effect safety when the host cannot continue", () => {
  it("records failure when SQLite refuses the successful terminal row", async () => {
    const { store, acquire, driver, scripts } = await setup();
    store.database.db.run(
      `CREATE TRIGGER refuse_completed BEFORE UPDATE ON script_runs
       WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'disk full'); END`,
    );
    const { id } = acquire("return 1;");
    await driver.kick(id);
    expect(scripts.load(id).execution).toMatchObject({
      status: "failed",
      result: {
        ok: false,
        error: { kind: "capability", message: "Could not finish Script: disk full" },
      },
    });
  });

  it("ends a Script when the ledger refuses to begin a write without reaching its catch or next write", async () => {
    const { store, host, acquire, driver, scripts } = await setup();
    store.database.db.run(
      "CREATE TRIGGER refuse_insert BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const { id } = acquire(`
      try { await step.run("notes.append", { text: "first" }); }
      catch { await step.run("notes.append", { text: "from catch" }); }
    `);
    await driver.kick(id);
    expect(scripts.load(id)).toMatchObject({
      execution: {
        status: "failed",
        result: { ok: false, error: { message: "Could not begin write 1: disk full" } },
      },
      steps: [{ position: 1, status: "skipped" }],
    });
    expect(host.appended).toEqual([]);
  });

  it.each([
    { observe: true, statement: 'await step.run("notes.append", { text: "entry" });' },
    { observe: false, statement: 'step.run("notes.append", { text: "entry" });' },
  ])(
    "records an ambiguous effect after ledger I/O recovers, observed=$observe",
    async ({ statement }) => {
      const { store, host, run, acquire, driver, scripts } = await setup();
      store.database.db.run(
        "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      );
      const { id } = acquire(`${statement} return 1;`);
      expect(await driver.kick(id).catch((error: unknown) => error)).toMatchObject({
        message: "disk full",
      });
      expect(host.appended).toEqual(["entry"]);
      expect(scripts.load(id).execution.status).toBe("running");

      store.database.db.run("DROP TRIGGER refuse_updates");
      await driver.kick(id);

      expect(scripts.load(id)).toMatchObject({
        execution: { status: "in_doubt" },
        steps: [{ position: 1, status: "unknown", seq: null }],
      });
      expect(store.findWriteInDoubt(run.id)?.status).toBe("unknown");
      expect(host.appended).toEqual(["entry"]);
    },
  );

  it("refuses a result whose depth exceeds the stored result limit", async () => {
    const { acquire, driver, scripts } = await setup();
    const { id } = acquire(
      "let result = {}; for (let i = 0; i < 700; i++) result = { result }; return result;",
    );
    await driver.kick(id);
    expect(scripts.load(id).execution.result).toEqual({
      ok: false,
      error: { kind: "script", message: "script produced a result the host cannot store" },
      logs: [],
    });
  });

  it("ends a cancelled execution in doubt after the grace period while its write never returns", async () => {
    const { store, run, host, acquire, driver, scripts } = await setup(undefined, {
      writeCancelGraceMs: 100,
    });
    const started = Promise.withResolvers<void>();
    host.catalog.add(
      defineCapability({
        id: "notes.stuck",
        description: "Write to a service that never answers.",
        input: z.object({}),
        output: z.literal(true),
        effect: "write",
        approval: "none",
        execute() {
          started.resolve();
          return new Promise<true>(() => {});
        },
      }),
    );
    const { id } = acquire('await step.run("notes.stuck", {});');
    const driving = driver.kick(id);
    await started.promise;
    await store.finishRun({
      runId: run.id,
      status: "cancelled",
      terminalEvent: {
        chunkKey: "cancelled",
        chunk: { type: "RUN_ERROR", message: "cancelled", code: "run.cancelled" },
      },
    });

    await Promise.all([driving, driver.cancelRun(run.id)]);

    expect(scripts.load(id).execution).toMatchObject({
      status: "in_doubt",
      result: {
        ok: false,
        error: {
          kind: "cancelled",
          message:
            "script cancelled. Already applied: none confirmed. Unknown outcome: #1 notes.stuck.",
        },
      },
    });
  }, 3_000);

  it("records a write already in flight before cancelling the execution", async () => {
    const { store, run, host, acquire, driver, scripts } = await setup();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    host.catalog.add(
      defineCapability({
        id: "notes.inflight",
        description: "Write after the external service acknowledges.",
        input: z.object({}),
        output: z.literal(true),
        effect: "write",
        approval: "none",
        async execute() {
          started.resolve();
          await release.promise;
          return true as const;
        },
      }),
    );
    const { id } = acquire(`
      await step.run("notes.inflight", {});
      await step.run("notes.append", { text: "too late" });
    `);
    const driving = driver.kick(id);
    await started.promise;
    await store.finishRun({
      runId: run.id,
      status: "cancelled",
      terminalEvent: {
        chunkKey: "cancelled",
        chunk: { type: "RUN_ERROR", message: "cancelled", code: "run.cancelled" },
      },
    });
    const cancelling = driver.cancelRun(run.id);
    expect(scripts.load(id).execution.status).toBe("running");
    release.resolve();
    await Promise.all([driving, cancelling]);

    expect(scripts.load(id)).toMatchObject({
      execution: { status: "cancelled" },
      steps: [{ position: 1, status: "done", seq: null }],
    });
    expect(host.appended).toEqual([]);
  });
});

describe("end a detached Script in doubt", () => {
  async function inDoubtDetached(endRunFirst: boolean) {
    const context = await setup();
    const { store, run, acquire, driver, scripts } = context;
    const { id } = acquire('await step.run("notes.append", { text: "entry" }); return 1;');
    scripts.detach(id);
    store.database.db.run(
      "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await driver.kick(id).catch(() => undefined);
    if (endRunFirst) {
      await store.finishRun({
        runId: run.id,
        status: "completed",
        terminalEvent: { chunkKey: `${run.id}:terminal`, chunk: { type: "RUN_FINISHED" } },
      });
    }
    store.database.db.run("DROP TRIGGER refuse_updates");
    await driver.kick(id);
    const events = store.database.db
      .query<{ kind: string }, []>("SELECT kind FROM session_events")
      .all();
    return {
      execution: scripts.load(id).execution.status,
      run: store.getRun(run.id)?.status,
      events: events.map(({ kind }) => kind),
    };
  }

  it("interrupts the owning Run that is still active", async () => {
    expect(await inDoubtDetached(false)).toEqual({
      execution: "in_doubt",
      run: "interrupted",
      events: ["script.finished"],
    });
  });

  it("names the write of unknown outcome last in the result message", async () => {
    const context = await setup();
    const { store, acquire, driver, scripts } = context;
    const { id } = acquire('await step.run("notes.append", { text: "entry" }); return 1;');
    store.database.db.run(
      "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await driver.kick(id).catch(() => undefined);
    store.database.db.run("DROP TRIGGER refuse_updates");
    await driver.kick(id);

    expect(scripts.load(id).execution.result).toEqual({
      ok: false,
      error: {
        kind: "capability",
        message:
          "Write 1 (notes.append) has an unknown outcome: a previous attempt started this write and its outcome was not recorded. Already applied: none confirmed. Unknown outcome: #1 notes.append.",
      },
      logs: [],
    });
  });

  it("leaves an owning Run that already ended as it ended and carries the outcome in one event", async () => {
    expect(await inDoubtDetached(true)).toEqual({
      execution: "in_doubt",
      run: "completed",
      events: ["script.finished"],
    });
  });
});

/** Holds every finish of the Run until all callers in `order` have reached it, then lets them write in that order. */
function finishInOrder(store: SqliteStore, order: readonly FinishRunInput["status"][]) {
  const turns = new Map(order.map((status) => [status, Promise.withResolvers<void>()]));
  const written = new Map(order.map((status) => [status, Promise.withResolvers<void>()]));
  let arrived = 0;
  const release = async () => {
    for (const status of order) {
      turns.get(status)!.resolve();
      await written.get(status)!.promise;
    }
  };
  return new Proxy(store, {
    get(target, key) {
      if (key === "finishRun") {
        return async (input: FinishRunInput) => {
          arrived += 1;
          if (arrived === order.length) void release();
          await turns.get(input.status)!.promise;
          try {
            return await target.finishRun(input);
          } finally {
            written.get(input.status)!.resolve();
          }
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("end a Run once when an in-doubt interruption meets its normal finish", () => {
  it.each([
    { order: ["completed", "interrupted"], terminal: "RUN_FINISHED" },
    { order: ["interrupted", "completed"], terminal: "RUN_ERROR" },
  ] as const)(
    "keeps the status and terminal chunk of the first writer, $order.0 first",
    async ({ order, terminal }) => {
      const fixture = await openScriptFixture();
      const store = finishInOrder(fixture.store, order);
      const { scripts, driver, acquire } = fixture.openDriver(store);
      cleanups.push(async () => {
        await driver.close();
        fixture.store.close();
        fixture.database.cleanup();
      });
      const run = await fixture.store.markRunRunning(fixture.run.id);
      const { id } = acquire('await step.run("notes.append", { text: "entry" }); return 1;');
      scripts.detach(id);
      fixture.store.database.db.run(
        "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
      );
      await driver.kick(id).catch(() => undefined);
      fixture.store.database.db.run("DROP TRIGGER refuse_updates");

      const [, finished] = await Promise.all([
        driver.kick(id),
        finalizeDirectRunStep(
          { store, engines: new Map(), approvalTimeoutMs: 5_000 },
          { run, outcome: { kind: "completed" } },
        ),
      ]);

      const chunks = fixture.store.database.db
        .query<{ chunk_json: string }, [string]>(
          "SELECT chunk_json FROM run_events WHERE run_id = ? AND is_terminal = 1",
        )
        .all(run.id)
        .map((row) => (JSON.parse(row.chunk_json) as { type: string }).type);
      expect({
        execution: scripts.load(id).execution.status,
        run: fixture.store.getRun(run.id)?.status,
        finalized: finished.status,
        terminal: chunks,
      }).toEqual({
        execution: "in_doubt",
        run: order[0],
        finalized: order[0],
        terminal: [terminal],
      });
    },
  );

  it("streams no RUN_FINISHED when the interruption commits after the engine finished its stream", async () => {
    const fixture = await openScriptFixture();
    const { scripts, driver, acquire } = fixture.openDriver();
    cleanups.push(async () => {
      await driver.close();
      fixture.store.close();
      fixture.database.cleanup();
    });
    const run = await fixture.store.markRunRunning(fixture.run.id);
    const engine: Engine = {
      kind: "fixture",
      async *run(current) {
        yield { type: "chunk", chunkKey: `${current.id}:1`, chunk: { type: "RUN_STARTED" } };
        yield {
          type: "chunk",
          chunkKey: `${current.id}:2:RUN_FINISHED`,
          chunk: { type: "RUN_FINISHED" },
          isTerminal: true,
        };
        yield { type: "completed" };
      },
    };
    const deps = {
      store: fixture.store,
      engines: new Map([["fixture" as const, engine]]),
      approvalTimeoutMs: 5_000,
    };
    const { id } = acquire('await step.run("notes.append", { text: "entry" }); return 1;');
    scripts.detach(id);
    fixture.store.database.db.run(
      "CREATE TRIGGER refuse_updates BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    await driver.kick(id).catch(() => undefined);
    fixture.store.database.db.run("DROP TRIGGER refuse_updates");

    const outcome = await executeEngineStage(deps, run);
    await driver.kick(id);
    const finished = await finalizeDirectRunStep(deps, { run, outcome });

    const chunks = fixture.store.database.db
      .query<{ chunk_json: string; is_terminal: number }, [string]>(
        "SELECT chunk_json, is_terminal FROM run_events WHERE run_id = ? ORDER BY sequence",
      )
      .all(run.id)
      .map((row) => ({
        type: (JSON.parse(row.chunk_json) as { type: string }).type,
        terminal: row.is_terminal === 1,
      }));
    expect({ run: finished.status, chunks }).toEqual({
      run: "interrupted",
      chunks: [
        { type: "RUN_STARTED", terminal: false },
        { type: "CUSTOM", terminal: false },
        { type: "RUN_ERROR", terminal: true },
      ],
    });
  });
});
