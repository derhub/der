import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import * as z from "zod";
import {
  CapabilityCatalog,
  defineCapability,
  formatUtcTimestamp,
  streamChunk,
  type Capability,
  type Engine,
  type EngineEvent,
  type Run,
} from "@der/domain";
import { openSqliteScriptStore, openSqliteStore, type SqliteStore } from "@der/storage";
import { startServer } from "#main";
import { ScriptDriver } from "#scripts/script-driver";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

/** Where the process stopped. Each state is one the server persists on its way. */
const CRASH_STATES = [
  "admitted",
  "admitted and delivered",
  "running",
  "waiting on an engine Approval",
  "Script waiting on an Approval",
  "Script write in flight",
  "detached Script write in flight",
  "detached Script waiting on an Approval",
  "detached Script finished",
  "completed",
] as const;
type CrashState = (typeof CRASH_STATES)[number];

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

function completingEngine(): Engine {
  return {
    kind: "fixture",
    async *run(run: Run): AsyncIterable<EngineEvent> {
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
  state: CrashState,
  sessionId: string,
  nextEvent: boolean,
): Promise<void> {
  const event = { botId: "bot-1", sessionId, kind: "script.finished" } as const;
  store.enqueueSessionEvent({ ...event, id: `${sessionId}:evt-1`, payload: { n: 1 } });
  const { run } = await store.admit({
    botId: "bot-1",
    sessionId,
    origin: "event",
    idempotencyKey: `${sessionId}:evt-1`,
    input: { parts: [{ type: "text", text: '{"n":1}' }] },
  });
  if (nextEvent) {
    store.enqueueSessionEvent({ ...event, id: `${sessionId}:evt-2`, payload: { n: 2 } });
  }
  if (state === "admitted") {
    return;
  }
  store.markSessionEventDelivered(`${sessionId}:evt-1`, run.id);
  if (state === "admitted and delivered") {
    return;
  }
  await store.markRunRunning(run.id);
  await store.appendRunEvents(run.id, [
    { chunkKey: `${run.id}:started`, chunk: streamChunk({ type: "RUN_STARTED", runId: run.id }) },
  ]);
  if (state === "running") {
    return;
  }
  if (state === "completed") {
    await store.finishRun({ runId: run.id, end: { kind: "complete" } });
    return;
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
    return;
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
}

async function recoverAndSettle(crashes: readonly { state: CrashState; nextEvent: boolean }[]) {
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
  for (const [index, crash] of crashes.entries()) {
    before.createSession({ id: `sess-${index}`, botId: "bot-1", title: `${index}` });
    await persistCrashState(before, log, crash.state, `sess-${index}`, crash.nextEvent);
  }
  before.close();

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
      scriptSweepIntervalMs: 50,
    },
    catalog: writeCatalog(log),
    engines: new Map([["fixture", completingEngine()]]),
  });
  const { store } = server;
  const runs = () =>
    store.database.db
      .query<{ id: string; status: string; session_id: string }, []>(
        "SELECT id, status, session_id FROM runs ORDER BY rowid",
      )
      .all();
  try {
    const deadline = Date.now() + 3_000;
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
    return {
      undriven: runs()
        .filter((run) => ACTIVE.has(run.status))
        .map((run) => `${run.session_id} ${run.status}`),
      heldEvents: store.listPendingSessionEvents().map((event) => event.id),
      repeatedWrites: repeated,
    };
  } finally {
    await server.close();
    tempDb.cleanup();
  }
}

describe("property: direct-mode recovery after a crash", () => {
  it("leaves no event Run undriven, no event held behind one, and repeats no write", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ state: fc.constantFrom(...CRASH_STATES), nextEvent: fc.boolean() }), {
          minLength: 1,
          maxLength: 3,
        }),
        async (crashes) => {
          expect(await recoverAndSettle(crashes)).toEqual({
            undriven: [],
            heldEvents: [],
            repeatedWrites: [],
          });
        },
      ),
      { numRuns: 25 },
    );
  }, 300_000);
});
