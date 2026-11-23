import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type {
  Approval,
  CloudEvent,
  DeliveryResult,
  OutboxDestination,
  OutboxSink,
  Run,
  RunAdmission,
} from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { parseServerConfig } from "../../src/config";
import { startServer } from "../../src/main";
import { createOutboxSender } from "../../src/messaging/index";
import { createTempDatabase } from "../fixtures/restate-harness";
import { ensureScriptGuest } from "../fixtures/script-host";

const cleanups: (() => Promise<void> | void)[] = [];
let guestArtifactPath = "";

beforeAll(async () => {
  guestArtifactPath = await ensureScriptGuest();
}, 120_000);

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

function makeClock(iso: string): {
  readonly now: () => Date;
  readonly advanceMs: (ms: number) => void;
} {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

function seedOutboxFixture(store: SqliteStore) {
  const bot = store.createBot({
    id: "bot-outbox",
    name: "Outbox Fixture Bot",
    persona: "Deterministic coworker.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({
    id: "sess-outbox-1",
    botId: bot.id,
    title: "Outbox Session 1",
    engine: "fixture",
  });
  const binding = store.upsertChannelBinding({
    id: "bind-fixture-1",
    integration: "fixture",
    externalChatId: "dest-chat-1",
    externalActorId: "dest-actor-1",
    botId: bot.id,
    sessionId: session.id,
    enabled: true,
  });
  return { bot, session, binding };
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 3_000,
  intervalMs = 15,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

describe("serialize outbox delivery with backoff, restart resumption, and disabled-sink retention", () => {
  it("retains rows when sink is disabled, serializes concurrent flushes, and resumes retryable rows across restart with stable event ID", async () => {
    const temp = createTempDatabase("der-msg-outbox-");
    const clock = makeClock("2026-11-22T17:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    cleanups.push(() => {
      store.close();
      temp.cleanup();
    });

    const { bot, session, binding } = seedOutboxFixture(store);
    const { run } = await store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "web",
      idempotencyKey: "outbox-test-1",
      input: { parts: [{ type: "text", text: "hello" }] },
    });
    const finished = await store.finishRun({
      runId: run.id,
      status: "completed",
      terminalEvent: {
        chunkKey: `${run.id}:terminal`,
        chunk: { type: "RUN_FINISHED", runId: run.id },
      },
      finalMessageParts: [{ type: "text", text: "Delivered via outbox." }],
    });
    expect(finished.outboxEvents).toHaveLength(1);
    const rowId = finished.outboxEvents[0]!.id;
    const stableEventId = finished.outboxEvents[0]!.eventId;

    const disabledSender = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks: new Map(),
      now: clock.now,
    });
    const disabledReport = await disabledSender.flushOnce();
    expect(disabledReport).toMatchObject({ attempted: 0, delivered: 0, retained: 1 });
    expect(store.listOutboxEvents({ bindingId: binding.id })[0]?.state).toBe("pending");

    const seenEventIds: string[] = [];
    const seenTargets: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let attemptNumber = 0;

    const fakeSink: OutboxSink = {
      kind: "fixture",
      async deliver(destination: OutboxDestination, event: CloudEvent): Promise<DeliveryResult> {
        attemptNumber += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        seenEventIds.push(event.id);
        seenTargets.push(destination.target);
        await Bun.sleep(20);
        inFlight -= 1;

        if (attemptNumber === 1) {
          return {
            status: "retryable",
            retryAfterMs: 5_000,
            detail: "Lost HTTP response from sink (ambiguous delivery).",
          };
        }
        return {
          status: "delivered",
          externalMessageId: "sink-msg-901",
          deliveredAt: "2026-11-22T17:00:06Z",
        };
      },
    };

    const sinks = new Map<string, OutboxSink>([[fakeSink.kind, fakeSink]]);
    const firstSender = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks,
      now: clock.now,
    });

    const [firstReport, concurrentReport] = await Promise.all([
      firstSender.flushOnce(),
      firstSender.flushOnce(),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(firstReport.retrying + concurrentReport.retrying).toBe(1);

    const retryingRow = store.listOutboxEvents({ eventId: stableEventId })[0];
    expect(retryingRow).toMatchObject({
      id: rowId,
      eventId: stableEventId,
      state: "retrying",
      attempts: 1,
      nextRetryAt: "2026-11-22T17:00:05.000Z",
    });

    const restartedSender = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks,
      now: clock.now,
    });
    clock.advanceMs(3_000);
    expect((await restartedSender.flushOnce()).attempted).toBe(0);

    clock.advanceMs(3_000);
    const resumedReport = await restartedSender.flushOnce();
    expect(resumedReport).toMatchObject({ attempted: 1, delivered: 1, retrying: 0, failed: 0 });
    expect(seenEventIds).toEqual([stableEventId, stableEventId]);
    expect(seenTargets).toEqual(["dest-chat-1", "dest-chat-1"]);
    expect(store.listOutboxEvents({ eventId: stableEventId })[0]).toMatchObject({
      id: rowId,
      eventId: stableEventId,
      state: "delivered",
      attempts: 2,
      deliveredAt: "2026-11-22T17:00:06Z",
    });
  });

  it("records terminal_failure permanently without further retries", async () => {
    const temp = createTempDatabase("der-msg-terminal-");
    const clock = makeClock("2026-11-22T18:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    cleanups.push(() => {
      store.close();
      temp.cleanup();
    });

    const { bot, session } = seedOutboxFixture(store);
    const { run } = await store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "web",
      idempotencyKey: "outbox-terminal-1",
      input: { parts: [{ type: "text", text: "blocked" }] },
    });
    await store.finishRun({
      runId: run.id,
      status: "completed",
      terminalEvent: {
        chunkKey: `${run.id}:terminal`,
        chunk: { type: "RUN_FINISHED", runId: run.id },
      },
      finalMessageParts: [{ type: "text", text: "Blocked destination." }],
    });

    const terminalSink: OutboxSink = {
      kind: "fixture",
      async deliver() {
        return {
          status: "terminal_failure",
          code: "sink.http_403",
          detail: "Forbidden: destination rejected delivery",
        };
      },
    };

    const sender = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks: new Map([[terminalSink.kind, terminalSink]]),
      now: clock.now,
    });
    expect(await sender.flushOnce()).toMatchObject({ attempted: 1, failed: 1 });
    expect(await sender.flushOnce()).toMatchObject({ attempted: 0, failed: 0 });
    expect(store.listOutboxEvents()[0]).toMatchObject({
      state: "failed",
      attempts: 1,
      lastError: "sink.http_403: Forbidden: destination rejected delivery",
    });
  });

  it("converts unexpected sink exceptions into retryable backoff without losing the outbox row", async () => {
    const temp = createTempDatabase("der-msg-throw-");
    const clock = makeClock("2026-11-22T19:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    cleanups.push(() => {
      store.close();
      temp.cleanup();
    });

    const { bot, session } = seedOutboxFixture(store);
    const { run } = await store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "web",
      idempotencyKey: "outbox-throw-1",
      input: { parts: [{ type: "text", text: "boom" }] },
    });
    await store.finishRun({
      runId: run.id,
      status: "completed",
      terminalEvent: {
        chunkKey: `${run.id}:terminal`,
        chunk: { type: "RUN_FINISHED", runId: run.id },
      },
      finalMessageParts: [{ type: "text", text: "Retry after throw." }],
    });

    const throwingSink: OutboxSink = {
      kind: "fixture",
      async deliver() {
        throw new Error("socket reset by peer");
      },
    };

    const sender = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks: new Map([[throwingSink.kind, throwingSink]]),
      initialBackoffMs: 2_000,
      now: clock.now,
    });
    expect(await sender.flushOnce()).toMatchObject({ attempted: 1, retrying: 1 });
    expect(store.listOutboxEvents()[0]).toMatchObject({
      state: "retrying",
      attempts: 1,
      nextRetryAt: "2026-11-22T19:00:02.000Z",
      lastError: "Delivery raised unexpected error: socket reset by peer",
    });
  });
});

describe("wire generic outbox config and OutboxSink delivery into server startup", () => {
  it("parses generic outbox polling and backoff environment variables with defaults", () => {
    const defaults = parseServerConfig(undefined, {});
    expect(defaults.outboxPollIntervalMs).toBe(500);
    expect(defaults.outboxInitialBackoffMs).toBe(1_000);
    expect(defaults.outboxMaxBackoffMs).toBe(60_000);

    const parsed = parseServerConfig(undefined, {
      DER_OUTBOX_POLL_INTERVAL_MS: "250",
      DER_OUTBOX_INITIAL_BACKOFF_MS: "1500",
      DER_OUTBOX_MAX_BACKOFF_MS: "30000",
    });
    expect(parsed.outboxPollIntervalMs).toBe(250);
    expect(parsed.outboxInitialBackoffMs).toBe(1_500);
    expect(parsed.outboxMaxBackoffMs).toBe(30_000);
  });

  it("delivers approval and chat reply CloudEvents through registered OutboxSink without starting a Restate listener in direct mode", async () => {
    const temp = createTempDatabase("der-outbox-e2e-");
    const deliveredEvents: { readonly target: string; readonly event: CloudEvent }[] = [];

    const fixtureSink: OutboxSink = {
      kind: "fixture",
      async deliver(destination, event) {
        deliveredEvents.push({ target: destination.target, event });
        return {
          status: "delivered",
          externalMessageId: `ext-${deliveredEvents.length}`,
          deliveredAt: "2026-11-22T20:00:00Z",
        };
      },
    };

    const server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateMode: "direct",
        databasePath: temp.dbPath,
        memoryProjectionDir: join(temp.dir, "memory"),
        skillsRootDir: join(temp.dir, "skills"),
        workspaceRootDir: join(temp.dir, "workspaces"),
        seedFixture: true,
        enabledEngines: ["fixture"],
        scriptGuestArtifactPath: guestArtifactPath,
        outboxPollIntervalMs: 20,
        outboxInitialBackoffMs: 20,
        outboxMaxBackoffMs: 100,
      },
      outboxSinks: [fixtureSink],
    });

    cleanups.push(async () => {
      await server.close();
      temp.cleanup();
    });

    expect(server.restateUrl).toBeUndefined();

    const botId = server.seededFixture!.bot.id;
    const sessionId = server.seededFixture!.session.id;

    const admitRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "outbox-e2e-1",
      },
      body: JSON.stringify({
        input: { parts: [{ type: "text", text: "porch-light" }] },
      }),
    });
    expect(admitRes.status).toBe(202);
    const admission = (await admitRes.json()) as RunAdmission;

    await waitForCondition(
      () => deliveredEvents.some((entry) => entry.event.type === "der.approval.requested"),
      5_000,
    );

    const runRes = await fetch(`${server.url}/api/runs/${admission.run.id}`);
    const runBody = (await runRes.json()) as { run: Run; approval: Approval | null };
    expect(runBody.approval).not.toBeNull();

    const decideRes = await fetch(`${server.url}/api/approvals/${runBody.approval!.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        sessionId,
        runId: admission.run.id,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(decideRes.status).toBe(200);

    await waitForCondition(
      () => deliveredEvents.some((entry) => entry.event.type === "der.chat.replied"),
      5_000,
    );

    expect(deliveredEvents.map((entry) => entry.event.type)).toEqual([
      "der.approval.requested",
      "der.chat.replied",
    ]);
    expect(deliveredEvents[0]?.target).toBe("fixture-chat-1");
    expect(deliveredEvents[1]?.target).toBe("fixture-chat-1");
  });

  it("persists a custom webhook sink kind in SQLite and drains it cleanly through OutboxSender", async () => {
    const temp = createTempDatabase("der-webhook-outbox-");
    const clock = makeClock("2026-11-22T21:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    cleanups.push(() => {
      store.close();
      temp.cleanup();
    });

    const bot = store.createBot({
      id: "bot-webhook",
      name: "Webhook Bot",
      persona: "Concise",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
    });
    const session = store.createSession({
      id: "sess-webhook",
      botId: bot.id,
      title: "Webhook Session",
      engine: "fixture",
    });
    const binding = store.upsertChannelBinding({
      id: "bind-webhook-1",
      integration: "webhook",
      externalChatId: "https://hooks.example.invalid/events",
      externalActorId: "webhook-target",
      botId: bot.id,
      sessionId: session.id,
      enabled: true,
    });

    const { run } = await store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "web",
      idempotencyKey: "webhook-drain-1",
      input: { parts: [{ type: "text", text: "Ping webhook" }] },
    });
    await store.finishRun({
      runId: run.id,
      status: "completed",
      terminalEvent: {
        chunkKey: `${run.id}:terminal`,
        chunk: { type: "RUN_FINISHED", runId: run.id },
      },
      finalMessageParts: [{ type: "text", text: "Delivered to custom webhook sink." }],
    });

    const received: { readonly kind: string; readonly target: string; readonly type: string }[] =
      [];
    const webhookSink: OutboxSink = {
      kind: "webhook",
      async deliver(destination, event) {
        received.push({ kind: destination.kind, target: destination.target, type: event.type });
        return {
          status: "delivered",
          externalMessageId: "wh-1",
          deliveredAt: "2026-11-22T21:00:01Z",
        };
      },
    };

    const sender = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks: new Map([[webhookSink.kind, webhookSink]]),
      now: clock.now,
    });

    expect(await sender.flushOnce()).toMatchObject({
      attempted: 1,
      delivered: 1,
      retrying: 0,
      failed: 0,
      retained: 0,
    });
    expect(received).toEqual([
      {
        kind: "webhook",
        target: "https://hooks.example.invalid/events",
        type: "der.chat.replied",
      },
    ]);
    expect(store.listOutboxEvents({ bindingId: binding.id })[0]?.state).toBe("delivered");
  });
});
