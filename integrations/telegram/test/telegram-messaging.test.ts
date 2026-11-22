import { describe, expect, it } from "bun:test";
import {
  CLOUD_EVENT_SPEC_VERSION,
  CLOUD_EVENT_TYPES,
  type ChannelBinding,
  type ChannelUpdate,
  type OutboxEvent,
} from "@der/domain";
import {
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TelegramApiError,
  TelegramConfigError,
  createTelegramMessaging,
  encodeApprovalCallbackData,
  formatOutboxMessage,
  normalizeTelegramUpdate,
  parseApprovalCallbackData,
  redactTelegramSecret,
  type TelegramFetch,
} from "../src/index";

const TEST_TOKEN = "123456789:AAFakeTelegramBotTokenSecretValue99";

function parseJsonBody(init?: RequestInit): Record<string, unknown> {
  const raw = typeof init?.body === "string" ? init.body : "{}";
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeBinding(overrides?: Partial<ChannelBinding>): ChannelBinding {
  return {
    id: "bind-tg-1",
    integration: "telegram",
    externalChatId: "-10099887766",
    externalActorId: "44556677",
    botId: "bot-1",
    sessionId: "sess-1",
    enabled: true,
    createdAt: "2026-11-22T12:00:00Z",
    updatedAt: "2026-11-22T12:00:00Z",
    ...overrides,
  };
}

function makeChatRepliedOutbox(text: string): OutboxEvent {
  return {
    id: "outbox-chat-1",
    bindingId: "bind-tg-1",
    eventId: "chat.replied:run-1",
    envelope: {
      specversion: CLOUD_EVENT_SPEC_VERSION,
      id: "chat.replied:run-1",
      source: "/bots/bot-1",
      type: CLOUD_EVENT_TYPES.chatReplied,
      time: "2026-11-22T12:01:00Z",
      subject: "sessions/sess-1/runs/run-1",
      datacontenttype: "application/json",
      data: {
        botId: "bot-1",
        sessionId: "sess-1",
        runId: "run-1",
        message: {
          id: "msg-2",
          botId: "bot-1",
          sessionId: "sess-1",
          ordinal: 2,
          role: "assistant",
          parts: [{ type: "text", text }],
          runId: "run-1",
          createdAt: "2026-11-22T12:01:00Z",
        },
      },
    },
    state: "pending",
    attempts: 0,
    nextRetryAt: null,
    deliveredAt: null,
    lastError: null,
    createdAt: "2026-11-22T12:01:00Z",
    updatedAt: "2026-11-22T12:01:00Z",
  };
}

function makeApprovalOutbox(approvalId = "appr_12345678-1234-4123-8123-1234567890ab"): OutboxEvent {
  return {
    id: "outbox-appr-1",
    bindingId: "bind-tg-1",
    eventId: `approval:${approvalId}`,
    envelope: {
      specversion: CLOUD_EVENT_SPEC_VERSION,
      id: `approval:${approvalId}`,
      source: "/bots/bot-1",
      type: CLOUD_EVENT_TYPES.approvalRequested,
      time: "2026-11-22T12:02:00Z",
      subject: `sessions/sess-1/runs/run-1/approvals/${approvalId}`,
      datacontenttype: "application/json",
      data: {
        botId: "bot-1",
        sessionId: "sess-1",
        runId: "run-1",
        approvalId,
        operationKind: "home-assistant",
        operationId: "light.turn_on",
        prompt: "Turn on living room lamp?",
        deadline: "2026-11-22T12:07:00Z",
      },
    },
    state: "pending",
    attempts: 0,
    nextRetryAt: null,
    deliveredAt: null,
    lastError: null,
    createdAt: "2026-11-22T12:02:00Z",
    updatedAt: "2026-11-22T12:02:00Z",
  };
}

function makeRoutineOutbox(): OutboxEvent {
  return {
    id: "outbox-rt-1",
    bindingId: "bind-tg-1",
    eventId: "routine.finished:run-rt-1",
    envelope: {
      specversion: CLOUD_EVENT_SPEC_VERSION,
      id: "routine.finished:run-rt-1",
      source: "/bots/bot-1",
      type: CLOUD_EVENT_TYPES.routineFinished,
      time: "2026-11-22T13:00:00Z",
      subject: "bots/bot-1/routines/rt-1/runs/run-rt-1",
      datacontenttype: "application/json",
      data: {
        botId: "bot-1",
        routineId: "rt-1",
        runId: "run-rt-1",
        sessionId: "sess-1",
        slot: "2026-11-22T13:00:00Z",
        outcome: "completed",
        finishedAt: "2026-11-22T13:00:05Z",
        detail: "All checks green.",
      },
    },
    state: "pending",
    attempts: 0,
    nextRetryAt: null,
    deliveredAt: null,
    lastError: null,
    createdAt: "2026-11-22T13:00:05Z",
    updatedAt: "2026-11-22T13:00:05Z",
  };
}

describe("normalize Telegram updates and encode approval callbacks", () => {
  it("redacts explicit bot tokens and Telegram token shapes from diagnostic text", () => {
    const raw = `POST https://api.telegram.org/bot${TEST_TOKEN}/sendMessage failed for 987654:BBAnotherTelegramTokenSecret12345`;
    const redacted = redactTelegramSecret(raw, TEST_TOKEN);
    expect(redacted).not.toContain(TEST_TOKEN);
    expect(redacted).not.toContain("BBAnotherTelegramTokenSecret12345");
    expect(redacted).toContain("bot[REDACTED]");
  });

  it("round-trips scoped approval callback data within the 64-byte Telegram limit", () => {
    const approvalId = "appr_12345678-1234-4123-8123-1234567890ab";
    const approveData = encodeApprovalCallbackData(approvalId, "approved");
    const denyData = encodeApprovalCallbackData(approvalId, "denied");

    expect(new TextEncoder().encode(approveData).byteLength).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    );
    expect(new TextEncoder().encode(denyData).byteLength).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    );
    expect(parseApprovalCallbackData(approveData)).toEqual({
      approvalId,
      decision: "approved",
    });
    expect(parseApprovalCallbackData(denyData)).toEqual({
      approvalId,
      decision: "denied",
    });
    expect(parseApprovalCallbackData("unrelated:payload")).toBeUndefined();
    expect(parseApprovalCallbackData("der:x:appr_1")).toBeUndefined();
    expect(() => encodeApprovalCallbackData("a".repeat(60), "approved")).toThrow(
      TelegramConfigError,
    );
  });

  it("normalizes text messages and approval callbacks while preserving opaque string IDs", () => {
    const messageUpdate = normalizeTelegramUpdate({
      update_id: 501,
      message: {
        message_id: 91,
        date: 1795348800,
        chat: { id: -10099887766, type: "supergroup" },
        from: { id: 44556677, is_bot: false, username: "operator" },
        text: "  check status  ",
      },
    });

    expect(messageUpdate).toEqual({
      integration: "telegram",
      externalUpdateId: "501",
      externalChatId: "-10099887766",
      externalActorId: "44556677",
      receivedAt: "2026-11-22T12:00:00.000Z",
      payload: {
        kind: "message",
        text: "check status",
      },
    });

    const callbackUpdate = normalizeTelegramUpdate({
      update_id: 502,
      callback_query: {
        id: "cbq-opaque-77",
        from: { id: 44556677, is_bot: false },
        message: {
          message_id: 92,
          date: 1795348860,
          chat: { id: -10099887766, type: "supergroup" },
        },
        data: encodeApprovalCallbackData("appr-42", "approved"),
      },
    });

    expect(callbackUpdate).toEqual({
      integration: "telegram",
      externalUpdateId: "502",
      externalChatId: "-10099887766",
      externalActorId: "44556677",
      receivedAt: "2026-11-22T12:01:00.000Z",
      payload: {
        kind: "approval_decision",
        approvalId: "appr-42",
        decision: "approved",
        callbackQueryId: "cbq-opaque-77",
      },
    });
  });

  it.each([
    {
      name: "bot-authored message",
      update: {
        update_id: 601,
        message: {
          message_id: 1,
          chat: { id: 10 },
          from: { id: 20, is_bot: true },
          text: "echo",
        },
      },
    },
    {
      name: "blank message text",
      update: {
        update_id: 602,
        message: {
          message_id: 2,
          chat: { id: 10 },
          from: { id: 20, is_bot: false },
          text: "   ",
        },
      },
    },
    {
      name: "unrecognized callback query payload",
      update: {
        update_id: 603,
        callback_query: {
          id: "cbq-1",
          from: { id: 20, is_bot: false },
          message: { message_id: 3, chat: { id: 10 } },
          data: "other:action",
        },
      },
    },
    {
      name: "callback query missing chat context",
      update: {
        update_id: 604,
        callback_query: {
          id: "cbq-2",
          from: { id: 20, is_bot: false },
          data: "der:a:appr-1",
        },
      },
    },
  ])("ignores unsupported Telegram update: $name", ({ update }) => {
    expect(normalizeTelegramUpdate(update)).toBeUndefined();
  });
});

describe("poll Telegram updates in order with backoff and cursor resumption", () => {
  it("resumes strictly after durable cursor, sorts updates ascending, and ignores stale updates", async () => {
    const controller = new AbortController();
    const recordedBodies: Record<string, unknown>[] = [];
    let callCount = 0;

    const fakeFetch: TelegramFetch = async (_input, init) => {
      callCount += 1;
      recordedBodies.push(parseJsonBody(init));
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 103,
                message: {
                  message_id: 3,
                  date: 1795348803,
                  chat: { id: 10 },
                  from: { id: 20 },
                  text: "second",
                },
              },
              {
                update_id: 100,
                message: {
                  message_id: 1,
                  date: 1795348800,
                  chat: { id: 10 },
                  from: { id: 20 },
                  text: "stale",
                },
              },
              {
                update_id: 101,
                message: {
                  message_id: 2,
                  date: 1795348801,
                  chat: { id: 10 },
                  from: { id: 20 },
                  text: "first",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      controller.abort();
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const telegram = createTelegramMessaging({
      botToken: TEST_TOKEN,
      pollTimeoutSeconds: 10,
      fetch: fakeFetch,
      sleep: async () => {},
      signal: controller.signal,
    });

    const received: ChannelUpdate[] = [];
    for await (const update of telegram.poll("100")) {
      received.push(update);
    }

    expect(recordedBodies[0]).toMatchObject({ offset: 101, timeout: 10 });
    expect(recordedBodies[1]).toMatchObject({ offset: 104, timeout: 10 });
    expect(received.map((u) => u.externalUpdateId)).toEqual(["101", "103"]);
    expect(received.map((u) => (u.payload.kind === "message" ? u.payload.text : ""))).toEqual([
      "first",
      "second",
    ]);
  });

  it("backs off on transient 5xx and 429 retry_after responses and recovers without losing order", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let attempt = 0;

    const fakeFetch: TelegramFetch = async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response("upstream unavailable", { status: 503 });
      }
      if (attempt === 2) {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 7 },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 201,
              message: {
                message_id: 11,
                date: 1795348900,
                chat: { id: 10 },
                from: { id: 20 },
                text: "after backoff",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const telegram = createTelegramMessaging({
      botToken: TEST_TOKEN,
      initialBackoffMs: 500,
      maxBackoffMs: 5000,
      fetch: fakeFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      signal: controller.signal,
    });

    const received: ChannelUpdate[] = [];
    for await (const update of telegram.poll(undefined)) {
      received.push(update);
      controller.abort();
    }

    expect(sleeps).toEqual([500, 7000]);
    expect(received.map((u) => u.externalUpdateId)).toEqual(["201"]);
  });

  it("rejects invalid cursor syntax and empty bot token", async () => {
    expect(() => createTelegramMessaging({ botToken: "  " })).toThrow(TelegramConfigError);

    const telegram = createTelegramMessaging({
      botToken: TEST_TOKEN,
      fetch: async () => new Response("{}"),
    });

    let caught: unknown;
    try {
      for await (const _update of telegram.poll("not-a-number")) {
        // unreachable
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramConfigError);
  });
});

describe("format and deliver CloudEvents and callback acknowledgements", () => {
  it("formats chat replies, approval requests with inline controls, and routine summaries", () => {
    const reply = formatOutboxMessage(makeChatRepliedOutbox("All lights verified."));
    expect(reply).toEqual({ text: "All lights verified." });

    const longReply = formatOutboxMessage(makeChatRepliedOutbox("x".repeat(5000)));
    expect(longReply.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_LENGTH);
    expect(longReply.text.endsWith("... [truncated]")).toBe(true);

    const approval = formatOutboxMessage(makeApprovalOutbox("appr-99"));
    expect(approval.text).toContain("home-assistant:light.turn_on");
    expect(approval.text).toContain("Turn on living room lamp?");
    expect(approval.text).toContain("2026-11-22T12:07:00Z");
    expect(approval.replyMarkup).toEqual({
      inline_keyboard: [
        [
          { text: "Approve", callback_data: encodeApprovalCallbackData("appr-99", "approved") },
          { text: "Deny", callback_data: encodeApprovalCallbackData("appr-99", "denied") },
        ],
      ],
    });

    const routine = formatOutboxMessage(makeRoutineOutbox());
    expect(routine.text).toContain("completed");
    expect(routine.text).toContain("rt-1");
    expect(routine.text).toContain("All checks green.");
  });

  it("delivers outbound CloudEvents and classifies delivered, retryable, and terminal responses while redacting token", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let mode: "ok" | "retry429" | "network" | "forbidden" = "ok";

    const fakeFetch: TelegramFetch = async (url, init) => {
      const body = parseJsonBody(init);
      calls.push({ url, body });

      if (mode === "network") {
        throw new Error(`socket closed while calling ${url}`);
      }
      if (mode === "retry429") {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: `Too Many Requests for ${TEST_TOKEN}`,
            parameters: { retry_after: 12 },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (mode === "forbidden") {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 403,
            description: `Forbidden: bot was blocked by the user (${TEST_TOKEN})`,
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 7788 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const telegram = createTelegramMessaging({
      botToken: TEST_TOKEN,
      fetch: fakeFetch,
      now: () => new Date("2026-11-22T12:10:00Z"),
    });

    const binding = makeBinding();
    const approvalEvent = makeApprovalOutbox("appr-99");

    const delivered = await telegram.deliver(binding, approvalEvent);
    expect(delivered).toEqual({
      status: "delivered",
      externalMessageId: "7788",
      deliveredAt: "2026-11-22T12:10:00.000Z",
    });
    expect(calls[0]?.body).toMatchObject({
      chat_id: binding.externalChatId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: "der:a:appr-99" },
            { text: "Deny", callback_data: "der:d:appr-99" },
          ],
        ],
      },
    });

    mode = "retry429";
    const rateLimited = await telegram.deliver(binding, approvalEvent);
    expect(rateLimited.status).toBe("retryable");
    if (rateLimited.status === "retryable") {
      expect(rateLimited.retryAfterMs).toBe(12_000);
      expect(rateLimited.detail).not.toContain(TEST_TOKEN);
    }

    mode = "network";
    const ambiguous = await telegram.deliver(binding, approvalEvent);
    expect(ambiguous.status).toBe("retryable");
    if (ambiguous.status === "retryable") {
      expect(ambiguous.detail).not.toContain(TEST_TOKEN);
    }

    mode = "forbidden";
    const terminal = await telegram.deliver(binding, approvalEvent);
    expect(terminal.status).toBe("terminal_failure");
    if (terminal.status === "terminal_failure") {
      expect(terminal.code).toBe("telegram.http_403");
      expect(terminal.detail).not.toContain(TEST_TOKEN);
    }

    const wrongBinding = await telegram.deliver(
      makeBinding({ integration: "fixture" }),
      approvalEvent,
    );
    expect(wrongBinding).toMatchObject({
      status: "terminal_failure",
      code: "telegram.binding_mismatch",
    });
  });

  it("acknowledges Telegram callback queries and redacts secrets on error", async () => {
    const requests: Record<string, unknown>[] = [];
    let fail = false;

    const fakeFetch: TelegramFetch = async (url, init) => {
      requests.push(parseJsonBody(init));
      if (fail) {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: `query too old for ${url}`,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const telegram = createTelegramMessaging({
      botToken: TEST_TOKEN,
      fetch: fakeFetch,
    });

    await telegram.acknowledgeCallback("cbq-1", { text: "Approved." });
    expect(requests[0]).toEqual({
      callback_query_id: "cbq-1",
      text: "Approved.",
    });

    fail = true;
    let caught: unknown;
    try {
      await telegram.acknowledgeCallback("cbq-2", { text: "Expired." });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TelegramApiError);
    expect((caught as Error).message).not.toContain(TEST_TOKEN);
  });
});
