import { jsonValue, type JsonValue } from "../schemas/common";

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8" as const;
export const SSE_CACHE_CONTROL = "no-cache" as const;
export const SSE_EVENT_NAME = "message" as const;

const DECIMAL_CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export type SseCursorErrorCode = "sse.cursor_invalid" | "sse.cursor_out_of_range";

export type SseCursorResolution =
  | { readonly ok: true; readonly mode: "stream"; readonly after: number }
  | { readonly ok: true; readonly mode: "terminal"; readonly cursor: number }
  | { readonly ok: false; readonly code: SseCursorErrorCode; readonly detail: string };

export interface ParseSseCursorInput {
  readonly lastEventId?: string | null | undefined;
  readonly after?: string | null | undefined;
  readonly highWaterMark: number;
  readonly terminalSequence?: number | undefined;
}

export interface FormatSseEventInput {
  readonly id?: number | string | undefined;
  readonly data: JsonValue;
  readonly event?: string | undefined;
}

export type SseFrame =
  | { readonly kind: "event"; readonly id?: string; readonly event: string; readonly data: string }
  | { readonly kind: "comment"; readonly comment: string };

export function sseHeaders(): Record<"content-type" | "cache-control", string> {
  return {
    "content-type": SSE_CONTENT_TYPE,
    "cache-control": SSE_CACHE_CONTROL,
  };
}

export function hasForbiddenSseControlChars(value: string): boolean {
  return value.includes("\0") || value.includes("\r") || value.includes("\n");
}

function parseCursorValue(
  raw: string,
  source: "Last-Event-ID" | "after",
): number | { code: SseCursorErrorCode; detail: string } {
  if (hasForbiddenSseControlChars(raw)) {
    return {
      code: "sse.cursor_invalid",
      detail: `${source} must not contain NUL, CR, or LF characters.`,
    };
  }
  if (!DECIMAL_CURSOR_PATTERN.test(raw)) {
    return {
      code: "sse.cursor_invalid",
      detail: `${source} must be a non-negative canonical decimal integer.`,
    };
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    return {
      code: "sse.cursor_invalid",
      detail: `${source} exceeds the safe integer range.`,
    };
  }
  return parsed;
}

export function parseSseCursor(input: ParseSseCursorInput): SseCursorResolution {
  if (!Number.isSafeInteger(input.highWaterMark) || input.highWaterMark < 0) {
    throw new RangeError("highWaterMark must be a non-negative safe integer");
  }
  if (
    input.terminalSequence !== undefined &&
    (!Number.isSafeInteger(input.terminalSequence) || input.terminalSequence < 0)
  ) {
    throw new RangeError("terminalSequence must be a non-negative safe integer");
  }

  let selectedRaw: string | undefined;
  let source: "Last-Event-ID" | "after" = "after";

  if (input.lastEventId !== undefined && input.lastEventId !== null) {
    selectedRaw = input.lastEventId;
    source = "Last-Event-ID";
  } else if (input.after !== undefined && input.after !== null) {
    selectedRaw = input.after;
    source = "after";
  }

  if (selectedRaw === undefined) {
    return { ok: true, mode: "stream", after: 0 };
  }

  const parsed = parseCursorValue(selectedRaw, source);
  if (typeof parsed !== "number") {
    return { ok: false, code: parsed.code, detail: parsed.detail };
  }

  if (parsed > input.highWaterMark) {
    return {
      ok: false,
      code: "sse.cursor_out_of_range",
      detail: `${source} cursor ${parsed} exceeds committed high-water mark ${input.highWaterMark}.`,
    };
  }

  if (input.terminalSequence !== undefined && parsed === input.terminalSequence) {
    return { ok: true, mode: "terminal", cursor: parsed };
  }

  return { ok: true, mode: "stream", after: parsed };
}

function validateEmittedId(id: number | string): string {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new RangeError(`SSE id must be a non-negative safe integer, received ${String(id)}`);
    }
    return String(id);
  }
  if (id.length === 0 || hasForbiddenSseControlChars(id)) {
    throw new RangeError("SSE id must be non-empty and must not contain NUL, CR, or LF characters");
  }
  return id;
}

export function formatSseEvent(input: FormatSseEventInput): string {
  const idPrefix = input.id !== undefined ? `id: ${validateEmittedId(input.id)}\n` : "";
  const eventName = input.event ?? SSE_EVENT_NAME;
  if (eventName.length === 0 || hasForbiddenSseControlChars(eventName)) {
    throw new RangeError(
      "SSE event name must be non-empty and must not contain NUL, CR, or LF characters",
    );
  }

  const parsedData = jsonValue.parse(input.data);
  const serialized = JSON.stringify(parsedData);
  const dataLines = serialized.split("\n").map((line) => `data: ${line}`);
  return `${idPrefix}event: ${eventName}\n${dataLines.join("\n")}\n\n`;
}

export function formatSseComment(comment: string): string {
  if (hasForbiddenSseControlChars(comment)) {
    throw new RangeError("SSE comment must not contain NUL, CR, or LF characters");
  }
  return `: ${comment}\n\n`;
}

export function parseSseFrame(raw: string): SseFrame {
  if (!raw.endsWith("\n\n")) {
    throw new RangeError("SSE frame must terminate with a blank line");
  }
  const body = raw.slice(0, -2);
  if (body.length === 0) {
    throw new RangeError("SSE frame must not be empty");
  }
  const lines = body.split("\n");
  if (lines.length === 1 && lines[0]?.startsWith(":")) {
    const rest = lines[0].slice(1);
    return { kind: "comment", comment: rest.startsWith(" ") ? rest.slice(1) : rest };
  }

  let frameId: string | undefined;
  let eventName: string = SSE_EVENT_NAME;
  const dataParts: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    const rawValue = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "id") {
      if (hasForbiddenSseControlChars(value)) {
        throw new RangeError("SSE frame id must not contain NUL, CR, or LF characters");
      }
      frameId = value;
    } else if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataParts.push(value);
    }
  }

  if (frameId !== undefined) {
    return {
      kind: "event",
      id: frameId,
      event: eventName,
      data: dataParts.join("\n"),
    };
  }

  return {
    kind: "event",
    event: eventName,
    data: dataParts.join("\n"),
  };
}
