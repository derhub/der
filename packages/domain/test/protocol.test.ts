import { describe, expect, it } from "vite-plus/test";
import {
  CLOUD_EVENT_SPEC_VERSION,
  CLOUD_EVENT_TYPES,
  DomainError,
  PROBLEM_DETAILS_MEDIA_TYPE,
  SSE_CACHE_CONTROL,
  SSE_CONTENT_TYPE,
  SSE_EVENT_NAME,
  cloudEvent,
  createProblemDetails,
  formatSseComment,
  formatSseEvent,
  formatUtcTimestamp,
  parseSseCursor,
  parseSseFrame,
  problemDetails,
  sseHeaders,
  utcTimestamp,
} from "@der/domain/protocol";

describe("validate RFC 3339 UTC timestamps", () => {
  it.each([
    { label: "whole seconds", value: "2026-11-22T13:45:00Z" },
    { label: "millisecond precision", value: "2026-11-22T13:45:00.123Z" },
    { label: "nanosecond precision", value: "2026-11-22T13:45:00.123456789Z" },
    { label: "leap day on leap year", value: "2024-02-29T23:59:59Z" },
  ])("accepts $label", ({ value }) => {
    const result = utcTimestamp.safeParse(value);
    expect(result).toEqual({ success: true, data: value });
  });

  it.each([
    { label: "zero numeric offset", value: "2026-11-22T13:45:00+00:00" },
    { label: "negative numeric offset", value: "2026-11-22T13:45:00-05:00" },
    { label: "lowercase z", value: "2026-11-22T13:45:00z" },
    { label: "lowercase t", value: "2026-11-22t13:45:00Z" },
    { label: "space separator", value: "2026-11-22 13:45:00Z" },
    { label: "non-leap year Feb 29", value: "2026-02-29T00:00:00Z" },
    { label: "invalid month 13", value: "2026-13-01T00:00:00Z" },
    { label: "invalid hour 24", value: "2026-11-22T24:00:00Z" },
    { label: "invalid minute 60", value: "2026-11-22T12:60:00Z" },
    { label: "invalid second 60", value: "2026-11-22T12:00:60Z" },
    { label: "date only", value: "2026-11-22" },
    { label: "empty string", value: "" },
  ])("rejects $label", ({ value }) => {
    expect(utcTimestamp.safeParse(value).success).toBe(false);
  });

  it("formats a valid Date into RFC 3339 UTC with Z designator", () => {
    const formatted = formatUtcTimestamp(new Date(Date.UTC(2026, 10, 22, 13, 45, 0, 50)));
    expect(formatted).toBe("2026-11-22T13:45:00.050Z");
  });

  it("throws when formatting an invalid Date", () => {
    expect(() => formatUtcTimestamp(new Date("not-a-date"))).toThrow(
      "timestamp must be a valid Date",
    );
  });
});

describe("enforce strict six-field RFC 9457 Problem Details", () => {
  const validProblem = {
    type: "https://der.invalid/problems/idempotency-conflict",
    title: "Idempotency key conflict",
    status: 409,
    detail: "Idempotency-Key was reused with a different request payload.",
    instance: "/api/sessions/sess-1/runs",
    code: "idempotency.conflict",
  } as const;

  it("accepts the exact six-field profile and exposes the media type", () => {
    expect(PROBLEM_DETAILS_MEDIA_TYPE).toBe("application/problem+json");
    expect(problemDetails.parse(validProblem)).toEqual(validProblem);
    expect(createProblemDetails(validProblem)).toEqual(validProblem);
  });

  it.each([
    {
      label: "extra seventh field",
      input: { ...validProblem, extra: "disallowed" },
    },
    {
      label: "missing code field",
      input: {
        type: validProblem.type,
        title: validProblem.title,
        status: validProblem.status,
        detail: validProblem.detail,
        instance: validProblem.instance,
      },
    },
    {
      label: "HTTP 200 status",
      input: { ...validProblem, status: 200 },
    },
    {
      label: "HTTP 399 status",
      input: { ...validProblem, status: 399 },
    },
    {
      label: "HTTP 600 status",
      input: { ...validProblem, status: 600 },
    },
    {
      label: "non-integer status",
      input: { ...validProblem, status: 409.5 },
    },
    {
      label: "whitespace in type URI reference",
      input: { ...validProblem, type: "https://der.invalid/bad type" },
    },
    {
      label: "CRLF in instance URI reference",
      input: { ...validProblem, instance: "/api/runs/1\r\nInjected: 1" },
    },
    {
      label: "invalid machine code syntax",
      input: { ...validProblem, code: "Bad Code!" },
    },
  ])("rejects $label", ({ input }) => {
    expect(problemDetails.safeParse(input).success).toBe(false);
  });

  it("maps DomainError directly into strict six-field Problem Details", () => {
    const error = new DomainError({
      code: "approval.expired",
      status: 409,
      type: "https://der.invalid/problems/approval-expired",
      title: "Approval expired",
      detail: "Approval appr-1 expired before decision.",
      instance: "/api/approvals/appr-1/decision",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("approval.expired");
    expect(error.toProblemDetails()).toEqual({
      type: "https://der.invalid/problems/approval-expired",
      title: "Approval expired",
      status: 409,
      detail: "Approval appr-1 expired before decision.",
      instance: "/api/approvals/appr-1/decision",
      code: "approval.expired",
    });
  });
});

describe("validate typed CloudEvents v1.0 envelopes", () => {
  const baseEnvelope = {
    specversion: CLOUD_EVENT_SPEC_VERSION,
    id: "evt-1",
    source: "/bots/bot-1",
    time: "2026-11-22T14:00:00Z",
    datacontenttype: "application/json" as const,
  };

  it("accepts all three exact outbound CloudEvents types", () => {
    expect(CLOUD_EVENT_TYPES).toEqual({
      chatReplied: "der.chat.replied",
      approvalRequested: "der.approval.requested",
      routineFinished: "der.routine.finished",
    });

    const chatEvent = {
      ...baseEnvelope,
      type: "der.chat.replied" as const,
      subject: "sessions/sess-1/runs/run-1",
      data: {
        botId: "bot-1",
        sessionId: "sess-1",
        runId: "run-1",
        message: {
          id: "msg-2",
          botId: "bot-1",
          sessionId: "sess-1",
          ordinal: 2,
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: "Done." }],
          runId: "run-1",
          createdAt: "2026-11-22T14:00:00Z",
        },
      },
    };

    const approvalEvent = {
      ...baseEnvelope,
      id: "evt-2",
      type: "der.approval.requested" as const,
      subject: "sessions/sess-1/runs/run-1/approvals/appr-1",
      data: {
        botId: "bot-1",
        sessionId: "sess-1",
        runId: "run-1",
        approvalId: "appr-1",
        operationKind: "mcp" as const,
        operationId: "notes.append_note",
        prompt: "Append daily shift note?",
        deadline: "2026-11-22T14:05:00Z",
      },
    };

    const routineEvent = {
      ...baseEnvelope,
      id: "evt-3",
      type: "der.routine.finished" as const,
      subject: "bots/bot-1/routines/rt-1/runs/run-2",
      data: {
        botId: "bot-1",
        routineId: "rt-1",
        runId: "run-2",
        sessionId: "sess-1",
        slot: "2026-11-22T14:00:00Z",
        outcome: "completed" as const,
        finishedAt: "2026-11-22T14:00:12Z",
      },
    };

    expect(cloudEvent.parse(chatEvent)).toEqual(chatEvent);
    expect(cloudEvent.parse(approvalEvent)).toEqual(approvalEvent);
    expect(cloudEvent.parse(routineEvent)).toEqual(routineEvent);
  });

  it.each([
    {
      label: "unknown event type",
      input: {
        ...baseEnvelope,
        type: "der.unknown.event",
        subject: "bots/bot-1",
        data: {},
      },
    },
    {
      label: "wrong specversion",
      input: {
        ...baseEnvelope,
        specversion: "0.3",
        type: "der.routine.finished",
        subject: "bots/bot-1",
        data: {
          botId: "bot-1",
          routineId: "rt-1",
          runId: "run-2",
          sessionId: "sess-1",
          slot: "2026-11-22T14:00:00Z",
          outcome: "completed",
          finishedAt: "2026-11-22T14:00:12Z",
        },
      },
    },
    {
      label: "non-UTC commit time",
      input: {
        ...baseEnvelope,
        time: "2026-11-22T14:00:00+00:00",
        type: "der.routine.finished",
        subject: "bots/bot-1",
        data: {
          botId: "bot-1",
          routineId: "rt-1",
          runId: "run-2",
          sessionId: "sess-1",
          slot: "2026-11-22T14:00:00Z",
          outcome: "completed",
          finishedAt: "2026-11-22T14:00:12Z",
        },
      },
    },
    {
      label: "extra envelope field",
      input: {
        ...baseEnvelope,
        type: "der.routine.finished",
        subject: "bots/bot-1",
        deliveryState: "pending",
        data: {
          botId: "bot-1",
          routineId: "rt-1",
          runId: "run-2",
          sessionId: "sess-1",
          slot: "2026-11-22T14:00:00Z",
          outcome: "completed",
          finishedAt: "2026-11-22T14:00:12Z",
        },
      },
    },
    {
      label: "non-terminal outcome on routine finished",
      input: {
        ...baseEnvelope,
        type: "der.routine.finished",
        subject: "bots/bot-1",
        data: {
          botId: "bot-1",
          routineId: "rt-1",
          runId: "run-2",
          sessionId: "sess-1",
          slot: "2026-11-22T14:00:00Z",
          outcome: "running",
          finishedAt: "2026-11-22T14:00:12Z",
        },
      },
    },
  ])("rejects $label", ({ input }) => {
    expect(cloudEvent.safeParse(input).success).toBe(false);
  });
});

describe("validate W3C SSE cursors and framing", () => {
  it("exposes W3C SSE response headers and standard event name", () => {
    expect(SSE_CONTENT_TYPE).toBe("text/event-stream; charset=utf-8");
    expect(SSE_CACHE_CONTROL).toBe("no-cache");
    expect(SSE_EVENT_NAME).toBe("message");
    expect(sseHeaders()).toEqual({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
  });

  it("defaults to cursor 0 when no cursor is supplied", () => {
    expect(parseSseCursor({ highWaterMark: 10 })).toEqual({
      ok: true,
      mode: "stream",
      after: 0,
    });
  });

  it("gives Last-Event-ID precedence over the after query parameter", () => {
    expect(
      parseSseCursor({
        lastEventId: "7",
        after: "2",
        highWaterMark: 10,
      }),
    ).toEqual({
      ok: true,
      mode: "stream",
      after: 7,
    });
  });

  it("returns terminal mode when cursor matches the terminal sequence", () => {
    expect(
      parseSseCursor({
        lastEventId: "10",
        highWaterMark: 10,
        terminalSequence: 10,
      }),
    ).toEqual({
      ok: true,
      mode: "terminal",
      cursor: 10,
    });
  });

  it("streams remaining events when cursor is before the terminal sequence", () => {
    expect(
      parseSseCursor({
        lastEventId: "7",
        highWaterMark: 10,
        terminalSequence: 10,
      }),
    ).toEqual({
      ok: true,
      mode: "stream",
      after: 7,
    });
  });

  it("uses after cursor when Last-Event-ID is absent", () => {
    expect(
      parseSseCursor({
        lastEventId: null,
        after: "4",
        highWaterMark: 10,
      }),
    ).toEqual({
      ok: true,
      mode: "stream",
      after: 4,
    });
  });

  it.each([
    {
      label: "NUL in Last-Event-ID",
      lastEventId: "1\0",
      after: undefined,
      code: "sse.cursor_invalid",
    },
    {
      label: "CR in Last-Event-ID",
      lastEventId: "1\r",
      after: undefined,
      code: "sse.cursor_invalid",
    },
    {
      label: "LF in Last-Event-ID",
      lastEventId: "1\n",
      after: undefined,
      code: "sse.cursor_invalid",
    },
    { label: "NUL in after", lastEventId: undefined, after: "2\0", code: "sse.cursor_invalid" },
    { label: "CR in after", lastEventId: undefined, after: "2\r", code: "sse.cursor_invalid" },
    { label: "LF in after", lastEventId: undefined, after: "2\n", code: "sse.cursor_invalid" },
    { label: "empty Last-Event-ID", lastEventId: "", after: "1", code: "sse.cursor_invalid" },
    { label: "negative cursor", lastEventId: "-1", after: undefined, code: "sse.cursor_invalid" },
    {
      label: "leading zero cursor",
      lastEventId: "01",
      after: undefined,
      code: "sse.cursor_invalid",
    },
    {
      label: "whitespace padded cursor",
      lastEventId: " 1 ",
      after: undefined,
      code: "sse.cursor_invalid",
    },
    {
      label: "non-decimal cursor",
      lastEventId: "0x10",
      after: undefined,
      code: "sse.cursor_invalid",
    },
    {
      label: "beyond high-water mark",
      lastEventId: "11",
      after: undefined,
      code: "sse.cursor_out_of_range",
    },
  ])("rejects $label with $code", ({ lastEventId, after, code }) => {
    const result = parseSseCursor({ lastEventId, after, highWaterMark: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
    }
  });

  it("formats and parses standard W3C SSE message frames and keep-alive comments", () => {
    const chunk = { type: "content", delta: "hello\nworld", seq: 3 };
    const encoded = formatSseEvent({ id: 3, data: chunk });
    expect(encoded).toBe(`id: 3\nevent: message\ndata: ${JSON.stringify(chunk)}\n\n`);
    expect(parseSseFrame(encoded)).toEqual({
      kind: "event",
      id: "3",
      event: "message",
      data: JSON.stringify(chunk),
    });

    const keepAlive = formatSseComment("keep-alive");
    expect(keepAlive).toBe(": keep-alive\n\n");
    expect(parseSseFrame(keepAlive)).toEqual({
      kind: "comment",
      comment: "keep-alive",
    });

    const idlessError = formatSseEvent({
      data: { type: "RUN_ERROR", code: "sse.stream_error", message: "transient" },
    });
    expect(idlessError).toBe(
      `event: message\ndata: ${JSON.stringify({ type: "RUN_ERROR", code: "sse.stream_error", message: "transient" })}\n\n`,
    );
    expect(parseSseFrame(idlessError)).toEqual({
      kind: "event",
      event: "message",
      data: JSON.stringify({ type: "RUN_ERROR", code: "sse.stream_error", message: "transient" }),
    });
  });

  it.each([
    { label: "NUL in emitted id", action: () => formatSseEvent({ id: "1\0", data: {} }) },
    { label: "CR in emitted id", action: () => formatSseEvent({ id: "1\r", data: {} }) },
    { label: "LF in emitted id", action: () => formatSseEvent({ id: "1\n", data: {} }) },
    { label: "negative numeric id", action: () => formatSseEvent({ id: -1, data: {} }) },
    {
      label: "CRLF in event name",
      action: () => formatSseEvent({ id: 1, event: "msg\r\n", data: {} }),
    },
    { label: "LF in comment", action: () => formatSseComment("line1\nline2") },
    { label: "NUL in comment", action: () => formatSseComment("bad\0") },
  ])("rejects $label", ({ action }) => {
    expect(action).toThrow();
  });
});
