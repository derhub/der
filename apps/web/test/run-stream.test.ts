import { describe, expect, it } from "vite-plus/test";
import { formatSseComment, formatSseEvent, PROBLEM_DETAILS_MEDIA_TYPE } from "@der/domain";
import { createIdempotencyTracker } from "../src/lib/idempotency";
import { OperatorApiError } from "../src/lib/schemas";
import { createDerChatConnection, streamRunEvents } from "../src/lib/run-stream";
import { createOperatorApi } from "../src/lib/operator-api";

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

describe("preserve idempotency key across retries", () => {
  it("reuses the same key for identical retry payloads and mints a new key when payload changes or resets", () => {
    let counter = 0;
    const tracker = createIdempotencyTracker(() => {
      counter += 1;
      return `idem-${counter}`;
    });

    const first = tracker.keyFor("sess-1", { engine: "fixture", text: "turn on lamp" });
    const retry = tracker.keyFor("sess-1", { engine: "fixture", text: "turn on lamp" });
    expect(retry).toBe(first);
    expect(first).toBe("idem-1");

    const edited = tracker.keyFor("sess-1", { engine: "fixture", text: "turn off lamp" });
    expect(edited).toBe("idem-2");

    tracker.clear("sess-1");
    const afterClear = tracker.keyFor("sess-1", { engine: "fixture", text: "turn off lamp" });
    expect(afterClear).toBe("idem-3");
  });
});

describe("resume SSE stream with deduplication and terminal 204", () => {
  it("preserves Last-Event-ID on reconnect, deduplicates replayed events, and stops on terminal 204", async () => {
    const observedHeaders: Array<string | null> = [];
    let attempt = 0;

    const fakeFetch: typeof fetch = async (_input, init) => {
      attempt += 1;
      const headers = new Headers(init?.headers);
      observedHeaders.push(headers.get("last-event-id"));

      if (attempt === 1) {
        return sseResponse([
          formatSseComment("keep-alive"),
          formatSseEvent({
            id: 1,
            data: { type: "RUN_STARTED", runId: "run-1", threadId: "sess-1" },
          }),
          formatSseEvent({
            id: 2,
            data: { type: "TEXT_MESSAGE_CONTENT", messageId: "m-1", delta: "Hello " },
          }),
        ]);
      }

      if (attempt === 2) {
        return sseResponse([
          formatSseEvent({
            id: 2,
            data: { type: "TEXT_MESSAGE_CONTENT", messageId: "m-1", delta: "Hello " },
          }),
          formatSseEvent({
            id: 3,
            data: { type: "TEXT_MESSAGE_CONTENT", messageId: "m-1", delta: "world" },
          }),
        ]);
      }

      return new Response(null, { status: 204 });
    };

    const cursors: number[] = [];
    const statuses: string[] = [];
    const received: Array<{ sequence: number; type: string; delta?: string }> = [];

    for await (const item of streamRunEvents({
      runId: "run-1",
      fetcher: fakeFetch,
      wait: async () => {},
      onCursorAdvance: (seq) => cursors.push(seq),
      onStatusChange: (status) => statuses.push(status),
    })) {
      const record = item.chunk as Record<string, unknown>;
      received.push({
        sequence: item.sequence,
        type: String(record["type"]),
        ...(typeof record["delta"] === "string" ? { delta: record["delta"] } : {}),
      });
    }

    expect(observedHeaders).toEqual([null, "2", "3"]);
    expect(received).toEqual([
      { sequence: 1, type: "RUN_STARTED" },
      { sequence: 2, type: "TEXT_MESSAGE_CONTENT", delta: "Hello " },
      { sequence: 3, type: "TEXT_MESSAGE_CONTENT", delta: "world" },
    ]);
    expect(cursors).toEqual([1, 2, 3]);
    expect(statuses).toContain("terminal_204");
  });

  it("closes immediately after a committed terminal chunk without reconnecting", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return sseResponse([
        formatSseEvent({
          id: 1,
          data: { type: "RUN_STARTED", runId: "run-2", threadId: "sess-1" },
        }),
        formatSseEvent({
          id: 2,
          data: { type: "RUN_FINISHED", runId: "run-2", threadId: "sess-1" },
        }),
      ]);
    };

    const chunks = [];
    for await (const item of streamRunEvents({
      runId: "run-2",
      fetcher: fakeFetch,
      wait: async () => {},
    })) {
      chunks.push(item.sequence);
    }

    expect(calls).toBe(1);
    expect(chunks).toEqual([1, 2]);
  });

  it("throws typed OperatorApiError on non-retryable Problem Details responses", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          type: "https://der.invalid/problems/sse-cursor-out-of-range",
          title: "Invalid SSE cursor",
          status: 400,
          detail: "Last-Event-ID cursor 99 exceeds committed high-water mark 3.",
          instance: "/api/runs/run-1/events",
          code: "sse.cursor_out_of_range",
        }),
        {
          status: 400,
          headers: { "content-type": PROBLEM_DETAILS_MEDIA_TYPE },
        },
      );

    let caught: unknown;
    try {
      for await (const _item of streamRunEvents({
        runId: "run-1",
        initialCursor: 99,
        fetcher: fakeFetch,
        wait: async () => {},
      })) {
        // unreachable
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OperatorApiError);
    expect((caught as OperatorApiError).problem).toEqual({
      type: "https://der.invalid/problems/sse-cursor-out-of-range",
      title: "Invalid SSE cursor",
      status: 400,
      detail: "Last-Event-ID cursor 99 exceeds committed high-water mark 3.",
      instance: "/api/runs/run-1/events",
      code: "sse.cursor_out_of_range",
    });
  });

  it("bridges run admission and native TanStack chunks through ConnectConnectionAdapter", async () => {
    const admittedKeys: Array<string | null> = [];
    const approvalEvents: string[] = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "/api/sessions/sess-1/runs" && init?.method === "POST") {
        admittedKeys.push(new Headers(init.headers).get("idempotency-key"));
        return new Response(
          JSON.stringify({
            run: {
              id: "run-9",
              botId: "bot-1",
              sessionId: "sess-1",
              origin: "web",
              engine: "fixture",
              status: "queued",
              routineId: null,
              checkpoint: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: null,
            },
            initialMessage: {
              id: "msg-1",
              botId: "bot-1",
              sessionId: "sess-1",
              ordinal: 1,
              role: "user",
              parts: [{ type: "text", text: "apply lamp-1" }],
              runId: "run-9",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            isDuplicate: false,
            payloadFingerprint: "fp-1",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }

      if (url.startsWith("/api/runs/run-9/events")) {
        return sseResponse([
          formatSseEvent({
            id: 1,
            data: { type: "RUN_STARTED", runId: "run-9", threadId: "sess-1" },
          }),
          formatSseEvent({
            id: 2,
            data: {
              type: "CUSTOM",
              name: "approval.requested",
              value: { approvalId: "apr-1", operationId: "fixture.apply" },
            },
          }),
          formatSseEvent({
            id: 3,
            data: { type: "RUN_FINISHED", runId: "run-9", threadId: "sess-1" },
          }),
        ]);
      }

      return new Response("Not found", { status: 404 });
    };

    const api = createOperatorApi({ fetcher: fakeFetch });
    const adapter = createDerChatConnection({
      api,
      botId: "bot-1",
      sessionId: "sess-1",
      engine: "fixture",
      fetcher: fakeFetch,
      wait: async () => {},
      onApprovalSignal: (name) => approvalEvents.push(name),
    });

    const yielded: string[] = [];
    for await (const chunk of adapter.connect(
      [{ id: "u-1", role: "user", parts: [{ type: "text", content: "apply lamp-1" }] }],
      { idempotencyKey: "stable-key-1" },
      undefined,
      { threadId: "sess-1", runId: "client-run-1" },
    )) {
      yielded.push(chunk.type);
    }

    expect(admittedKeys).toEqual(["stable-key-1"]);
    expect(yielded).toEqual(["RUN_STARTED", "CUSTOM", "RUN_FINISHED"]);
    expect(approvalEvents).toEqual(["approval.requested"]);
  });
});
