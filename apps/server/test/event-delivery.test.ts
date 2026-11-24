import { afterEach, describe, expect, it } from "bun:test";
import {
  formatUtcTimestamp,
  type Engine,
  type JsonValue,
  type RunId,
  type RunRequest,
  type RunUsage,
} from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { createEventDelivery } from "#events/event-delivery";
import { seedFixtureRecords, startServer, type RunningServer } from "#main";
import {
  ENGINE_EXECUTION_FAILED_CODE,
  executeEngineStage,
  type TurnRecord,
} from "#workflows/index";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openStore(eventChainLimit?: number, maxResultBytes = 65_536) {
  const database = createTempDatabase("der-event-delivery-");
  const store = openSqliteStore({ filename: database.dbPath });
  cleanups.push(() => {
    store.close();
    database.cleanup();
  });
  store.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
    ...(eventChainLimit !== undefined ? { eventChainLimit } : {}),
  });
  store.createSession({ id: "sess-1", botId: "bot-1", title: "One" });
  const deliver = createEventDelivery({
    store,
    bots: store,
    admit: (request) => store.admit(request),
    maxResultBytes,
  });
  return { store, deliver };
}

function enqueue(store: SqliteStore, id: string, payload: JsonValue = { n: 1 }) {
  store.enqueueSessionEvent({
    id,
    botId: "bot-1",
    sessionId: "sess-1",
    kind: "script.finished",
    payload,
  });
}

async function admitRun(store: SqliteStore, origin: RunRequest["origin"], key: string) {
  const { run } = await store.admit({
    botId: "bot-1",
    sessionId: "sess-1",
    origin,
    idempotencyKey: key,
    input: { parts: [{ type: "text", text: key }] },
  });
  return run;
}

async function finish(store: SqliteStore, runId: string) {
  await store.finishRun({ runId, end: { kind: "complete" } });
}

function eventRuns(store: SqliteStore) {
  return store.database.db
    .query<{ id: string; status: string }, []>(
      "SELECT id, status FROM runs WHERE origin = 'event' ORDER BY rowid",
    )
    .all();
}

function eventText(store: SqliteStore): string {
  const [part] = JSON.parse(
    store.database.db
      .query<{ parts_json: string }, []>(
        "SELECT parts_json FROM messages WHERE run_id = (SELECT id FROM runs WHERE origin = 'event')",
      )
      .get()!.parts_json,
  ) as { text: string }[];
  return part!.text;
}

describe("deliver a session event", () => {
  it("holds an event while a Run is active and admits it after that Run finishes", async () => {
    const { store, deliver } = openStore();
    const human = await admitRun(store, "http", "h1");
    enqueue(store, "evt-1", { n: 7 });

    await deliver();
    expect(eventRuns(store)).toEqual([]);
    expect(store.countPendingSessionEvents("sess-1")).toBe(1);

    await finish(store, human.id);
    await deliver();

    const runs = eventRuns(store);
    expect(runs).toHaveLength(1);
    expect(store.countPendingSessionEvents("sess-1")).toBe(0);
    const message = store.database.db
      .query<{ parts_json: string; run_id: string }, []>(
        "SELECT parts_json, run_id FROM messages WHERE run_id = (SELECT id FROM runs WHERE origin = 'event')",
      )
      .get();
    expect(message).toEqual({
      parts_json: '[{"type":"text","text":"{\\"n\\":7}"}]',
      run_id: runs[0]!.id,
    });
  });

  it("holds the fourth consecutive event at a limit of 3 and releases it after a human Run", async () => {
    const { store, deliver } = openStore(3);
    for (const id of ["evt-1", "evt-2", "evt-3", "evt-4"]) enqueue(store, id);

    for (let delivered = 1; delivered <= 3; delivered += 1) {
      await deliver();
      const runs = eventRuns(store);
      expect(runs).toHaveLength(delivered);
      await finish(store, runs.at(-1)!.id);
    }

    await deliver();
    expect(eventRuns(store)).toHaveLength(3);
    expect(store.listPendingSessionEvents().map((event) => event.id)).toEqual(["evt-4"]);

    const human = await admitRun(store, "web", "h1");
    await finish(store, human.id);
    await deliver();

    expect(eventRuns(store)).toHaveLength(4);
    expect(store.listPendingSessionEvents()).toEqual([]);
  });

  it("keeps the fourth event queued through a routine Run at a limit of 3 and releases it after a human Run", async () => {
    const { store, deliver } = openStore(3);
    for (const id of ["evt-1", "evt-2", "evt-3", "evt-4"]) enqueue(store, id);
    for (let delivered = 1; delivered <= 3; delivered += 1) {
      await deliver();
      await finish(store, eventRuns(store).at(-1)!.id);
    }

    const routine = await admitRun(store, "routine", "r1");
    await finish(store, routine.id);
    await deliver();
    const afterRoutine = {
      eventRuns: eventRuns(store).length,
      pending: store.listPendingSessionEvents().map((event) => event.id),
    };
    const human = await admitRun(store, "http", "h1");
    await finish(store, human.id);
    await deliver();

    expect({ afterRoutine, eventRunsAfterHuman: eventRuns(store).length }).toEqual({
      afterRoutine: { eventRuns: 3, pending: ["evt-4"] },
      eventRunsAfterHuman: 4,
    });
  });

  it("delivers on the pass after one whose queue read failed", async () => {
    const { store, deliver } = openStore();
    enqueue(store, "evt-1");
    store.database.db.run("ALTER TABLE session_events RENAME TO session_events_away");

    const failed = await deliver().then(
      () => "resolved",
      (error: unknown) => (error as Error).message,
    );
    store.database.db.run("ALTER TABLE session_events_away RENAME TO session_events");
    await deliver();

    expect({ failed, eventRuns: eventRuns(store).length }).toEqual({
      failed: "no such table: session_events",
      eventRuns: 1,
    });
  });

  it("fits a failed result's long message and logs into the event text limit and flags each cut", async () => {
    const { store, deliver } = openStore(undefined, 300);
    enqueue(store, "evt-1", {
      status: "failed",
      result: {
        ok: false,
        error: { kind: "capability", message: "z".repeat(500) },
        logs: ["l".repeat(100)],
      },
    });

    await deliver();

    const [part] = JSON.parse(
      store.database.db
        .query<{ parts_json: string }, []>(
          "SELECT parts_json FROM messages WHERE run_id = (SELECT id FROM runs WHERE origin = 'event')",
        )
        .get()!.parts_json,
    ) as { text: string }[];
    expect({
      text: part!.text,
      bytes: new TextEncoder().encode(part!.text).byteLength,
    }).toEqual({
      text: `{"status":"failed","result":{"ok":false,"error":{"kind":"capability","message":"${"z".repeat(168)} [message truncated]"},"logs":["[logs truncated]"]}}`,
      bytes: 300,
    });
  });

  it("keeps a failed in-doubt result's unknown write within the 256-byte minimum limit", async () => {
    const { store, deliver } = openStore(undefined, 256);
    enqueue(store, "evt-1", {
      event: "script.finished",
      executionId: "exec-1",
      status: "in_doubt",
      result: {
        ok: false,
        error: {
          kind: "capability",
          message: `${"r".repeat(300)}. Already applied: none confirmed. Unknown outcome: #1 notes.append.`,
        },
        logs: [],
      },
    });

    await deliver();

    expect(eventText(store)).toBe(
      `{"event":"script.finished","executionId":"exec-1","status":"in_doubt","result":{"ok":false,"error":{"kind":"capability","message":"${"r".repeat(57)} [message truncated] Unknown outcome: #1 notes.append."},"logs":[]}}`,
    );
  });

  it("keeps the event text of a call to a 70,000-character unknown capability within the default limit", async () => {
    const { store, deliver } = openStore();
    const id = `notes.${"z".repeat(70_000)}`;
    enqueue(store, "evt-1", {
      event: "script.finished",
      executionId: "exec-1",
      status: "failed",
      result: {
        ok: false,
        error: { kind: "capability", message: `Unknown capability "${id}" at step 1.`, call: id },
        logs: [],
      },
    });

    await deliver();

    expect(new TextEncoder().encode(eventText(store)).byteLength).toBeLessThanOrEqual(65_536);
  });

  it("marks delivered and links an event whose admitted Run already ended, and admits nothing", async () => {
    const { store, deliver } = openStore();
    enqueue(store, "evt-1", { n: 1 });
    const admitted = await admitRun(store, "event", "evt-1");
    await finish(store, admitted.id);

    await deliver();

    expect({
      runs: eventRuns(store),
      pending: store.listPendingSessionEvents(),
      link: store.database.db
        .query<{ state: string; run_id: string }, []>(
          "SELECT state, run_id FROM session_events WHERE id = 'evt-1'",
        )
        .get(),
    }).toEqual({
      runs: [{ id: admitted.id, status: "completed" }],
      pending: [],
      link: { state: "delivered", run_id: admitted.id },
    });
  });

  it("never admits an event Run for a bot with a limit of 0", async () => {
    const { store, deliver } = openStore(0);
    enqueue(store, "evt-1");

    await deliver();

    expect(eventRuns(store)).toEqual([]);
    expect(store.countPendingSessionEvents("sess-1")).toBe(1);
  });

  it("delivers oldest first, one event per session per pass", async () => {
    const { store, deliver } = openStore();
    enqueue(store, "evt-1", { n: 1 });
    enqueue(store, "evt-2", { n: 2 });

    await deliver();

    expect(store.listPendingSessionEvents().map((event) => event.id)).toEqual(["evt-2"]);
    expect(eventRuns(store)).toHaveLength(1);
  });
});

async function startDirectServer(tempDb: ReturnType<typeof createTempDatabase>) {
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
      seedFixture: true,
    },
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return server;
}

describe("recover an event Run admitted before a crash", () => {
  it("starts at startup a queued event Run whose event was already marked delivered", async () => {
    const tempDb = createTempDatabase("der-event-startup-");
    const before = openSqliteStore({ filename: tempDb.dbPath });
    const { bot, session } = seedFixtureRecords(before);
    const { run } = await before.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "event",
      idempotencyKey: "evt-1",
      input: { parts: [{ type: "text", text: '{"n":1}' }] },
    });
    before.enqueueSessionEvent({
      id: "evt-1",
      botId: bot.id,
      sessionId: session.id,
      kind: "script.finished",
      payload: { n: 1 },
    });
    before.markSessionEventDelivered("evt-1", run.id);
    before.close();

    const server = await startDirectServer(tempDb);

    await waitUntil(() => server.store.getLatestApprovalForRun(run.id), {
      timeoutMs: 10_000,
      label: "the queued event Run started and asked for approval",
    });

    expect(server.store.getRun(run.id)?.status).toBe("waiting_approval");
  }, 30_000);

  it("starts every queued event Run of eight sessions at startup with its engine", async () => {
    const tempDb = createTempDatabase("der-event-startup-many-");
    const before = openSqliteStore({ filename: tempDb.dbPath });
    const { bot } = seedFixtureRecords(before);
    const runIds: string[] = [];
    for (let n = 1; n <= 8; n += 1) {
      const session = before.createSession({ id: `sess-many-${n}`, botId: bot.id, title: `${n}` });
      const { run } = await before.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "event",
        idempotencyKey: `evt-many-${n}`,
        input: { parts: [{ type: "text", text: `{"n":${n}}` }] },
      });
      runIds.push(run.id);
    }
    before.close();

    const server = await startDirectServer(tempDb);
    const statuses = () => runIds.map((id) => server.store.getRun(id)?.status);
    await waitUntil(
      () => statuses().every((status) => status !== "queued" && status !== "running"),
      {
        timeoutMs: 10_000,
        label: "every queued event Run left the queue",
      },
    );

    expect(statuses()).toEqual(Array.from({ length: 8 }, () => "waiting_approval"));
  }, 30_000);

  it("starts the admitted Run that never started and then delivers the session's next event", async () => {
    const server = await startDirectServer(createTempDatabase("der-event-crash-"));
    const botId = server.seededFixture!.bot.id;
    const sessionId = server.seededFixture!.session.id;
    const event = { botId, sessionId, kind: "script.finished", payload: { n: 1 } } as const;
    const crashed = await server.store.admit({
      botId,
      sessionId,
      origin: "event",
      idempotencyKey: "evt-1",
      input: { parts: [{ type: "text", text: '{"n":1}' }] },
    });
    server.store.enqueueSessionEvent({ ...event, id: "evt-1" });
    server.store.enqueueSessionEvent({ ...event, id: "evt-2", payload: { n: 2 } });

    const runs = () =>
      server.store.database.db
        .query<{ id: string; status: string }, []>(
          "SELECT id, status FROM runs WHERE origin = 'event' ORDER BY rowid",
        )
        .all();
    await waitUntil(() => server.store.getLatestApprovalForRun(crashed.run.id), {
      timeoutMs: 10_000,
      label: "the admitted Run started and asked for approval",
    });
    await server.commands.decideApproval({
      approvalId: server.store.getLatestApprovalForRun(crashed.run.id)!.id,
      botId,
      sessionId,
      runId: crashed.run.id,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    } as Parameters<RunningServer["coordinator"]["decide"]>[0]);
    await waitUntil(() => runs().length === 2, {
      timeoutMs: 10_000,
      label: "the next event admitted",
    });

    expect({
      first: runs()[0]!,
      events: server.store.database.db
        .query<{ id: string; state: string; run_id: string }, []>(
          "SELECT id, state, run_id FROM session_events ORDER BY rowid",
        )
        .all()
        .map((row) => [row.id, row.state, row.run_id === crashed.run.id]),
    }).toEqual({
      first: { id: crashed.run.id, status: "completed" },
      events: [
        ["evt-1", "delivered", true],
        ["evt-2", "delivered", false],
      ],
    });
  }, 30_000);

  it.each(["running", "waiting_approval"] as const)(
    "ends at startup an event Run left %s and then delivers the session's next event",
    async (status) => {
      const tempDb = createTempDatabase("der-event-running-");
      const before = openSqliteStore({ filename: tempDb.dbPath });
      const { bot, session } = seedFixtureRecords(before);
      const event = { botId: bot.id, sessionId: session.id, kind: "script.finished" } as const;
      const { run } = await before.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "event",
        idempotencyKey: "evt-1",
        input: { parts: [{ type: "text", text: '{"n":1}' }] },
      });
      before.enqueueSessionEvent({ ...event, id: "evt-1", payload: { n: 1 } });
      before.markSessionEventDelivered("evt-1", run.id);
      before.enqueueSessionEvent({ ...event, id: "evt-2", payload: { n: 2 } });
      await before.markRunRunning(run.id);
      if (status === "waiting_approval") {
        await before.requestApproval({
          botId: bot.id,
          sessionId: session.id,
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
          deadline: "2099-01-01T00:00:00Z",
        });
      }
      const left = before.getRun(run.id)?.status;
      before.close();

      const server = await startDirectServer(tempDb);
      await waitUntil(() => server.store.listPendingSessionEvents().length === 0, {
        timeoutMs: 3_000,
        label: "the session's next event admitted",
      });

      const terminal = server.store.database.db
        .query<{ chunk_json: string }, [string]>(
          "SELECT chunk_json FROM run_events WHERE run_id = ? AND is_terminal = 1",
        )
        .all(run.id)
        .map((row) => JSON.parse(row.chunk_json) as { type: string; code: string });
      expect({
        left,
        run: server.store.getRun(run.id)?.status,
        terminal: terminal.map(({ type, code }) => ({ type, code })),
        eventRuns: server.store.database.db
          .query<{ id: string }, []>("SELECT id FROM runs WHERE origin = 'event' ORDER BY rowid")
          .all().length,
      }).toEqual({
        left: status,
        run: "interrupted",
        terminal: [{ type: "RUN_ERROR", code: "run.server_restarted" }],
        eventRuns: 2,
      });
    },
    30_000,
  );

  it.each([
    { origin: "http" as const, status: "queued" as const, expectedStatus: "completed" as const },
    { origin: "http" as const, status: "running" as const, expectedStatus: "interrupted" as const },
    {
      origin: "web" as const,
      status: "waiting_approval" as const,
      expectedStatus: "interrupted" as const,
    },
    {
      origin: "telegram" as const,
      status: "running" as const,
      expectedStatus: "interrupted" as const,
    },
    {
      origin: "routine" as const,
      status: "waiting_approval" as const,
      expectedStatus: "interrupted" as const,
    },
  ])(
    "recovers a $origin Run left $status at direct startup to $expectedStatus and delivers the next event",
    async ({ origin, status, expectedStatus }) => {
      const tempDb = createTempDatabase("der-origin-recovery-");
      const before = openSqliteStore({ filename: tempDb.dbPath });
      const { bot, session } = seedFixtureRecords(before);
      const { run } = await before.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: origin === "telegram" ? "http" : origin,
        idempotencyKey: `origin-${origin}-${status}`,
        input: { parts: [{ type: "text", text: "direct:ok" }] },
      });
      if (origin === "telegram") {
        before.database.db.query("UPDATE runs SET origin = 'telegram' WHERE id = ?").run(run.id);
      }
      if (status !== "queued") {
        await before.markRunRunning(run.id);
      }
      if (status === "waiting_approval") {
        await before.requestApproval({
          botId: bot.id,
          sessionId: session.id,
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
          deadline: "2099-01-01T00:00:00Z",
        });
      }
      before.enqueueSessionEvent({
        id: "evt-after",
        botId: bot.id,
        sessionId: session.id,
        kind: "script.finished",
        payload: { n: 1 },
      });
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
          scriptSweepIntervalMs: 60_000,
          seedFixture: true,
        },
        engines: new Map([
          [
            "fixture",
            {
              kind: "fixture",
              async *run(activeRun) {
                yield {
                  type: "chunk",
                  chunkKey: `${activeRun.id}:started`,
                  chunk: {
                    type: "RUN_STARTED",
                    runId: activeRun.id,
                    threadId: activeRun.sessionId,
                  },
                };
                yield {
                  type: "completed",
                  finalMessage: { parts: [{ type: "text", text: "ok" }] },
                };
              },
            },
          ],
        ]),
      });
      cleanups.push(async () => {
        await server.close();
        tempDb.cleanup();
      });

      await waitUntil(
        () =>
          server.store.getRun(run.id)?.status === expectedStatus &&
          server.store.listPendingSessionEvents().length === 0,
        { timeoutMs: 3_000, label: `${origin} Run recovered and next event delivered` },
      );

      const terminal = server.store
        .readRunEventsAfter(run.id, 0, 100)
        .filter((event) => event.isTerminal)
        .map((event) => {
          const chunk = event.chunk as { type: string; code?: string };
          return { type: chunk.type, ...(chunk.code !== undefined ? { code: chunk.code } : {}) };
        });
      expect({
        status: server.store.getRun(run.id)?.status,
        terminal,
        pending: server.store.listPendingSessionEvents(),
      }).toEqual({
        status: expectedStatus,
        terminal:
          expectedStatus === "completed"
            ? [{ type: "RUN_FINISHED" }]
            : [{ type: "RUN_ERROR", code: "run.server_restarted" }],
        pending: [],
      });
    },
    30_000,
  );

  it.each([
    { withNextEvent: false, label: "preserves vendor session handover" },
    { withNextEvent: true, label: "delivers the queued session event via the winner hook" },
  ])(
    "finishes a running Run as completed from its durable marker on direct startup and $label",
    async ({ withNextEvent }) => {
      const tempDb = createTempDatabase("der-marker-direct-recovery-");
      const before = openSqliteStore({ filename: tempDb.dbPath });
      const { bot, session } = seedFixtureRecords(before);
      const { run, initialMessage } = await before.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: `marker-direct-${withNextEvent}`,
        input: { parts: [{ type: "text", text: "work" }] },
      });
      const running = await before.markRunRunning(run.id);
      const usage: RunUsage = {
        inputTokens: 15,
        cachedInputTokens: 2,
        cacheWriteTokens: 5,
        outputTokens: 30,
        reportedCostUsd: 0.02,
      };
      const turns = new Map<RunId, TurnRecord>([
        [
          run.id,
          {
            sessionId: session.id,
            engine: "fixture",
            baseHash: "base-direct",
            contextHash: "ctx-direct",
            lastOrdinal: initialMessage.ordinal,
          },
        ],
      ]);
      await executeEngineStage(
        {
          store: before,
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
                    chunkKey: `${activeRun.id}:delta:1`,
                    chunk: {
                      type: "TEXT_MESSAGE_CONTENT",
                      messageId: `msg_${activeRun.id}`,
                      delta: "Interim. ",
                    },
                  };
                  yield {
                    type: "completed",
                    finalMessage: { parts: [{ type: "text", text: "Done." }] },
                    usage,
                    vendorSessionId: "vendor-direct-1",
                  };
                },
              },
            ],
          ]),
          approvalTimeoutMs: 60_000,
        },
        running,
      );
      if (withNextEvent) {
        before.enqueueSessionEvent({
          id: "evt-after-marker",
          botId: bot.id,
          sessionId: session.id,
          kind: "script.finished",
          payload: { n: 1 },
        });
      }
      before.close();

      const startedRunIds: string[] = [];
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
          seedFixture: true,
        },
        engines: new Map([
          [
            "fixture",
            {
              kind: "fixture",
              async *run(activeRun) {
                startedRunIds.push(activeRun.id);
                yield {
                  type: "completed",
                  finalMessage: { parts: [{ type: "text", text: "event reply" }] },
                };
              },
            },
          ],
        ]),
      });
      cleanups.push(async () => {
        await server.close();
        tempDb.cleanup();
      });

      await waitUntil(
        () =>
          server.store.getRun(run.id)?.status !== "running" &&
          server.store.listPendingSessionEvents().length === 0,
        { timeoutMs: 3_000, label: "marker-bearing Run settled on direct startup" },
      );

      const recovered = server.store.getRun(run.id);
      const reply = server.store
        .listMessages(session.id)
        .find((message) => message.runId === run.id && message.role === "assistant");
      const terminal = server.store
        .readRunEventsAfter(run.id, 0, 100)
        .filter((event) => event.isTerminal)
        .map((event) => (event.chunk as { type: string }).type);
      const handedOver = server.store.getEngineSession(session.id, "fixture");

      expect({
        status: recovered?.status,
        usage: recovered?.usage,
        replyParts: reply?.parts,
        terminal,
        invokedMarkerRun: startedRunIds.includes(run.id),
        pendingEvents: server.store.listPendingSessionEvents().length,
        ...(withNextEvent ? {} : { vendorSessionId: handedOver?.vendorSessionId }),
      }).toEqual({
        status: "completed",
        usage,
        replyParts: [{ type: "text", text: "Done." }],
        terminal: ["RUN_FINISHED"],
        invokedMarkerRun: false,
        pendingEvents: 0,
        ...(withNextEvent ? {} : { vendorSessionId: "vendor-direct-1" }),
      });
    },
    30_000,
  );

  it("finishes a running Run as failed from its durable failure marker on direct startup instead of interrupting it", async () => {
    const tempDb = createTempDatabase("der-marker-failed-recovery-");
    const before = openSqliteStore({ filename: tempDb.dbPath });
    const { bot, session } = seedFixtureRecords(before);
    const { run } = await before.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "http",
      idempotencyKey: "marker-failed-1",
      input: { parts: [{ type: "text", text: "work" }] },
    });
    const running = await before.markRunRunning(run.id);
    await executeEngineStage(
      {
        store: before,
        engines: new Map([
          [
            "fixture",
            {
              kind: "fixture",
              async *run() {
                yield {
                  type: "failed",
                  code: "engine.fixture_failed",
                  detail: "Permanent engine error.",
                };
              },
            },
          ],
        ]),
        approvalTimeoutMs: 60_000,
      },
      running,
    );
    before.close();

    let calls = 0;
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
        seedFixture: true,
      },
      engines: new Map([
        [
          "fixture",
          {
            kind: "fixture",
            async *run() {
              calls += 1;
              yield { type: "completed" };
            },
          },
        ],
      ]),
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const terminal = server.store
      .readRunEventsAfter(run.id, 0, 100)
      .filter((event) => event.isTerminal)
      .map((event) => {
        const chunk = event.chunk as { type: string; code?: string; message?: string };
        return { type: chunk.type, code: chunk.code, message: chunk.message };
      });
    expect({
      status: server.store.getRun(run.id)?.status,
      terminal,
      calls,
    }).toEqual({
      status: "failed",
      terminal: [
        { type: "RUN_ERROR", code: "engine.fixture_failed", message: "Permanent engine error." },
      ],
      calls: 0,
    });
  }, 30_000);

  it.each(["throw-sync", "reject-mid-stream"] as const)(
    "ends a direct Run as failed with engine.execution_failed and delivers the next event when the engine fails (%s)",
    async (mode) => {
      const tempDb = createTempDatabase("der-engine-throw-");
      let firstRunId: string | undefined;
      const engine: Engine = {
        kind: "fixture",
        run(activeRun) {
          if (firstRunId === undefined || firstRunId === activeRun.id) {
            firstRunId = activeRun.id;
            if (mode === "throw-sync") {
              throw new Error("boom sync");
            }
            return (async function* () {
              yield {
                type: "chunk",
                chunkKey: `${activeRun.id}:started`,
                chunk: { type: "RUN_STARTED", runId: activeRun.id, threadId: activeRun.sessionId },
              };
              throw new Error("boom mid-stream");
            })();
          }
          return (async function* () {
            yield {
              type: "chunk",
              chunkKey: `${activeRun.id}:started`,
              chunk: { type: "RUN_STARTED", runId: activeRun.id, threadId: activeRun.sessionId },
            };
            yield { type: "completed", finalMessage: { parts: [{ type: "text", text: "ok" }] } };
          })();
        },
      };
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
          seedFixture: true,
        },
        engines: new Map([["fixture", engine]]),
      });
      cleanups.push(async () => {
        await server.close();
        tempDb.cleanup();
      });

      const { bot, session } = server.seededFixture!;
      server.store.enqueueSessionEvent({
        id: "evt-next",
        botId: bot.id,
        sessionId: session.id,
        kind: "script.finished",
        payload: { n: 2 },
      });
      const { run } = await server.commands.admitRun({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: `throw-${mode}`,
        input: { parts: [{ type: "text", text: "go" }] },
      });

      await waitUntil(
        () =>
          server.store.getRun(run.id)?.status === "failed" &&
          server.store.listPendingSessionEvents().length === 0,
        { timeoutMs: 3_000, label: "throwing engine ended Run and delivered next event" },
      );

      const terminal = server.store
        .readRunEventsAfter(run.id, 0, 100)
        .filter((event) => event.isTerminal)
        .map((event) => event.chunk as { type: string; code: string; message: string });
      expect({
        status: server.store.getRun(run.id)?.status,
        terminal: terminal.map(({ type, code, message }) => ({ type, code, message })),
        pending: server.store.listPendingSessionEvents(),
      }).toEqual({
        status: "failed",
        terminal: [
          {
            type: "RUN_ERROR",
            code: ENGINE_EXECUTION_FAILED_CODE,
            message: mode === "throw-sync" ? "boom sync" : "boom mid-stream",
          },
        ],
        pending: [],
      });
    },
    30_000,
  );
});
