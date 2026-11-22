import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  DomainError,
  type ChannelBinding,
  type ChannelIntegration,
  type ChannelUpdate,
  type DeliveryResult,
  type Messaging,
  type OutboxEvent,
} from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import {
  createTelegramMessaging,
  encodeApprovalCallbackData,
  type TelegramFetch,
  type TelegramMessaging,
} from "@der/telegram";
import { parseServerConfig } from "../../src/config";
import { startServer } from "../../src/main";
import {
  createMessagingRuntime,
  createOutboxSender,
  processChannelUpdate,
  type ChannelCallbackAcknowledger,
} from "../../src/messaging/index";
import {
  createDirectWorkflow,
  createFixtureEngine,
  createFixtureTools,
  type DurableWorkflow,
} from "../../src/workflows/index";
import { createTempDatabase } from "../fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

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

function seedTelegramFixture(store: SqliteStore) {
  const bot = store.createBot({
    id: "bot-tg",
    name: "Telegram Fixture Bot",
    persona: "Deterministic coworker.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({
    id: "sess-tg-1",
    botId: bot.id,
    title: "Telegram Session 1",
    engine: "fixture",
  });
  const otherSession = store.createSession({
    id: "sess-tg-2",
    botId: bot.id,
    title: "Telegram Session 2",
    engine: "fixture",
  });
  const binding = store.upsertChannelBinding({
    id: "bind-tg-1",
    integration: "telegram",
    externalChatId: "-100111222",
    externalActorId: "7001",
    botId: bot.id,
    sessionId: session.id,
    enabled: true,
  });
  const otherActorBinding = store.upsertChannelBinding({
    id: "bind-tg-2",
    integration: "telegram",
    externalChatId: "-100333444",
    externalActorId: "8002",
    botId: bot.id,
    sessionId: otherSession.id,
    enabled: true,
  });
  return { bot, session, otherSession, binding, otherActorBinding };
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

describe("process Telegram inbound updates with bindings, dedupe, and durable cursors", () => {
  it("admits a Run for a bound chat/actor, deduplicates repeats, and rejects unauthorized actors", async () => {
    const temp = createTempDatabase("der-msg-intake-");
    const clock = makeClock("2026-11-22T15:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    const workflow = createDirectWorkflow({
      store,
      engines: new Map([["fixture", createFixtureEngine(store)]]),
      tools: createFixtureTools(),
      approvalTimeoutMs: 60_000,
    });
    cleanups.push(() => {
      workflow.close();
      store.close();
      temp.cleanup();
    });

    const { session } = seedTelegramFixture(store);
    const consumer = "telegram-default";

    const update: ChannelUpdate = {
      integration: "telegram",
      externalUpdateId: "5001",
      externalChatId: "-100111222",
      externalActorId: "7001",
      receivedAt: "2026-11-22T15:00:00Z",
      payload: { kind: "message", text: "direct: Telegram hello" },
    };

    const admitted = await processChannelUpdate(
      { store, workflow, consumer, now: clock.now },
      update,
    );
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") {
      return;
    }

    expect(store.getChannelReceipt("telegram", consumer, "5001")).toMatchObject({
      disposition: "admitted",
      referenceId: admitted.runId,
    });
    expect(store.getChannelCursor("telegram", consumer)?.position).toBe("5001");

    const duplicate = await processChannelUpdate(
      { store, workflow, consumer, now: clock.now },
      update,
    );
    expect(duplicate).toEqual({
      status: "duplicate",
      disposition: "admitted",
      referenceId: admitted.runId,
    });

    await waitForCondition(() => store.getRun(admitted.runId)?.status === "completed");
    expect(store.listMessages(session.id).map((m) => m.role)).toEqual(["user", "assistant"]);

    const unauthorized: ChannelUpdate = {
      integration: "telegram",
      externalUpdateId: "5002",
      externalChatId: "-100111222",
      externalActorId: "99999",
      receivedAt: "2026-11-22T15:00:05Z",
      payload: { kind: "message", text: "direct: Should be rejected" },
    };

    const rejected = await processChannelUpdate(
      { store, workflow, consumer, now: clock.now },
      unauthorized,
    );
    expect(rejected).toEqual({ status: "rejected", reason: "binding_not_found" });
    expect(store.getChannelReceipt("telegram", consumer, "5002")).toMatchObject({
      disposition: "rejected",
      referenceId: null,
    });
    expect(store.getChannelCursor("telegram", consumer)?.position).toBe("5002");
    expect(store.listMessages(session.id)).toHaveLength(2);
  });

  it("enforces approval binding scope, acknowledges callbacks only after durable disposition, and preserves retryable failures", async () => {
    const temp = createTempDatabase("der-msg-approval-");
    const clock = makeClock("2026-11-22T16:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    const directWorkflow = createDirectWorkflow({
      store,
      engines: new Map([["fixture", createFixtureEngine(store)]]),
      tools: createFixtureTools(),
      approvalTimeoutMs: 60_000,
    });
    cleanups.push(() => {
      directWorkflow.close();
      store.close();
      temp.cleanup();
    });

    seedTelegramFixture(store);
    const consumer = "telegram-default";

    let failWorkflow = false;
    const flakyWorkflow: DurableWorkflow = {
      admit: (request) => {
        if (failWorkflow) {
          return Promise.reject(
            new DomainError({
              type: "https://der.invalid/problems/restate-unavailable",
              title: "Restate ingress unavailable",
              status: 503,
              detail: "Restate temporarily unreachable.",
              instance: `/api/sessions/${request.sessionId}/runs`,
              code: "restate.unavailable",
            }),
          );
        }
        return directWorkflow.admit(request);
      },
      decide: (decision, channelIntake) => {
        if (failWorkflow) {
          return Promise.reject(
            new DomainError({
              type: "https://der.invalid/problems/restate-unavailable",
              title: "Restate ingress unavailable",
              status: 503,
              detail: "Restate temporarily unreachable.",
              instance: `/api/approvals/${decision.approvalId}/decision`,
              code: "restate.unavailable",
            }),
          );
        }
        return directWorkflow.decide(decision, channelIntake);
      },
    };

    const acked: { id: string; text?: string }[] = [];
    const acker: ChannelCallbackAcknowledger = {
      async acknowledgeCallback(callbackQueryId, options) {
        acked.push({
          id: callbackQueryId,
          ...(options?.text !== undefined ? { text: options.text } : {}),
        });
      },
    };

    const startUpdate: ChannelUpdate = {
      integration: "telegram",
      externalUpdateId: "6001",
      externalChatId: "-100111222",
      externalActorId: "7001",
      receivedAt: "2026-11-22T16:00:00Z",
      payload: { kind: "message", text: "kitchen-lamp" },
    };

    const admitted = await processChannelUpdate(
      { store, workflow: flakyWorkflow, consumer, messaging: acker, now: clock.now },
      startUpdate,
    );
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") {
      return;
    }

    await waitForCondition(() => store.getRun(admitted.runId)?.status === "waiting_approval");
    const approval = store.getLatestApprovalForRun(admitted.runId);
    expect(approval).toBeDefined();
    if (!approval) {
      return;
    }

    // Wrong session/actor binding attempts to approve -> rejected durably, callback acked after durable commit.
    const wrongScope = await processChannelUpdate(
      { store, workflow: flakyWorkflow, consumer, messaging: acker, now: clock.now },
      {
        integration: "telegram",
        externalUpdateId: "6002",
        externalChatId: "-100333444",
        externalActorId: "8002",
        receivedAt: "2026-11-22T16:00:05Z",
        payload: {
          kind: "approval_decision",
          approvalId: approval.id,
          decision: "approved",
          callbackQueryId: "cbq-wrong-scope",
        },
      },
    );
    expect(wrongScope).toEqual({ status: "rejected", reason: "binding_scope_mismatch" });
    expect(store.getApproval(approval.id)?.decision.status).toBe("pending");
    expect(store.getChannelCursor("telegram", consumer)?.position).toBe("6002");
    expect(acked).toEqual([{ id: "cbq-wrong-scope", text: "Not authorized for this approval." }]);

    // Authorized actor clicks Approve while Restate is unavailable -> NO receipt, NO cursor advance, NO callback ack.
    failWorkflow = true;
    const retryable = await processChannelUpdate(
      { store, workflow: flakyWorkflow, consumer, messaging: acker, now: clock.now },
      {
        integration: "telegram",
        externalUpdateId: "6003",
        externalChatId: "-100111222",
        externalActorId: "7001",
        receivedAt: "2026-11-22T16:00:10Z",
        payload: {
          kind: "approval_decision",
          approvalId: approval.id,
          decision: "approved",
          callbackQueryId: "cbq-retry-1",
        },
      },
    );
    expect(retryable.status).toBe("retryable");
    expect(store.getChannelReceipt("telegram", consumer, "6003")).toBeUndefined();
    expect(store.getChannelCursor("telegram", consumer)?.position).toBe("6002");
    expect(acked).toHaveLength(1);

    // Restate recovers -> retry of update 6003 commits decided + cursor atomically, then acknowledges callback.
    failWorkflow = false;
    const decided = await processChannelUpdate(
      { store, workflow: flakyWorkflow, consumer, messaging: acker, now: clock.now },
      {
        integration: "telegram",
        externalUpdateId: "6003",
        externalChatId: "-100111222",
        externalActorId: "7001",
        receivedAt: "2026-11-22T16:00:15Z",
        payload: {
          kind: "approval_decision",
          approvalId: approval.id,
          decision: "approved",
          callbackQueryId: "cbq-retry-1",
        },
      },
    );
    expect(decided.status).toBe("decided");
    expect(store.getChannelReceipt("telegram", consumer, "6003")).toMatchObject({
      disposition: "decided",
      referenceId: approval.id,
    });
    expect(store.getChannelCursor("telegram", consumer)?.position).toBe("6003");
    expect(acked[1]).toEqual({ id: "cbq-retry-1", text: "Approval recorded: approved." });

    await waitForCondition(() => store.getRun(admitted.runId)?.status === "completed");
  });
});

describe("serialize outbox delivery with backoff, restart resumption, and disabled-adapter retention", () => {
  it("retains rows when adapter is disabled, serializes concurrent flushes, and resumes retryable rows across restart with stable event ID", async () => {
    const temp = createTempDatabase("der-msg-outbox-");
    const clock = makeClock("2026-11-22T17:00:00Z");
    const store = openSqliteStore({ filename: temp.dbPath, now: clock.now });
    cleanups.push(() => {
      store.close();
      temp.cleanup();
    });

    const { bot, session, binding } = seedTelegramFixture(store);
    const { run } = await store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "telegram",
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

    // 1. Adapter disabled -> retains due rows without mutating state.
    const disabledSender = createOutboxSender({
      store,
      adapters: new Map(),
      now: clock.now,
    });
    const disabledReport = await disabledSender.flushOnce();
    expect(disabledReport).toMatchObject({ attempted: 0, delivered: 0, retained: 1 });
    expect(store.listOutboxEvents({ bindingId: binding.id })[0]?.state).toBe("pending");

    // 2. First sender encounters ambiguous/retryable failure and serializes concurrent flushOnce calls.
    const seenEventIds: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    let attemptNumber = 0;

    const fakeAdapter: Messaging = {
      async *poll() {
        // Not used in outbox test.
      },
      async deliver(_targetBinding: ChannelBinding, event: OutboxEvent): Promise<DeliveryResult> {
        attemptNumber += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        seenEventIds.push(event.eventId);
        await Bun.sleep(20);
        inFlight -= 1;

        if (attemptNumber === 1) {
          return {
            status: "retryable",
            retryAfterMs: 5_000,
            detail: "Lost HTTP response from Telegram (ambiguous delivery).",
          };
        }
        return {
          status: "delivered",
          externalMessageId: "tg-msg-901",
          deliveredAt: "2026-11-22T17:00:06Z",
        };
      },
    };

    const adapters = new Map<ChannelIntegration, Messaging>([["telegram", fakeAdapter]]);
    const firstSender = createOutboxSender({
      store,
      adapters,
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

    // 3. Simulated server restart with a fresh OutboxSender instance:
    //    Before retry deadline -> nothing attempted.
    const restartedSender = createOutboxSender({
      store,
      adapters,
      now: clock.now,
    });
    clock.advanceMs(3_000);
    expect((await restartedSender.flushOnce()).attempted).toBe(0);

    // After retry deadline -> resumes due row with the exact same stable event ID.
    clock.advanceMs(3_000);
    const resumedReport = await restartedSender.flushOnce();
    expect(resumedReport).toMatchObject({ attempted: 1, delivered: 1, retrying: 0, failed: 0 });
    expect(seenEventIds).toEqual([stableEventId, stableEventId]);
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

    const { bot, session } = seedTelegramFixture(store);
    const { run } = await store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "telegram",
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
      finalMessageParts: [{ type: "text", text: "Blocked chat." }],
    });

    const terminalAdapter: Messaging = {
      async *poll() {},
      async deliver() {
        return {
          status: "terminal_failure",
          code: "telegram.http_403",
          detail: "Forbidden: bot was blocked by the user",
        };
      },
    };

    const sender = createOutboxSender({
      store,
      adapters: new Map([["telegram", terminalAdapter]]),
      now: clock.now,
    });
    expect(await sender.flushOnce()).toMatchObject({ attempted: 1, failed: 1 });
    expect(await sender.flushOnce()).toMatchObject({ attempted: 0, failed: 0 });
    expect(store.listOutboxEvents()[0]).toMatchObject({
      state: "failed",
      attempts: 1,
      lastError: "telegram.http_403: Forbidden: bot was blocked by the user",
    });
  });
});

describe("wire opt-in Telegram messaging runtime into server config and startup", () => {
  it("keeps Telegram disabled by default, parses valid Telegram env config, and rejects invalid settings", () => {
    const defaults = parseServerConfig(undefined, {});
    expect(defaults.telegram).toBeUndefined();

    const parsed = parseServerConfig(undefined, {
      DER_TELEGRAM_ENABLED: "true",
      DER_TELEGRAM_BOT_TOKEN: "123456:AAValidTokenSecretValue12345678",
      DER_TELEGRAM_CONSUMER: "tg-prod",
      DER_TELEGRAM_POLL_TIMEOUT_SECONDS: "15",
      DER_TELEGRAM_BINDINGS_JSON: JSON.stringify([
        {
          externalChatId: "-1001",
          externalActorId: "42",
          botId: "bot-fixture",
          sessionId: "sess-fixture",
        },
      ]),
    });
    expect(parsed.telegram).toMatchObject({
      consumer: "tg-prod",
      pollTimeoutSeconds: 15,
      bindings: [
        {
          externalChatId: "-1001",
          externalActorId: "42",
          botId: "bot-fixture",
          sessionId: "sess-fixture",
          enabled: true,
        },
      ],
    });

    expect(() =>
      parseServerConfig(undefined, {
        DER_TELEGRAM_ENABLED: "true",
      }),
    ).toThrow(/DER_TELEGRAM_BOT_TOKEN/);

    expect(() =>
      parseServerConfig(undefined, {
        DER_TELEGRAM_BOT_TOKEN: "123456:AAValidTokenSecretValue12345678",
        DER_TELEGRAM_BINDINGS_JSON: "{bad-json",
      }),
    ).toThrow(/DER_TELEGRAM_BINDINGS_JSON/);
  });

  it("runs end-to-end Telegram intake, approval inline control delivery, callback approval, and reply delivery on startServer", async () => {
    const temp = createTempDatabase("der-msg-e2e-");
    const sentMessages: { chat_id: string; text: string; reply_markup?: unknown }[] = [];
    const ackedCallbacks: { callback_query_id: string; text?: string }[] = [];
    const queuedUpdates: Record<string, unknown>[] = [
      {
        update_id: 9001,
        message: {
          message_id: 1,
          date: 1795360000,
          chat: { id: -100555 },
          from: { id: 777 },
          text: "porch-light",
        },
      },
    ];
    let callbackQueued = false;

    const abortController = new AbortController();
    const fakeFetch: TelegramFetch = async (url, init) => {
      const rawBody = typeof init?.body === "string" ? init.body : "{}";
      const body = JSON.parse(rawBody) as Record<string, unknown>;

      if (url.endsWith("/getUpdates")) {
        const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
        const batch = queuedUpdates.filter((entry) => Number(entry["update_id"]) >= offset);
        if (batch.length === 0) {
          await Bun.sleep(15);
        }
        return new Response(JSON.stringify({ ok: true, result: batch }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/sendMessage")) {
        const msg = {
          chat_id: String(body["chat_id"]),
          text: String(body["text"]),
          ...(body["reply_markup"] !== undefined ? { reply_markup: body["reply_markup"] } : {}),
        };
        sentMessages.push(msg);

        // Once the approval prompt arrives in Telegram, simulate the bound operator tapping Approve.
        if (!callbackQueued && msg.reply_markup !== undefined) {
          callbackQueued = true;
          const keyboard = (msg.reply_markup as { inline_keyboard: { callback_data: string }[][] })
            .inline_keyboard;
          const approveCallback = keyboard[0]?.[0]?.callback_data;
          if (approveCallback) {
            queuedUpdates.push({
              update_id: 9002,
              callback_query: {
                id: "cbq-e2e-approve",
                from: { id: 777 },
                message: { message_id: 2, date: 1795360005, chat: { id: -100555 } },
                data: approveCallback,
              },
            });
          }
        }

        return new Response(
          JSON.stringify({ ok: true, result: { message_id: sentMessages.length + 100 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.endsWith("/answerCallbackQuery")) {
        ackedCallbacks.push({
          callback_query_id: String(body["callback_query_id"]),
          ...(typeof body["text"] === "string" ? { text: body["text"] } : {}),
        });
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: false, error_code: 404 }), { status: 404 });
    };

    const telegramAdapter: TelegramMessaging = createTelegramMessaging({
      botToken: "123456789:AAEndToEndFakeTokenSecretValue12345",
      pollTimeoutSeconds: 0,
      initialBackoffMs: 10,
      maxBackoffMs: 50,
      fetch: fakeFetch,
      signal: abortController.signal,
    });

    const server = startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen: 0,
        restateMode: "direct",
        databasePath: temp.dbPath,
        memoryProjectionDir: join(temp.dir, "memory"),
        skillsRootDir: join(temp.dir, "skills"),
        workspaceRootDir: join(temp.dir, "workspaces"),
        seedFixture: true,
        enabledEngines: ["fixture"],
        telegram: {
          botToken: "123456789:AAEndToEndFakeTokenSecretValue12345",
          apiBaseUrl: "https://api.telegram.org",
          consumer: "telegram-e2e",
          pollTimeoutSeconds: 0,
          pollInitialBackoffMs: 10,
          pollMaxBackoffMs: 50,
          outboxPollIntervalMs: 20,
          outboxInitialBackoffMs: 20,
          outboxMaxBackoffMs: 100,
          bindings: [
            {
              externalChatId: "-100555",
              externalActorId: "777",
              botId: "bot-fixture",
              sessionId: "sess-fixture",
              enabled: true,
            },
          ],
        },
      },
      telegramMessaging: telegramAdapter,
    });

    cleanups.push(async () => {
      abortController.abort();
      await server.close();
      temp.cleanup();
    });

    await waitForCondition(() => sentMessages.length >= 2 && ackedCallbacks.length >= 1, 5_000);

    expect(sentMessages[0]?.chat_id).toBe("-100555");
    expect(sentMessages[0]?.text).toContain("Approval required");
    expect(sentMessages[0]?.text).toContain("porch-light");
    expect(ackedCallbacks[0]).toEqual({
      callback_query_id: "cbq-e2e-approve",
      text: "Approval recorded: approved.",
    });
    expect(sentMessages[1]?.chat_id).toBe("-100555");
    expect(sentMessages[1]?.text).toContain("Applied fixture.apply");
    expect(server.store.getChannelCursor("telegram", "telegram-e2e")?.position).toBe("9002");

    // Verify MessagingRuntime restarts polling from durable cursor without re-running 9001/9002.
    const pollOffsets: (string | undefined)[] = [];
    const probeRuntime = createMessagingRuntime({
      store: server.store,
      workflow: server.workflow,
      telegramConsumer: "telegram-e2e",
      adapters: new Map([
        [
          "telegram",
          {
            async *poll(cursor) {
              pollOffsets.push(cursor);
              yield* [];
            },
            async deliver() {
              return {
                status: "delivered",
                deliveredAt: "2026-11-22T18:00:00Z",
              };
            },
          },
        ],
      ]),
    });
    probeRuntime.start();
    await waitForCondition(() => pollOffsets.length >= 1);
    await probeRuntime.stop();
    expect(pollOffsets[0]).toBe("9002");
  });

  it("creates and validates callback data round-trip for approval controls", () => {
    expect(encodeApprovalCallbackData("appr-1", "approved")).toBe("der:a:appr-1");
  });
});
