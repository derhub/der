import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  formatSseComment,
  parseSseCursor,
  SSE_CACHE_CONTROL,
  SSE_CONTENT_TYPE,
  SSE_EVENT_NAME,
  type RunId,
  type RunStore,
} from "@der/domain";
import { problemResponse } from "./problem";

export type SseRunStore = Pick<RunStore, "getRunStreamState" | "readRunEventsAfter">;

export interface SseStreamOptions {
  readonly runs: SseRunStore;
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

export async function handleRunEventsSse(
  c: Context,
  runId: RunId,
  options: SseStreamOptions,
): Promise<Response> {
  const instance = `/api/runs/${runId}/events`;
  const streamState = await options.runs.getRunStreamState(runId);
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

  const url = new URL(c.req.url);
  const cursorResult = parseSseCursor({
    lastEventId: c.req.header("last-event-id") ?? null,
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
  const localAbort = new AbortController();
  const abortSignal = AbortSignal.any([c.req.raw.signal, localAbort.signal]);

  const response = streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      closed = true;
      localAbort.abort();
    });

    let lastActivityAt = Date.now();

    try {
      while (!closed && !stream.aborted && !abortSignal.aborted) {
        const events = await options.runs.readRunEventsAfter(runId, cursor);
        if (events.length > 0) {
          for (const event of events) {
            if (closed || stream.aborted || abortSignal.aborted) {
              return;
            }
            await stream.writeSSE({
              id: String(event.sequence),
              event: SSE_EVENT_NAME,
              data: JSON.stringify(event.chunk),
            });
            cursor = event.sequence;
            lastActivityAt = Date.now();
            if (event.isTerminal) {
              closed = true;
              return;
            }
          }
          continue;
        }

        const latestState = await options.runs.getRunStreamState(runId);
        if (!latestState) {
          await stream.writeSSE({
            event: SSE_EVENT_NAME,
            data: JSON.stringify({
              type: "RUN_ERROR",
              message: `Run ${runId} is no longer available.`,
              code: "run.not_found",
              runId,
            }),
          });
          closed = true;
          return;
        }

        if (latestState.terminalSequence !== undefined && cursor >= latestState.terminalSequence) {
          closed = true;
          return;
        }

        if (isTerminalStatus(latestState.status) && latestState.terminalSequence === undefined) {
          closed = true;
          return;
        }

        const now = Date.now();
        if (now - lastActivityAt >= options.keepAliveMs) {
          await stream.write(formatSseComment("keep-alive"));
          lastActivityAt = now;
        }

        await waitAbortable(options.pollIntervalMs, abortSignal);
      }
    } catch (error) {
      if (!closed && !stream.aborted) {
        const message = error instanceof Error ? error.message : "Stream failure.";
        await stream.writeSSE({
          event: SSE_EVENT_NAME,
          data: JSON.stringify({
            type: "RUN_ERROR",
            message,
            code: "sse.stream_error",
            runId,
          }),
        });
        closed = true;
      }
    }
  });

  response.headers.set("content-type", SSE_CONTENT_TYPE);
  response.headers.set("cache-control", SSE_CACHE_CONTROL);
  return response;
}
