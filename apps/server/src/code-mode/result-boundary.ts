import type { ExecuteResult, JsonValue } from "@der/domain";

/**
 * The smallest result limit the server accepts. Above it the compact in-doubt form, the error
 * kind and `Unknown outcome: N omitted.`, fits even inside the `script.finished` event envelope.
 */
export const MIN_RESULT_BYTES = 256;

/** An in-doubt end's message closes with this and its unknown writes: `#2 notes.append, #3 notes.add.` */
export const UNKNOWN_OUTCOME = "Unknown outcome: ";

/** Text around the serialized result in its final form, as the event envelope around `result`. */
export interface ResultEnvelope {
  readonly prefix: string;
  readonly suffix: string;
}

export interface BoundedResult {
  readonly result: ExecuteResult;
  readonly text: string;
}

type Failure = Extract<ExecuteResult, { ok: false }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NO_ENVELOPE: ResultEnvelope = { prefix: "", suffix: "" };
const LOGS_TRUNCATED = "[logs truncated]";
const MESSAGE_TRUNCATED = "[message truncated]";
const CALL_TRUNCATED = " [call truncated]";

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function cutUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
}

/** The longest cut of `text` that `fits` once `mark` shapes it; undefined when even the empty cut does not. */
function longestFit(
  text: string,
  mark: (cut: string) => string,
  fits: (candidate: string) => boolean,
): string | undefined {
  const marked = (bytes: number) => mark(cutUtf8(text, bytes));
  if (!fits(marked(0))) {
    return undefined;
  }
  let low = 0;
  let high = byteLength(text);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(marked(mid))) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return marked(low);
}

/** A cut message ends with the marker; a message cut to nothing is the marker alone. */
function markMessage(cut: string): string {
  return cut === "" ? MESSAGE_TRUNCATED : `${cut} ${MESSAGE_TRUNCATED}`;
}

/**
 * Cuts a message from its end, except an in-doubt message's unknown writes: those are kept
 * whole, then as many as fit with a count of the rest, and only the text before them is cut,
 * marked, or dropped.
 */
function fitMessage(message: string, fits: (candidate: string) => boolean): string | undefined {
  if (fits(message)) {
    return message;
  }
  const at = message.lastIndexOf(UNKNOWN_OUTCOME);
  if (at < 0) {
    return longestFit(message, markMessage, fits);
  }
  const head = message.slice(0, at).trimEnd();
  const names = message
    .slice(at + UNKNOWN_OUTCOME.length)
    .replace(/\.$/, "")
    .split(", ");
  const tail = (kept: number) => {
    const omitted = names.length - kept;
    const listed = [...names.slice(0, kept), ...(omitted > 0 ? [`${omitted} omitted`] : [])];
    return `${UNKNOWN_OUTCOME}${listed.join(", ")}.`;
  };
  const withHead = (kept: number) =>
    longestFit(head, (cut) => `${markMessage(cut)} ${tail(kept)}`, fits);
  const whole = withHead(names.length);
  if (whole !== undefined) {
    return whole;
  }
  // Below all names, one fewer name always shortens the tail, so the count is a binary search.
  // The cut marker stays while it fits; without room for it, the names alone are kept.
  for (const form of [(kept: number) => `${MESSAGE_TRUNCATED} ${tail(kept)}`, tail]) {
    if (!fits(form(0))) {
      continue;
    }
    let low = 0;
    let high = names.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(form(mid))) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return withHead(low) ?? form(low);
  }
  return undefined;
}

interface Budget {
  readonly size: (candidate: ExecuteResult) => number;
  readonly maxBytes: number;
}

/**
 * As many of `logs` as fit after `base`, which holds `marker`; each kept line adds its JSON
 * and a comma, so the sum is exact without serializing the result again per line.
 */
function fitLogs(
  base: number,
  marker: readonly string[],
  logs: readonly string[],
  maxBytes: number,
): { readonly kept: string[]; readonly cut: boolean } {
  const kept: string[] = [];
  let used = base;
  for (const line of logs) {
    used += byteLength(JSON.stringify(line)) + (marker.length > 0 || kept.length > 0 ? 1 : 0);
    if (used > maxBytes) {
      return { kept, cut: true };
    }
    kept.push(line);
  }
  return { kept, cut: false };
}

/** The message first, then the call, then as many logs as still fit, each cut marked. */
function fitFailure(result: Failure, budget: Budget): Failure {
  const fits = (candidate: ExecuteResult) => budget.size(candidate) <= budget.maxBytes;
  const { call, ...error } = result.error;
  const shaped = (message: string, logs: string[], keptCall?: string): Failure => ({
    ok: false,
    error: { ...error, message, ...(keptCall === undefined ? {} : { call: keptCall }) },
    logs,
  });
  const markers = result.logs.length > 0 ? [[LOGS_TRUNCATED], []] : [[]];
  for (const marker of markers) {
    const message = fitMessage(result.error.message, (candidate) =>
      fits(shaped(candidate, marker)),
    );
    if (message === undefined) {
      continue;
    }
    const keptCall =
      call === undefined || fits(shaped(message, marker, call))
        ? call
        : longestFit(
            call,
            (cut) => `${cut}${CALL_TRUNCATED}`,
            (candidate) => fits(shaped(message, marker, candidate)),
          );
    const base = budget.size(shaped(message, marker, keptCall));
    const { kept, cut } = fitLogs(base, marker, result.logs, budget.maxBytes);
    return shaped(message, cut ? [...kept, ...marker] : kept, keptCall);
  }
  return shaped(MESSAGE_TRUNCATED, []);
}

/** The value whole if it fits with no logs, else its JSON cut to fit; then as many logs as fit. */
function fitSuccess(result: Extract<ExecuteResult, { ok: true }>, budget: Budget): ExecuteResult {
  const fits = (candidate: ExecuteResult) => budget.size(candidate) <= budget.maxBytes;
  const shaped = (value: JsonValue, logs: string[]): ExecuteResult => ({
    ok: true,
    result: value,
    logs,
    truncated: true,
  });
  const value: JsonValue = fits(shaped(result.result, []))
    ? result.result
    : (longestFit(
        JSON.stringify(result.result) ?? "null",
        (cut) => cut,
        (candidate) => fits(shaped(candidate, [])),
      ) ?? "");
  const { kept } = fitLogs(budget.size(shaped(value, [])), [], result.logs, budget.maxBytes);
  return shaped(value, kept);
}

/**
 * The one boundary every Script result crosses on its way to an agent: the result fitted so
 * that its final text, `envelope.prefix + JSON + envelope.suffix`, is at most `maxBytes`.
 * An in-doubt result keeps its error kind and its unknown writes, or as many as fit and a
 * count of the rest.
 */
export function boundResult(
  result: ExecuteResult,
  maxBytes: number,
  envelope: ResultEnvelope = NO_ENVELOPE,
): BoundedResult {
  if (maxBytes < MIN_RESULT_BYTES) {
    throw new RangeError(
      `result limit ${maxBytes} is below the minimum of ${MIN_RESULT_BYTES} bytes`,
    );
  }
  const textOf = (candidate: ExecuteResult) =>
    `${envelope.prefix}${JSON.stringify(candidate)}${envelope.suffix}`;
  const budget: Budget = { size: (candidate) => byteLength(textOf(candidate)), maxBytes };
  const fitted =
    budget.size(result) <= maxBytes
      ? result
      : result.ok
        ? fitSuccess(result, budget)
        : fitFailure(result, budget);
  const text = textOf(fitted);
  if (byteLength(text) > maxBytes) {
    throw new RangeError(
      `result text of ${byteLength(text)} bytes exceeds the limit of ${maxBytes}; the envelope is too large`,
    );
  }
  return { result: fitted, text };
}
