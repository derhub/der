import {
  formatSseComment,
  formatSseEvent,
  parseSseCursor,
  sseHeaders,
  type RunId,
} from "@der/domain";
import type { SqliteStore } from "@der/storage";
import { problemResponse } from "./problem";

const encoder = new TextEncoder();

export interface SseStreamOptions {
  readonly store: SqliteStore;
  readonly pollIntervalMs: number;
  readonly keepAliveMs: number;
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function handleRunEventsSse(
  request: Request,
  url: URL,
  runId: RunId,
  options: SseStreamOptions,
): Response {
  const instance = `/api/runs/${runId}/events`;
  const streamState = options.store.getRunStreamState(runId);
  if (!streamState) {
    return problemResponse({
      type: "https://der.invalid/problems/run-not-found",
      title: "Run not found",
      status: 404,
      detail: `Run ${runId} does not exist.`,
      instance,
      code: "run.not_found",
    });
  }

  const cursorResult = parseSseCursor({
    lastEventId: request.headers.get("last-event-id"),
    after: url.searchParams.get("after"),
    highWaterMark: streamState.highWaterMark,
    terminalSequence: streamState.terminalSequence,
  });

  if (!cursorResult.ok) {
    return problemResponse({
      type: `https://der.invalid/problems/${cursorResult.code.replaceAll(".", "-")}`,
      title: "Invalid SSE cursor",
      status: 400,
      detail: cursorResult.detail,
      instance,
      code: cursorResult.code,
    });
  }

  if (cursorResult.mode === "terminal") {
    return new Response(null, { status: 204 });
  }

  let cursor = cursorResult.after;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastActivityAt = Date.now();
      const abortSignal = request.signal;

      try {
        while (!closed && !abortSignal.aborted) {
          const events = options.store.readRunEventsAfter(runId, cursor);
          if (events.length > 0) {
            for (const event of events) {
              if (closed || abortSignal.aborted) {
                return;
              }
              controller.enqueue(
                encoder.encode(formatSseEvent({ id: event.sequence, data: event.chunk })),
              );
              cursor = event.sequence;
              lastActivityAt = Date.now();
              if (event.isTerminal) {
                closed = true;
                controller.close();
                return;
              }
            }
            continue;
          }

          const latestState = options.store.getRunStreamState(runId);
          if (!latestState) {
            const errorFrame = formatSseEvent({
              data: {
                type: "RUN_ERROR",
                message: `Run ${runId} is no longer available.`,
                code: "run.not_found",
                runId,
              },
            });
            controller.enqueue(encoder.encode(errorFrame));
            closed = true;
            controller.close();
            return;
          }

          if (
            latestState.terminalSequence !== undefined &&
            cursor >= latestState.terminalSequence
          ) {
            closed = true;
            controller.close();
            return;
          }

          if (isTerminalStatus(latestState.status) && latestState.terminalSequence === undefined) {
            closed = true;
            controller.close();
            return;
          }

          const now = Date.now();
          if (now - lastActivityAt >= options.keepAliveMs) {
            controller.enqueue(encoder.encode(formatSseComment("keep-alive")));
            lastActivityAt = now;
          }

          await waitAbortable(options.pollIntervalMs, abortSignal);
        }

        if (!closed) {
          closed = true;
          controller.close();
        }
      } catch (error) {
        if (!closed) {
          const message = error instanceof Error ? error.message : "Stream failure.";
          const errorFrame = formatSseEvent({
            data: {
              type: "RUN_ERROR",
              message,
              code: "sse.stream_error",
              runId,
            },
          });
          controller.enqueue(encoder.encode(errorFrame));
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(),
  });
}
