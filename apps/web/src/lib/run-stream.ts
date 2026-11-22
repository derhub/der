import {
  parseSseFrame,
  type BotId,
  type EngineKind,
  type Message,
  type RunAdmission,
  type RunId,
  type SessionId,
} from "@der/domain";
import type { StreamChunk } from "@tanstack/ai";
import type { ConnectConnectionAdapter, UIMessage } from "@tanstack/ai-react";
import type { OperatorApi } from "./operator-api";
import { OperatorApiError, parseProblemDetailsResponse, sseChunkPayloadSchema } from "./schemas";

export type RunStreamStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "terminal_chunk"
  | "terminal_204"
  | "error";

export interface CommittedRunChunk {
  readonly sequence: number;
  readonly chunk: StreamChunk;
}

export interface StreamRunEventsOptions {
  readonly runId: RunId;
  readonly baseUrl?: string;
  readonly initialCursor?: number;
  readonly signal?: AbortSignal;
  readonly maxReconnectAttempts?: number;
  readonly initialReconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly fetcher?: typeof fetch;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onCursorAdvance?: (sequence: number) => void;
  readonly onStatusChange?: (status: RunStreamStatus) => void;
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const DECIMAL_ID_PATTERN = /^(?:0|[1-9][0-9]*)$/;

function isTerminalChunkType(type: string): boolean {
  return type === "RUN_FINISHED" || type === "RUN_ERROR";
}

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSequenceId(rawId: string | undefined): number | undefined {
  if (rawId === undefined || !DECIMAL_ID_PATTERN.test(rawId)) {
    return undefined;
  }
  const value = Number(rawId);
  return Number.isSafeInteger(value) ? value : undefined;
}

export async function* streamRunEvents(
  options: StreamRunEventsOptions,
): AsyncIterable<CommittedRunChunk> {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const fetcher: typeof fetch = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const wait = options.wait ?? defaultWait;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 6;
  const initialDelayMs = options.initialReconnectDelayMs ?? 250;
  const maxDelayMs = options.maxReconnectDelayMs ?? 4_000;

  let lastCommittedSequence = options.initialCursor ?? 0;
  const seenSequences = new Set<number>();
  let consecutiveNoProgress = 0;
  let hasConnectedOnce = false;
  let sawTerminalChunk = false;

  const instance = `/api/runs/${encodeURIComponent(options.runId)}/events`;

  while (!options.signal?.aborted && !sawTerminalChunk) {
    options.onStatusChange?.(hasConnectedOnce ? "reconnecting" : "connecting");

    const headers: Record<string, string> = {
      accept: "text/event-stream",
    };
    if (lastCommittedSequence > 0) {
      headers["last-event-id"] = String(lastCommittedSequence);
    }

    const url = `${baseUrl}${instance}`;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers,
        credentials: "same-origin",
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress > maxReconnectAttempts) {
        options.onStatusChange?.("error");
        throw new OperatorApiError({
          type: "https://der.invalid/problems/sse-reconnect-exhausted",
          title: "Event stream disconnected",
          status: 503,
          detail:
            error instanceof Error
              ? `Lost SSE connection for run ${options.runId}: ${error.message}`
              : `Lost SSE connection for run ${options.runId}.`,
          instance,
          code: "sse.reconnect_exhausted",
        });
      }
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (consecutiveNoProgress - 1));
      hasConnectedOnce = true;
      await wait(delayMs, options.signal);
      continue;
    }

    hasConnectedOnce = true;

    if (response.status === 204) {
      options.onStatusChange?.("terminal_204");
      return;
    }

    if (!response.ok) {
      const apiError = await parseProblemDetailsResponse(response, instance);
      if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
        consecutiveNoProgress += 1;
        if (consecutiveNoProgress <= maxReconnectAttempts) {
          const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** (consecutiveNoProgress - 1));
          await wait(delayMs, options.signal);
          continue;
        }
      }
      options.onStatusChange?.("error");
      throw apiError;
    }

    if (!response.body) {
      options.onStatusChange?.("error");
      throw new OperatorApiError({
        type: "https://der.invalid/problems/sse-empty-body",
        title: "Missing event stream body",
        status: 502,
        detail: `Server returned status ${response.status} without a readable SSE stream body.`,
        instance,
        code: "sse.empty_body",
      });
    }

    options.onStatusChange?.("streaming");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let madeProgress = false;

    try {
      while (!options.signal?.aborted) {
        const read = await reader.read();
        if (read.done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(read.value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawFrame = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          if (rawFrame.trim().length === 0) {
            continue;
          }

          const frame = parseSseFrame(rawFrame);
          if (frame.kind === "comment") {
            continue;
          }

          const sequence = parseSequenceId(frame.id);
          if (sequence !== undefined) {
            if (sequence <= lastCommittedSequence || seenSequences.has(sequence)) {
              continue;
            }
          }

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(frame.data);
          } catch {
            continue;
          }

          const validatedChunk = sseChunkPayloadSchema.safeParse(parsedJson);
          if (!validatedChunk.success) {
            continue;
          }

          const effectiveSeq = sequence ?? lastCommittedSequence + 1;
          seenSequences.add(effectiveSeq);
          if (effectiveSeq > lastCommittedSequence) {
            lastCommittedSequence = effectiveSeq;
            options.onCursorAdvance?.(effectiveSeq);
          }
          madeProgress = true;
          consecutiveNoProgress = 0;

          const streamChunk = validatedChunk.data as unknown as StreamChunk;
          yield {
            sequence: effectiveSeq,
            chunk: streamChunk,
          };

          if (isTerminalChunkType(validatedChunk.data.type)) {
            sawTerminalChunk = true;
            options.onStatusChange?.("terminal_chunk");
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return;
      }
      if (!madeProgress) {
        consecutiveNoProgress += 1;
      }
      if (consecutiveNoProgress > maxReconnectAttempts) {
        options.onStatusChange?.("error");
        throw new OperatorApiError({
          type: "https://der.invalid/problems/sse-stream-broken",
          title: "Event stream interrupted",
          status: 503,
          detail:
            error instanceof Error
              ? `Stream read failed for run ${options.runId}: ${error.message}`
              : `Stream read failed for run ${options.runId}.`,
          instance,
          code: "sse.stream_interrupted",
        });
      }
    } finally {
      reader.releaseLock();
    }

    if (options.signal?.aborted || sawTerminalChunk) {
      return;
    }

    if (!madeProgress) {
      consecutiveNoProgress += 1;
    }
    if (consecutiveNoProgress > maxReconnectAttempts) {
      options.onStatusChange?.("error");
      throw new OperatorApiError({
        type: "https://der.invalid/problems/sse-incomplete",
        title: "Event stream ended before completion",
        status: 503,
        detail: `Run ${options.runId} stream closed before a terminal chunk or 204 confirmation after ${maxReconnectAttempts} reconnect attempts.`,
        instance,
        code: "sse.incomplete_stream",
      });
    }

    const delayMs = madeProgress
      ? initialDelayMs
      : Math.min(maxDelayMs, initialDelayMs * 2 ** (consecutiveNoProgress - 1));
    await wait(delayMs, options.signal);
  }
}

export interface DerChatConnectionOptions {
  readonly api: OperatorApi;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly engine?: EngineKind;
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly getInitialCursor?: (runId: RunId) => number;
  readonly onRunAdmitted?: (admission: RunAdmission) => void;
  readonly onCursorAdvance?: (runId: RunId, sequence: number) => void;
  readonly onStreamStatus?: (runId: RunId, status: RunStreamStatus) => void;
  readonly onApprovalSignal?: (eventName: string, payload: unknown, runId: RunId) => void;
  readonly onRunSettled?: (runId: RunId) => void;
}

function extractLatestUserText(
  messages: ReadonlyArray<UIMessage | { readonly role: string; readonly content?: unknown }>,
  data: Record<string, unknown> | undefined,
): string {
  if (typeof data?.["text"] === "string" && data["text"].trim().length > 0) {
    return data["text"].trim();
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    if (!entry || entry.role !== "user") {
      continue;
    }
    if ("parts" in entry && Array.isArray(entry.parts)) {
      const text = entry.parts
        .filter((part): part is { readonly type: "text"; readonly content: string } => {
          return (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "content" in part &&
            typeof part.content === "string"
          );
        })
        .map((part) => part.content)
        .join("\n")
        .trim();
      if (text.length > 0) {
        return text;
      }
    }
    if (
      "content" in entry &&
      typeof entry.content === "string" &&
      entry.content.trim().length > 0
    ) {
      return entry.content.trim();
    }
  }

  return "";
}

export function createDerChatConnection(
  options: DerChatConnectionOptions,
): ConnectConnectionAdapter {
  async function* tailRun(
    runId: RunId,
    initialCursor: number,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    try {
      for await (const item of streamRunEvents({
        runId,
        initialCursor,
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
        ...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
        ...(options.wait !== undefined ? { wait: options.wait } : {}),
        onCursorAdvance: (sequence) => options.onCursorAdvance?.(runId, sequence),
        onStatusChange: (status) => options.onStreamStatus?.(runId, status),
      })) {
        const record = item.chunk as unknown as Record<string, unknown>;
        if (record["type"] === "CUSTOM" && typeof record["name"] === "string") {
          const eventName = record["name"];
          if (eventName.startsWith("approval.")) {
            options.onApprovalSignal?.(eventName, record["value"], runId);
          }
        }
        yield item.chunk;
      }
    } finally {
      options.onRunSettled?.(runId);
    }
  }

  return {
    async *connect(messages, data, abortSignal) {
      const text = extractLatestUserText(messages, data);
      if (text.length === 0) {
        throw new OperatorApiError({
          type: "https://der.invalid/problems/empty-message",
          title: "Message is required",
          status: 400,
          detail: "Enter a message before starting a run.",
          instance: `/api/sessions/${options.sessionId}/runs`,
          code: "web.empty_message",
        });
      }

      const explicitKey =
        typeof data?.["idempotencyKey"] === "string" && data["idempotencyKey"].trim().length > 0
          ? data["idempotencyKey"].trim()
          : `web_${crypto.randomUUID()}`;

      const selectedEngine =
        typeof data?.["engine"] === "string" && data["engine"].length > 0
          ? (data["engine"] as EngineKind)
          : options.engine;

      const admission = await options.api.admitRun(
        options.sessionId,
        {
          botId: options.botId,
          origin: "web",
          ...(selectedEngine !== undefined ? { engine: selectedEngine } : {}),
          input: {
            parts: [{ type: "text", text }],
          },
        },
        explicitKey,
        abortSignal,
      );

      options.onRunAdmitted?.(admission);
      const startCursor = options.getInitialCursor?.(admission.run.id) ?? 0;

      for await (const chunk of tailRun(admission.run.id, startCursor, abortSignal)) {
        yield chunk;
      }
    },

    async *joinRun(runId, abortSignal) {
      const startCursor = options.getInitialCursor?.(runId) ?? 0;
      for await (const chunk of tailRun(runId, startCursor, abortSignal)) {
        yield chunk;
      }
    },
  };
}

export function domainMessagesToUiMessages(messages: readonly Message[]): UIMessage[] {
  return messages.map((msg) => {
    const role: UIMessage["role"] =
      msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user";

    const parts: UIMessage["parts"] = [];
    for (const part of msg.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", content: part.text });
      } else if (part.type === "tool-call") {
        parts.push({
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.arguments),
          state: "input-complete",
        });
      } else if (part.type === "tool-result") {
        parts.push({
          type: "tool-result",
          toolCallId: part.toolCallId,
          content: JSON.stringify(part.outcome),
          state: part.isError ? "error" : "complete",
          ...(part.isError ? { error: "Tool returned an error outcome." } : {}),
        });
      } else {
        parts.push({
          type: "text",
          content: `[${part.mimeType}] ${JSON.stringify(part.data)}`,
        });
      }
    }

    return {
      id: msg.id,
      role,
      parts,
      createdAt: new Date(msg.createdAt),
    };
  });
}
