import type { JsonValue } from "@der/domain";
import type {
  ScriptWorkerFailure,
  ScriptWorkerInit,
  ScriptWorkerMessage,
  ScriptWorkerReply,
} from "./script-worker";

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

type ScriptFailure = Extract<ScriptResult, { ok: false }>["error"];

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

export interface ScriptCallHalt {
  readonly halt: true;
}

export interface ScriptCallContext {
  readonly settled: () => boolean;
}

export interface RunScriptOptions {
  readonly script: string;
  readonly call: (
    id: string,
    input: JsonValue,
    context: ScriptCallContext,
  ) => Promise<ScriptCallReply | ScriptCallHalt>;
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
const HALTED_MESSAGE = "script halted by the host";
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

  const outcome: { verdict?: ScriptResult; fatal?: ScriptRunnerError; hostError?: unknown } = {};
  let resolveVerdict: () => void = () => {};
  const verdictSettled = new Promise<void>((resolve) => {
    resolveVerdict = resolve;
  });
  let outputBytes = 0;
  let calls = 0;
  let callsInFlight = 0;
  let lastHeardAt = performance.now();
  let callQueue: Promise<void> = Promise.resolve();
  let returned = false;
  let returnedResult: ScriptResult | undefined;
  let aborted = false;
  let markAborted: () => void = () => {};
  const abortedSettled = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const hostFailures = new Map<
    number,
    { kind: ScriptHostErrorKind; message: string; call: string }
  >();

  const finish = (result: ScriptResult): void => {
    if (outcome.verdict !== undefined) {
      return;
    }
    outcome.verdict = result;
    Atomics.store(new Int32Array(stop), 0, STOP_REQUESTED);
    worker.terminate();
    resolveVerdict();
  };
  const settleReturned = (result: ScriptResult): void => {
    if (callsInFlight === 0) {
      finish(result);
      return;
    }
    returned = true;
    returnedResult = result;
    Atomics.store(new Int32Array(stop), 0, STOP_REQUESTED);
    worker.terminate();
    const settle = (): void => finish(returnedResult ?? result);
    callQueue = callQueue.then(settle, settle);
  };
  const fail = (kind: ScriptErrorKind, message: string): void => {
    finish({ ok: false, error: { kind, message }, logs });
  };

  const onAbort = (): void => {
    aborted = true;
    markAborted();
    fail("cancelled", "script cancelled");
  };
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
    if (outcome.verdict !== undefined) {
      return;
    }
    calls += 1;
    if (calls > limits.maxCalls) {
      fail("limit", `call limit of ${limits.maxCalls} exceeded`);
      return;
    }
    let reply: ScriptCallReply | ScriptCallHalt;
    try {
      reply = await options.call(message.id, message.input as JsonValue, {
        settled: () => outcome.verdict !== undefined,
      });
    } catch (error) {
      outcome.hostError = error;
      fail("cancelled", HALTED_MESSAGE);
      return;
    }
    if ("halt" in reply) {
      fail("cancelled", HALTED_MESSAGE);
      return;
    }
    if (returned && !reply.ok && returnedResult?.ok) {
      returnedResult = {
        ok: false,
        error: {
          kind: isHostErrorKind(reply.error.kind) ? reply.error.kind : "capability",
          message: reply.error.message,
          call: message.id,
        },
        logs,
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
    if (!wire.ok && wire.error !== undefined) {
      hostFailures.set(message.call, {
        kind: wire.error.kind as ScriptHostErrorKind,
        message: wire.error.message,
        call: message.id,
      });
    }
    lastHeardAt = performance.now();
    if (!returned) {
      worker.postMessage(wire);
    }
  };

  const handleMessage = (message: ScriptWorkerMessage): void => {
    switch (message.type) {
      case "log":
        logs.push(message.text);
        return;
      case "call":
        callsInFlight += 1;
        callQueue = callQueue.then(() =>
          handleCall(message).finally(() => {
            callsInFlight -= 1;
          }),
        );
        return;
      case "fatal":
        outcome.fatal = new ScriptRunnerError(message.code, message.message);
        fail("script", message.message);
        return;
      case "done":
        finishDone(message);
        return;
    }
  };

  const describeFailure = (error: ScriptWorkerFailure): ScriptFailure => {
    const recorded =
      typeof error.hostCall === "number" ? hostFailures.get(error.hostCall) : undefined;
    if (recorded !== undefined) {
      return recorded;
    }
    return {
      kind: "script",
      message:
        typeof error.message === "string" ? error.message : "script failed with an invalid error",
      ...(Number.isSafeInteger(error.line) && (error.line as number) > 0
        ? { line: error.line as number }
        : {}),
    };
  };

  const finishDone = (message: Extract<ScriptWorkerMessage, { type: "done" }>): void => {
    if (message.limit === "memory") {
      fail("limit", `memory limit of ${limits.memoryBytes} bytes exceeded`);
    } else if (message.limit === "time") {
      fail("limit", `active time limit of ${limits.activeMs} ms exceeded`);
    } else if (message.error !== undefined) {
      settleReturned({ ok: false, error: describeFailure(message.error), logs });
    } else {
      settleReturned({
        ok: true,
        result: (message.result ?? null) as JsonValue,
        logs,
        truncated: false,
      });
    }
  };

  worker.onmessage = (event: MessageEvent<string>) => {
    if (outcome.verdict !== undefined || returned) {
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
    if (returned) {
      return;
    }
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
    if (!aborted) {
      await Promise.race([callQueue.catch(() => undefined), abortedSettled]);
    }
  } finally {
    clearInterval(stallWatch);
    signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
  if (outcome.fatal !== undefined) {
    throw outcome.fatal;
  }
  if (outcome.hostError !== undefined) {
    throw outcome.hostError;
  }
  return outcome.verdict as ScriptResult;
}
