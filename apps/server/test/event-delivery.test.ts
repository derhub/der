import { afterEach, describe, expect, it } from "bun:test";
import type { RunRequest } from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { createEventDelivery } from "#events/event-delivery";
import { createTempDatabase } from "./fixtures/restate-harness";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function openStore(eventChainLimit?: number) {
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
    maxResultBytes: 65_536,
  });
  return { store, deliver };
}

function enqueue(store: SqliteStore, id: string, payload: Record<string, number> = { n: 1 }) {
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

  it("yields one Run when an admitted event was never marked delivered", async () => {
    const { store, deliver } = openStore(1);
    enqueue(store, "evt-1", { n: 1 });
    const crashed = await store.admit({
      botId: "bot-1",
      sessionId: "sess-1",
      origin: "event",
      idempotencyKey: "evt-1",
      input: { parts: [{ type: "text", text: '{"n":1}' }] },
    });
    await finish(store, crashed.run.id);

    await deliver();
    await deliver();

    expect(eventRuns(store).map((run) => run.id)).toEqual([crashed.run.id]);
    expect(store.listPendingSessionEvents()).toEqual([]);
    expect(
      store.database.db
        .query<{ run_id: string }, []>("SELECT run_id FROM session_events WHERE id = 'evt-1'")
        .get(),
    ).toEqual({ run_id: crashed.run.id });
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
