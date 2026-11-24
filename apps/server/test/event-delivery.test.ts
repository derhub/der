import { afterEach, describe, expect, it } from "bun:test";
import { formatUtcTimestamp, type JsonValue, type RunRequest } from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { createEventDelivery } from "#events/event-delivery";
import { seedFixtureRecords, startServer, type RunningServer } from "#main";
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
  await store.finishRun({
    runId,
    status: "completed",
    terminalEvent: { chunkKey: `${runId}:terminal`, chunk: { type: "RUN_FINISHED", runId } },
  });
}

function eventRuns(store: SqliteStore) {
  return store.database.db
    .query<{ id: string; status: string }, []>(
      "SELECT id, status FROM runs WHERE origin = 'event' ORDER BY rowid",
    )
    .all();
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
    const { store, deliver } = openStore(undefined, 200);
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
      fits: new TextEncoder().encode(part!.text).byteLength <= 200,
    }).toEqual({
      text: `{"status":"failed","result":{"ok":false,"error":{"kind":"capability","message":"${"z".repeat(68)} [message truncated]"},"logs":["[logs truncated]"]}}`,
      fits: true,
    });
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
});
