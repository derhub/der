import type { JsonValue } from "../schemas/common";

declare const streamChunkBrand: unique symbol;

/**
 * A chunk a Run's stream may carry before it ends: never a `RUN_FINISHED` or `RUN_ERROR` payload.
 * Only `streamChunk` makes one, so an engine's own terminal payload cannot reach an append.
 */
export type StreamChunk = JsonValue & { readonly [streamChunkBrand]: true };

/** Payload types that end a stream; only finishing a Run writes one, with the status it sets. */
export const TERMINAL_CHUNK_TYPES = ["RUN_FINISHED", "RUN_ERROR"] as const;
export type TerminalChunkType = (typeof TERMINAL_CHUNK_TYPES)[number];

export function isTerminalChunk(chunk: JsonValue): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    !Array.isArray(chunk) &&
    (TERMINAL_CHUNK_TYPES as readonly unknown[]).includes(chunk["type"])
  );
}

type StreamChunkOf<T extends string> = string extends T
  ? StreamChunk | undefined
  : T extends TerminalChunkType
    ? undefined
    : StreamChunk;

/**
 * The chunk as a stream chunk, or undefined for a terminal payload. A literal payload type is
 * checked at compile time: a non-terminal one gives a `StreamChunk`, a terminal one `undefined`.
 */
export function streamChunk<
  const C extends { readonly type: string; readonly [key: string]: JsonValue },
>(chunk: C): StreamChunkOf<C["type"]>;
export function streamChunk(chunk: JsonValue): StreamChunk | undefined;
export function streamChunk(chunk: JsonValue): StreamChunk | undefined {
  return isTerminalChunk(chunk) ? undefined : (chunk as StreamChunk);
}

/** The key reserved for a Run's terminal chunk. */
export function terminalChunkKey(runId: string): string {
  return `${runId}:terminal`;
}
