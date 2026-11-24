import * as z from "zod";
import type { ExecuteResult, JsonValue, Run, ScriptStore } from "@der/domain";
import type { AnyTool } from "@tanstack/ai";
import type { ScriptDriver } from "../scripts/script-driver";

const executeInput = z.strictObject({ script: z.string().min(1), key: z.string().optional() });

export interface ExecuteToolDeps {
  readonly run: Run;
  readonly scriptRunStore: Pick<ScriptStore, "acquire" | "detach" | "load">;
  readonly scriptDriver: ScriptDriver;
  readonly maxResultBytes: number;
  readonly inlineWaitMs: number;
}

export interface ExecutePending {
  readonly status: "pending";
  readonly executionId: string;
  readonly proposedWrites: readonly { position: number; capability: string; input: JsonValue }[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOGS_TRUNCATED = "[logs truncated]";
const MESSAGE_TRUNCATED = " [message truncated]";
const CALL_TRUNCATED = " [call truncated]";

function failure(
  kind: Extract<ExecuteResult, { ok: false }>["error"]["kind"],
  message: string,
): ExecuteResult {
  return { ok: false, error: { kind, message }, logs: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cutUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
}

function fitLogs(logs: readonly string[], maxBytes: number): { logs: string[]; cut: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of logs) {
    used += encoder.encode(line).byteLength;
    if (used > maxBytes) {
      return { logs: kept, cut: true };
    }
    kept.push(line);
  }
  return { logs: kept, cut: false };
}

function jsonBytes(value: JsonValue | ExecuteResult): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

type Failure = Extract<ExecuteResult, { ok: false }>;

/** An in-doubt end's message closes with this and its unknown writes: `#2 notes.append, #3 notes.add.` */
export const UNKNOWN_OUTCOME = "Unknown outcome: ";

/** The longest cut of `text`, marked with `suffix`, that `fits`; undefined when even the bare marker does not. */
function longestFit(
  text: string,
  suffix: string,
  fits: (candidate: string) => boolean,
): string | undefined {
  const marked = (bytes: number) => {
    const cut = cutUtf8(text, bytes);
    return cut === "" ? suffix.trimStart() : `${cut}${suffix}`;
  };
  if (!fits(marked(0))) {
    return undefined;
  }
  let low = 0;
  let high = encoder.encode(text).byteLength;
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

/**
 * Cuts a message from its end, except an in-doubt message's unknown writes: those are kept
 * whole, then as many as fit with a count of the rest, and only the text before them is cut.
 */
function fitMessage(message: string, fits: (candidate: string) => boolean): string | undefined {
  if (fits(message)) {
    return message;
  }
  const at = message.lastIndexOf(UNKNOWN_OUTCOME);
  if (at < 0) {
    return longestFit(message, MESSAGE_TRUNCATED, fits);
  }
  const head = message.slice(0, at);
  const names = message
    .slice(at + UNKNOWN_OUTCOME.length)
    .replace(/\.$/, "")
    .split(", ");
  const tail = (kept: number) => {
    const omitted = names.length - kept;
    const listed = [...names.slice(0, kept), ...(omitted > 0 ? [`${omitted} omitted`] : [])];
    return `${UNKNOWN_OUTCOME}${listed.join(", ")}.`;
  };
  const withHead = (kept: number) => {
    const cut = longestFit(head, MESSAGE_TRUNCATED, (candidate) =>
      fits(`${candidate} ${tail(kept)}`),
    );
    return cut === undefined ? undefined : `${cut} ${tail(kept)}`;
  };
  const whole = withHead(names.length);
  if (whole !== undefined) {
    return whole;
  }
  // With some names omitted, one fewer name always shortens the list, so the search is monotone.
  let low = -1;
  let high = names.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(`${MESSAGE_TRUNCATED.trimStart()} ${tail(mid)}`)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low < 0 ? undefined : withHead(low);
}

/**
 * Fits a failed result, serialized, into `maxBytes`: the message first, then the call, then as
 * many logs as still fit, each cut marked. A limit too small for any of the message gets a fixed
 * marker that keeps the error kind and says `in_doubt` when the execution ended in doubt.
 */
function fitFailure(result: Failure, maxBytes: number, inDoubt: boolean): Failure {
  if (jsonBytes(result) <= maxBytes) {
    return result;
  }
  const { call, ...error } = result.error;
  const shaped = (message: string, logs: string[], keptCall?: string): Failure => ({
    ok: false,
    error: { ...error, message, ...(keptCall === undefined ? {} : { call: keptCall }) },
    logs,
  });
  const fits = (candidate: Failure) => jsonBytes(candidate) <= maxBytes;
  const marker = result.logs.length > 0 ? [LOGS_TRUNCATED] : [];
  const message = fitMessage(result.error.message, (candidate) => fits(shaped(candidate, marker)));
  if (message === undefined) {
    return {
      ok: false,
      error: { kind: error.kind, message: inDoubt ? "in_doubt" : "truncated" },
      logs: [],
    };
  }
  const keptCall =
    call === undefined || fits(shaped(message, marker, call))
      ? call
      : longestFit(call, CALL_TRUNCATED, (candidate) => fits(shaped(message, marker, candidate)));
  const kept: string[] = [];
  let used = jsonBytes(shaped(message, marker, keptCall));
  for (const line of result.logs) {
    used += jsonBytes(line) + 1;
    if (used > maxBytes) {
      return shaped(message, [...kept, ...marker], keptCall);
    }
    kept.push(line);
  }
  return shaped(message, kept, keptCall);
}

export function fitResult(
  result: ExecuteResult,
  maxBytes: number,
  inDoubt: boolean,
): ExecuteResult {
  if (!result.ok) {
    return fitFailure(result, maxBytes, inDoubt);
  }
  const { logs, cut } = fitLogs(result.logs, maxBytes);
  const serialized = JSON.stringify(result.result) ?? "null";
  const tooLarge = encoder.encode(serialized).byteLength > maxBytes;
  const value: JsonValue = tooLarge ? cutUtf8(serialized, maxBytes) : result.result;
  return {
    ok: true,
    result: value,
    logs,
    truncated: result.truncated || tooLarge || cut,
  };
}

/**
 * Waits `inlineWaitMs` for the Script's end, then detaches it. `detach` succeeds only
 * while the execution is unfinished, so either the inline result or the `script.finished`
 * event reaches the agent, never both and never neither. The same Script and key in the
 * same Run always name one execution: a repeat reattaches while it runs and returns its
 * stored result once finished, so a lost response never runs a write twice.
 */
async function executeAndWait(
  deps: ExecuteToolDeps,
  script: string,
  key: string | undefined,
  signal: AbortSignal,
): Promise<ExecuteResult | ExecutePending> {
  const { scriptRunStore: store, scriptDriver: driver } = deps;
  const execution = store.acquire({
    runId: deps.run.id,
    botId: deps.run.botId,
    source: script,
    ...(key === undefined ? {} : { key }),
    seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
  });
  await driver.wait(execution.id, signal, deps.inlineWaitMs);
  const detachedNow = store.detach(execution.id);
  const settled = store.load(execution.id).execution;
  if (!detachedNow && settled.result !== null) {
    return fitResult(settled.result, deps.maxResultBytes, settled.status === "in_doubt");
  }
  return {
    status: "pending",
    executionId: execution.id,
    proposedWrites: await driver.proposedWrites(execution.id),
  };
}

export function createExecuteTool(deps: ExecuteToolDeps): AnyTool {
  return {
    name: "execute",
    description:
      'Run a JavaScript Script that calls capabilities as await step.run(id, input). Waits a few seconds for the Script to end and returns its result. A Script still running then, for example while an operator decides an approval, returns { status: "pending", executionId, proposedWrites } and its outcome arrives later as an event message. Never throws: check `ok` in a result. Calling execute again with the same script (and key) returns that same execution, running or finished, and never runs it twice; pass a new `key` to run the same script again on purpose.',
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "Body of an async function. Use `return` to give back a JSON value. Await every capability call.",
        },
        key: {
          type: "string",
          description:
            "Optional. A new key runs the same script again as a new execution; omit it otherwise.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    } as AnyTool["inputSchema"],
    execute: async (
      rawArgs: unknown,
      context?: { readonly signal?: AbortSignal },
    ): Promise<ExecuteResult | ExecutePending> => {
      const parsed = executeInput.safeParse(rawArgs);
      if (!parsed.success) {
        return failure(
          "script",
          `execute takes { script: string, key?: string }: ${parsed.error.message}`,
        );
      }
      const signal = context?.signal ?? new AbortController().signal;
      try {
        return await executeAndWait(deps, parsed.data.script, parsed.data.key, signal);
      } catch (error) {
        if (signal.aborted) {
          return failure(
            "cancelled",
            "execute was aborted before the script finished; call execute with the same script and key to reattach",
          );
        }
        return failure("capability", `execute failed: ${errorMessage(error)}`);
      }
    },
  };
}
