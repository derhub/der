import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import * as z from "zod";
import {
  CapabilityCatalog,
  defineCapability,
  formatUtcTimestamp,
  persistedRunOrigin,
  runOrigin,
  streamChunk,
  type Capability,
  type Engine,
  type EngineEvent,
  type PersistedRunOrigin,
  type Run,
  type RunId,
  type RunOrigin,
  type RunUsage,
} from "@der/domain";
import { openSqliteScriptStore, openSqliteStore, type SqliteStore } from "@der/storage";
import { startServer } from "#main";
import { ScriptDriver } from "#scripts/script-driver";
import { executeEngineStage, type TurnRecord } from "#workflows/index";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

/** Where the process stopped. Each state is one the server persists on its way. */
const CRASH_STATES = [
  "admitted",
  "admitted and delivered",
  "running",
  "engine attempt completed",
  "engine attempt failed",
  "waiting on an engine Approval",
  "Script waiting on an Approval",
  "Script write in flight",
  "detached Script write in flight",
  "detached Script waiting on an Approval",
  "detached Script finished",
  "completed",
] as const;
type CrashState = (typeof CRASH_STATES)[number];

const LIVE_FAILURE_MODES = ["throw-sync", "reject-immediately", "reject-mid-stream"] as const;
type LiveFailureMode = (typeof LIVE_FAILURE_MODES)[number];

const ACTIVE = new Set<string>(["queued", "running", "waiting_approval"]);

interface WriteLog {
  readonly applied: string[];
}

function writeCatalog(log: WriteLog): CapabilityCatalog {
  const text = z.object({ text: z.string() });
  const write = (
    id: string,
    approval: "none" | "always",
    run: (input: { text: string }) => Promise<Record<string, unknown>>,
  ) =>
    defineCapability({
      id,
      description: id,
      input: text,
      output: z.object({}).passthrough(),
      effect: "write",
      approval,
      async execute(input) {
        log.applied.push(`${id}:${input.text}`);
        return run(input);
      },
    }) as Capability;
  const catalog = new CapabilityCatalog();
  catalog.add(write("notes.append", "none", async () => ({})));
  catalog.add(write("notes.publish", "always", async () => ({})));
  catalog.add(write("notes.hang", "none", () => new Promise(() => undefined)));
  return catalog;
}

const MARKER_USAGE: RunUsage = {
  inputTokens: 11,
  cachedInputTokens: 3,
  cacheWriteTokens: 4,
  outputTokens: 22,
  reportedCostUsd: 0.0125,
};

function completingEngine(calledRunIds?: Set<string>): Engine {
  return {
    kind: "fixture",
    async *run(run: Run): AsyncIterable<EngineEvent> {
      calledRunIds?.add(run.id);
      yield {
        type: "chunk",
        chunkKey: `${run.id}:started`,
        chunk: { type: "RUN_STARTED", runId: run.id, threadId: run.sessionId },
      };
      yield { type: "completed", finalMessage: { parts: [{ type: "text", text: "done" }] } };
    },
  };
}

const SCRIPTS: Partial<Record<CrashState, { source: string; detached: boolean }>> = {
  "Script waiting on an Approval": {
    source:
      'await step.run("notes.append", { text: "a" }); return await step.run("notes.publish", { text: "p" });',
    detached: false,
  },
  "Script write in flight": {
    source:
      'await step.run("notes.append", { text: "a" }); return await step.run("notes.hang", { text: "h" });',
    detached: false,
  },
  "detached Script write in flight": {
    source:
      'await step.run("notes.append", { text: "a" }); return await step.run("notes.hang", { text: "h" });',
    detached: true,
  },
  "detached Script waiting on an Approval": {
    source:
      'await step.run("notes.append", { text: "a" }); return await step.run("notes.publish", { text: "p" });',
    detached: true,
  },
  "detached Script finished": {
    source: 'await step.run("notes.append", { text: "a" }); return 1;',
    detached: true,
  },
};

/** Persists the state the server leaves when it stops at `state`, through the code that writes it. */
async function persistCrashState(
  store: SqliteStore,
  log: WriteLog,
  origin: PersistedRunOrigin,
  state: CrashState,
  sessionId: string,
  nextEvent: boolean,
): Promise<RunId> {
  const event = { botId: "bot-1", sessionId, kind: "script.finished" } as const;
  let run: Run;
  if (origin === "event") {
    store.enqueueSessionEvent({ ...event, id: `${sessionId}:evt-1`, payload: { n: 1 } });
    ({ run } = await store.admit({
      botId: "bot-1",
      sessionId,
      origin: "event",
      idempotencyKey: `${sessionId}:evt-1`,
      input: { parts: [{ type: "text", text: '{"n":1}' }] },
    }));
  } else {
    ({ run } = await store.admit({
      botId: "bot-1",
      sessionId,
      origin: origin === "telegram" ? "http" : origin,
      idempotencyKey: `${sessionId}:init`,
      input: { parts: [{ type: "text", text: "go" }] },
    }));
    if (origin === "telegram") {
      store.database.db.query("UPDATE runs SET origin = 'telegram' WHERE id = ?").run(run.id);
    }
  }
  if (nextEvent) {
    store.enqueueSessionEvent({ ...event, id: `${sessionId}:evt-2`, payload: { n: 2 } });
  }
  if (state === "admitted") {
    return run.id;
  }
  if (origin === "event") {
    store.markSessionEventDelivered(`${sessionId}:evt-1`, run.id);
  }
  if (state === "admitted and delivered") {
    return run.id;
  }
  const running = await store.markRunRunning(run.id);
  await store.appendRunEvents(run.id, [
    { chunkKey: `${run.id}:started`, chunk: streamChunk({ type: "RUN_STARTED", runId: run.id }) },
  ]);
  if (state === "running") {
    return run.id;
  }
  if (state === "engine attempt completed" || state === "engine attempt failed") {
    const turns = new Map<RunId, TurnRecord>([
      [
        run.id,
        {
          sessionId,
          engine: "fixture",
          baseHash: `base-${sessionId}`,
          contextHash: `ctx-${sessionId}`,
          lastOrdinal: 1,
        },
      ],
    ]);
    await executeEngineStage(
      {
        store,
        turns,
        engines: new Map([
          [
            "fixture",
            {
              kind: "fixture",
              resumable: true,
              async *run(activeRun) {
                yield {
                  type: "chunk",
                  chunkKey: `${activeRun.id}:delta:interim`,
                  chunk: {
                    type: "TEXT_MESSAGE_CONTENT",
                    messageId: `msg_${activeRun.id}`,
                    delta: "Interim. ",
                  },
                };
                yield state === "engine attempt completed"
                  ? {
                      type: "completed",
                      finalMessage: { parts: [{ type: "text", text: `Final ${sessionId}.` }] },
                      usage: MARKER_USAGE,
                      vendorSessionId: `vendor-${sessionId}`,
                    }
                  : {
                      type: "failed",
                      code: "engine.scripted",
                      detail: `Failed ${sessionId}.`,
                    };
              },
            },
          ],
        ]),
        approvalTimeoutMs: 60_000,
      },
      running,
    );
    return run.id;
  }
  if (state === "completed") {
    await store.finishRun({ runId: run.id, end: { kind: "complete" } });
    return run.id;
  }
  if (state === "waiting on an engine Approval") {
    await store.requestApproval({
      botId: "bot-1",
      sessionId,
      runId: run.id,
      effect: {
        runId: run.id,
        operationKind: "capability",
        operationId: "notes.publish",
        canonicalArguments: { text: "engine" },
        attemptId: `${run.id}:engine`,
      },
      prompt: "Publish?",
      awakeable: `direct_awk_${run.id}`,
      deadline: formatUtcTimestamp(new Date(Date.now() + 60_000)),
    });
    return run.id;
  }
  const script = SCRIPTS[state]!;
  const source = script.source.replaceAll('text: "', `text: "${sessionId}:`);
  const scripts = openSqliteScriptStore({ database: store.database });
  const driver = new ScriptDriver({
    store,
    scripts,
    bots: store,
    catalog: writeCatalog(log),
    limits: {
      memoryBytes: 64 * 1024 * 1024,
      activeMs: 5_000,
      maxAll: 1000,
      maxInFlight: 2000,
      maxSteps: 2000,
      outputBytes: 1024 * 1024,
    },
    approvalTimeoutMs: 60_000,
    sweepIntervalMs: 60_000,
    now: () => new Date(),
  });
  const execution = scripts.acquire({ runId: run.id, botId: "bot-1", source, seed: 1 });
  if (script.detached) {
    scripts.detach(execution.id);
  }
  void driver.kick(execution.id);
  await waitUntil(
    () =>
      state.endsWith("finished")
        ? scripts.load(execution.id).execution.result !== null
        : state.endsWith("in flight")
          ? log.applied.includes(`notes.hang:${sessionId}:h`)
          : store.listPendingApprovalsForRun(run.id).length > 0,
    { timeoutMs: 5_000, label: `the Script reached "${state}"` },
  );
  await driver.close();
  return run.id;
}

async function recoverAndSettle(
  crashes: readonly { origin: PersistedRunOrigin; state: CrashState; nextEvent: boolean }[],
) {
  const tempDb = createTempDatabase("der-recovery-property-");
  const log: WriteLog = { applied: [] };
  const before = openSqliteStore({ filename: tempDb.dbPath });
  before.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
    eventChainLimit: 100,
  });
  const seeded: {
    readonly sessionId: string;
    readonly runId: RunId;
    readonly state: CrashState;
    readonly nextEvent: boolean;
  }[] = [];
  for (const [index, crash] of crashes.entries()) {
    const sessionId = `sess-${index}`;
    before.createSession({ id: sessionId, botId: "bot-1", title: `${index}` });
    const runId = await persistCrashState(
      before,
      log,
      crash.origin,
      crash.state,
      sessionId,
      crash.nextEvent,
    );
    seeded.push({ sessionId, runId, state: crash.state, nextEvent: crash.nextEvent });
  }
  before.close();

  const calledRunIds = new Set<string>();
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
      scriptSweepIntervalMs: 60_000,
    },
    catalog: writeCatalog(log),
    engines: new Map([["fixture", completingEngine(calledRunIds)]]),
  });
  const { store } = server;
  const runs = () =>
    store.database.db
      .query<{ id: string; origin: string; status: string; session_id: string }, []>(
        "SELECT id, origin, status, session_id FROM runs ORDER BY rowid",
      )
      .all();
  try {
    await server.scriptDriver.sweep();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      for (const run of runs()) {
        for (const approval of store.listPendingApprovalsForRun(run.id)) {
          await server.commands
            .decideApproval({
              approvalId: approval.id,
              botId: approval.botId,
              sessionId: approval.sessionId,
              runId: approval.runId,
              status: "approved",
              actor: "operator",
              decidedAt: formatUtcTimestamp(new Date()),
            })
            .catch(() => undefined);
        }
      }
      if (
        runs().every((run) => !ACTIVE.has(run.status)) &&
        store.listPendingSessionEvents().length === 0
      ) {
        break;
      }
      await Bun.sleep(25);
    }
    const repeated = [...new Set(log.applied)].filter(
      (write) => log.applied.filter((applied) => applied === write).length > 1,
    );
    const markerViolations: string[] = [];
    for (const item of seeded) {
      if (item.state === "engine attempt completed") {
        const stored = store.getRun(item.runId);
        const reply = store
          .listMessages(item.sessionId)
          .find((message) => message.runId === item.runId && message.role === "assistant");
        const handedOver = store.getEngineSession(item.sessionId, "fixture");
        if (stored?.status !== "completed") {
          markerViolations.push(`${item.sessionId} completed marker ended as ${stored?.status}`);
        }
        if (JSON.stringify(stored?.usage) !== JSON.stringify(MARKER_USAGE)) {
          markerViolations.push(`${item.sessionId} usage lost: ${JSON.stringify(stored?.usage)}`);
        }
        if (
          JSON.stringify(reply?.parts) !==
          JSON.stringify([{ type: "text", text: `Final ${item.sessionId}.` }])
        ) {
          markerViolations.push(
            `${item.sessionId} reply mismatch: ${JSON.stringify(reply?.parts)}`,
          );
        }
        if (calledRunIds.has(item.runId)) {
          markerViolations.push(`${item.sessionId} re-invoked engine for completed marker`);
        }
        if (!item.nextEvent && handedOver?.vendorSessionId !== `vendor-${item.sessionId}`) {
          markerViolations.push(
            `${item.sessionId} engineSession lost: ${handedOver?.vendorSessionId ?? "null"}`,
          );
        }
      } else if (item.state === "engine attempt failed") {
        const stored = store.getRun(item.runId);
        const terminal = store.readRunEventsAfter(item.runId, 0, 100).find((ev) => ev.isTerminal)
          ?.chunk as { type?: string; code?: string } | undefined;
        if (stored?.status !== "failed" || terminal?.code !== "engine.scripted") {
          markerViolations.push(
            `${item.sessionId} failed marker ended as ${stored?.status} (${terminal?.code ?? "none"})`,
          );
        }
        if (calledRunIds.has(item.runId)) {
          markerViolations.push(`${item.sessionId} re-invoked engine for failed marker`);
        }
      }
    }
    return {
      undriven: runs()
        .filter((run) => ACTIVE.has(run.status))
        .map((run) => `${run.session_id} ${run.origin} ${run.status}`),
      heldEvents: store.listPendingSessionEvents().map((event) => event.id),
      repeatedWrites: repeated,
      markerViolations,
    };
  } finally {
    await server.close();
    tempDb.cleanup();
  }
}

function failingThenCompletingEngine(
  mode: LiveFailureMode,
  chunksBeforeReject: number,
  onFailedExit: () => void,
): Engine {
  let failingRunId: string | undefined;
  return {
    kind: "fixture",
    run(run: Run): AsyncIterable<EngineEvent> {
      if (failingRunId === undefined || failingRunId === run.id) {
        failingRunId = run.id;
        if (mode === "throw-sync") {
          onFailedExit();
          throw new Error("engine threw synchronously");
        }
        return (async function* () {
          try {
            if (mode === "reject-mid-stream") {
              yield {
                type: "chunk",
                chunkKey: `${run.id}:started`,
                chunk: { type: "RUN_STARTED", runId: run.id, threadId: run.sessionId },
              };
              for (let i = 0; i < chunksBeforeReject; i += 1) {
                yield {
                  type: "chunk",
                  chunkKey: `${run.id}:delta:${i}`,
                  chunk: {
                    type: "TEXT_MESSAGE_CONTENT",
                    messageId: `msg_${run.id}`,
                    delta: `${i}`,
                  },
                };
              }
            }
            throw new Error(`engine stream rejected (${mode})`);
          } finally {
            onFailedExit();
          }
        })();
      }
      return completingEngine().run(run);
    },
  };
}

async function exerciseLiveEngineFailure(input: {
  readonly origin: RunOrigin;
  readonly mode: LiveFailureMode;
  readonly chunksBeforeReject: number;
  readonly nextEvent: boolean;
  readonly restartAfter: boolean;
}) {
  const tempDb = createTempDatabase("der-live-failure-property-");
  const failedExited = Promise.withResolvers<void>();
  const config = {
    host: "127.0.0.1",
    port: 0,
    restateMode: "direct" as const,
    databasePath: tempDb.dbPath,
    memoryProjectionDir: `${tempDb.dir}/memory`,
    skillsRootDir: `${tempDb.dir}/skills`,
    workspaceRootDir: `${tempDb.dir}/workspaces`,
    enabledEngines: ["fixture" as const],
    scriptSweepIntervalMs: 60_000,
  };
  let server = await startServer({
    config,
    engines: new Map([
      [
        "fixture",
        failingThenCompletingEngine(input.mode, input.chunksBeforeReject, () =>
          failedExited.resolve(),
        ),
      ],
    ]),
  });
  try {
    server.store.createBot({
      id: "bot-1",
      name: "Bot",
      persona: "",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
      eventChainLimit: 100,
    });
    server.store.createSession({ id: "sess-0", botId: "bot-1", title: "0" });

    let firstRunId: string;
    if (input.origin === "event") {
      server.store.enqueueSessionEvent({
        id: "evt-1",
        botId: "bot-1",
        sessionId: "sess-0",
        kind: "script.finished",
        payload: { n: 1 },
      });
      if (input.nextEvent) {
        server.store.enqueueSessionEvent({
          id: "evt-2",
          botId: "bot-1",
          sessionId: "sess-0",
          kind: "script.finished",
          payload: { n: 2 },
        });
      }
      await server.scriptDriver.sweep();
      const firstRow = server.store.database.db
        .query<{ id: string }, []>("SELECT id FROM runs ORDER BY rowid LIMIT 1")
        .get();
      firstRunId = firstRow!.id;
    } else {
      if (input.nextEvent) {
        server.store.enqueueSessionEvent({
          id: "evt-2",
          botId: "bot-1",
          sessionId: "sess-0",
          kind: "script.finished",
          payload: { n: 2 },
        });
      }
      const admitted = await server.commands.admitRun({
        botId: "bot-1",
        sessionId: "sess-0",
        origin: input.origin,
        idempotencyKey: "init-1",
        input: { parts: [{ type: "text", text: "go" }] },
      });
      firstRunId = admitted.run.id;
    }

    await failedExited.promise;

    const inspect = () => {
      const allRuns = server.store.database.db
        .query<{ id: string; origin: string; status: string }, []>(
          "SELECT id, origin, status FROM runs ORDER BY rowid",
        )
        .all();
      const terminals = server.store
        .readRunEventsAfter(firstRunId, 0, 10_000)
        .filter((event) => event.isTerminal)
        .map((event) => {
          const chunk = event.chunk as { type?: string; code?: string };
          return {
            type: chunk.type ?? "",
            hasCode: typeof chunk.code === "string" && chunk.code.length > 0,
          };
        });
      return {
        firstStatus: server.store.getRun(firstRunId)?.status ?? "",
        firstTerminals: terminals,
        undriven: allRuns
          .filter((run) => ACTIVE.has(run.status))
          .map((run) => `${run.origin} ${run.status}`),
        heldEvents: server.store.listPendingSessionEvents().map((event) => event.id),
      };
    };

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const state = inspect();
      if (state.undriven.length === 0 && state.heldEvents.length === 0) {
        break;
      }
      await Bun.sleep(20);
    }
    const afterStep = inspect();

    if (!input.restartAfter) {
      return { afterStep, afterRestart: afterStep };
    }

    await server.close();
    server = await startServer({
      config,
      engines: new Map([["fixture", completingEngine()]]),
    });
    await server.scriptDriver.sweep();
    const restartDeadline = Date.now() + 1_000;
    while (Date.now() < restartDeadline) {
      const state = inspect();
      if (state.undriven.length === 0 && state.heldEvents.length === 0) {
        break;
      }
      await Bun.sleep(20);
    }
    return { afterStep, afterRestart: inspect() };
  } finally {
    await server.close();
    tempDb.cleanup();
  }
}

describe("property: direct-mode recovery after a crash", () => {
  it("leaves no Run of any origin undriven, no event held behind one, and repeats no write", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            origin: fc.constantFrom(...persistedRunOrigin.options),
            state: fc.constantFrom(...CRASH_STATES),
            nextEvent: fc.boolean(),
          }),
          {
            minLength: 1,
            maxLength: 3,
          },
        ),
        async (crashes) => {
          expect(await recoverAndSettle(crashes)).toEqual({
            undriven: [],
            heldEvents: [],
            repeatedWrites: [],
            markerViolations: [],
          });
        },
      ),
      { numRuns: 30 },
    );
  }, 300_000);

  it("ends a Run as failed with a terminal chunk and delivers the next event when a live engine throws or rejects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          origin: fc.constantFrom(...runOrigin.options),
          mode: fc.constantFrom(...LIVE_FAILURE_MODES),
          chunksBeforeReject: fc.integer({ min: 0, max: 3 }),
          nextEvent: fc.boolean(),
          restartAfter: fc.boolean(),
        }),
        async (input) => {
          const expected = {
            firstStatus: "failed",
            firstTerminals: [{ type: "RUN_ERROR", hasCode: true }],
            undriven: [],
            heldEvents: [],
          };
          expect(await exerciseLiveEngineFailure(input)).toEqual({
            afterStep: expected,
            afterRestart: expected,
          });
        },
      ),
      { numRuns: 24 },
    );
  }, 120_000);
});
