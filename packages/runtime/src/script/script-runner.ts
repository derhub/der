import type { JsonValue } from "@der/domain";
import type { ScriptWorkerInit, ScriptWorkerMessage, ScriptWorkerReply } from "./script-worker";

export interface ScriptLimits {
  readonly memoryBytes: number;
  readonly activeMs: number;
  readonly maxCalls: number;
  readonly outputBytes: number;
}

export type ScriptErrorKind =
  | "script"
  | "denied"
  | "expired"
  | "limit"
  | "capability"
  | "cancelled"
  | "nondeterministic";

export type ScriptHostErrorKind = "denied" | "expired" | "cancelled" | "capability";

export type ScriptCallReply =
  | { readonly ok: true; readonly value: JsonValue; readonly now?: number }
  | {
      readonly ok: false;
      readonly error: { readonly kind: ScriptHostErrorKind; readonly message: string };
      readonly now?: number;
    };

export type ScriptResult =
  | {
      readonly ok: true;
      readonly result: JsonValue;
      readonly logs: string[];
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: ScriptErrorKind;
        readonly message: string;
        readonly call?: string;
        readonly line?: number;
      };
      readonly logs: string[];
    };

export interface RunScriptOptions {
  readonly script: string;
  readonly call: (id: string, input: JsonValue) => Promise<ScriptCallReply>;
  readonly limits: ScriptLimits;
  readonly seed: number;
  readonly now: number;
  readonly signal?: AbortSignal;
}

export class ScriptRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScriptRunnerError";
    this.code = code;
  }
}

const WORKER_URL = new URL("./script-worker.ts", import.meta.url);
const STALL_GRACE_MS = 2_000;
const STALL_POLL_MS = 50;
const STOP_REQUESTED = 1;

const transpiler = new Bun.Transpiler({ loader: "js" });
const WRAPPER_LINES = 1;

function findSyntaxError(script: string): ScriptResult | undefined {
  try {
    transpiler.transformSync(`globalThis.__script = async function (der) {\n${script}\n};`);
    return undefined;
  } catch (error) {
    const detail = (
      Array.isArray((error as AggregateError).errors) ? (error as AggregateError).errors[0] : error
    ) as { message?: string; position?: { line: number } } | undefined;
    const line = detail?.position === undefined ? 0 : detail.position.line - WRAPPER_LINES;
    return {
      ok: false,
      error: {
        kind: "script",
        message: `SyntaxError: ${detail?.message ?? String(error)}`,
        ...(line > 0 ? { line } : {}),
      },
      logs: [],
    };
  }
}

function isHostErrorKind(value: unknown): value is ScriptHostErrorKind {
  return (
    value === "denied" || value === "expired" || value === "cancelled" || value === "capability"
  );
}

export async function runScript(options: RunScriptOptions): Promise<ScriptResult> {
  const { limits, signal } = options;
  const logs: string[] = [];
  if (signal?.aborted) {
    return { ok: false, error: { kind: "cancelled", message: "script cancelled" }, logs };
  }

  const syntaxError = findSyntaxError(options.script);
  if (syntaxError !== undefined) {
    return syntaxError;
  }

  const stop = new SharedArrayBuffer(4);
  const worker = new Worker(WORKER_URL, { env: {} });

  const outcome: { verdict?: ScriptResult; fatal?: ScriptRunnerError } = {};
  let resolveVerdict: () => void = () => {};
  const verdictSettled = new Promise<void>((resolve) => {
    resolveVerdict = resolve;
  });
  let outputBytes = 0;
  let calls = 0;
  let callsInFlight = 0;
  let lastHeardAt = performance.now();
  let callQueue: Promise<void> = Promise.resolve();

  const finish = (result: ScriptResult): void => {
    if (outcome.verdict !== undefined) {
      return;
    }
    outcome.verdict = result;
    Atomics.store(new Int32Array(stop), 0, STOP_REQUESTED);
    worker.terminate();
    resolveVerdict();
  };
  const fail = (kind: ScriptErrorKind, message: string): void => {
    finish({ ok: false, error: { kind, message }, logs });
  };

  const onAbort = (): void => fail("cancelled", "script cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });

  const stallWatch = setInterval(() => {
    if (
      outcome.verdict === undefined &&
      callsInFlight === 0 &&
      performance.now() - lastHeardAt > limits.activeMs + STALL_GRACE_MS
    ) {
      fail("limit", `active time limit of ${limits.activeMs} ms exceeded`);
    }
  }, STALL_POLL_MS);

  const handleCall = async (message: { call: number; id: string; input: unknown }) => {
    calls += 1;
    if (calls > limits.maxCalls) {
      fail("limit", `call limit of ${limits.maxCalls} exceeded`);
      return;
    }
    let reply: ScriptCallReply;
    try {
      reply = await options.call(message.id, message.input as JsonValue);
    } catch (error) {
      reply = {
        ok: false,
        error: {
          kind: "capability",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (outcome.verdict !== undefined) {
      return;
    }
    const wire: ScriptWorkerReply = reply.ok
      ? { call: message.call, ok: true, value: reply.value, now: reply.now }
      : {
          call: message.call,
          ok: false,
          error: isHostErrorKind(reply.error.kind)
            ? reply.error
            : { kind: "capability", message: reply.error.message },
          now: reply.now,
        };
    lastHeardAt = performance.now();
    worker.postMessage(wire);
  };

  const handleMessage = (message: ScriptWorkerMessage): void => {
    if ("log" in message) {
      logs.push(message.log);
    } else if ("call" in message) {
      callsInFlight += 1;
      callQueue = callQueue.then(() =>
        handleCall(message).finally(() => {
          callsInFlight -= 1;
        }),
      );
    } else if ("fatal" in message) {
      outcome.fatal = new ScriptRunnerError(message.fatal.code, message.fatal.message);
      fail("script", message.fatal.message);
    } else if (message.limit === "memory") {
      fail("limit", `memory limit of ${limits.memoryBytes} bytes exceeded`);
    } else if (message.limit === "time") {
      fail("limit", `active time limit of ${limits.activeMs} ms exceeded`);
    } else if (message.error !== undefined) {
      const error = message.error;
      finish({
        ok: false,
        error: {
          kind: isHostErrorKind(error.kind) ? error.kind : "script",
          message: error.message,
          ...(error.call === undefined ? {} : { call: error.call }),
          ...(error.line === undefined ? {} : { line: error.line }),
        },
        logs,
      });
    } else {
      finish({ ok: true, result: (message.result ?? null) as JsonValue, logs, truncated: false });
    }
  };

  worker.onmessage = (event: MessageEvent<string>) => {
    if (outcome.verdict !== undefined) {
      return;
    }
    lastHeardAt = performance.now();
    outputBytes += Buffer.byteLength(event.data);
    if (outputBytes > limits.outputBytes) {
      fail("limit", `output limit of ${limits.outputBytes} bytes exceeded`);
      return;
    }
    handleMessage(JSON.parse(event.data) as ScriptWorkerMessage);
  };
  worker.onerror = (event: ErrorEvent) => {
    outcome.fatal = new ScriptRunnerError("script.worker_failed", event.message);
    fail("script", event.message);
  };
  worker.addEventListener("close", () => {
    fail("script", "script ended without a result");
  });

  const init: ScriptWorkerInit = {
    script: options.script,
    seed: options.seed,
    now: options.now,
    memoryBytes: limits.memoryBytes,
    activeMs: limits.activeMs,
    stop,
  };
  worker.postMessage(init);

  try {
    await verdictSettled;
  } finally {
    clearInterval(stallWatch);
    signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
  if (outcome.fatal !== undefined) {
    throw outcome.fatal;
  }
  return outcome.verdict as ScriptResult;
}
