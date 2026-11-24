import type { JsonValue } from "@der/domain";
import type { SessionDeliver, SessionInit, SessionOut } from "./script-worker";

export class ScriptRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScriptRunnerError";
    this.code = code;
  }
}

const WORKER_URL = new URL("./script-worker.ts", import.meta.url);
const STOP_REQUESTED = 1;

const transpiler = new Bun.Transpiler({ loader: "js" });
const WRAPPER_LINES = 1;

function findSyntaxError(script: string): ScriptDrainError | undefined {
  try {
    transpiler.transformSync(`globalThis.__script = async function (step) {\n${script}\n};`);
    return undefined;
  } catch (error) {
    const detail = (
      Array.isArray((error as AggregateError).errors) ? (error as AggregateError).errors[0] : error
    ) as { message?: string; position?: { line: number } } | undefined;
    const line = detail?.position === undefined ? 0 : detail.position.line - WRAPPER_LINES;
    return {
      kind: "script",
      message: `SyntaxError: ${detail?.message ?? String(error)}`,
      ...(line > 0 ? { line } : {}),
    };
  }
}

export interface SessionLimits {
  readonly memoryBytes: number;
  readonly activeMs: number;
  readonly maxAll: number;
  readonly outputBytes?: number;
}

export interface StartScriptOptions {
  readonly seed: number;
  readonly now: number;
  readonly limits: SessionLimits;
}

export interface StepRequest {
  readonly position: number;
  readonly id: string;
  readonly input: JsonValue;
}

export type StepResult =
  | { readonly position: number; readonly ok: true; readonly value: JsonValue }
  | {
      readonly position: number;
      readonly ok: false;
      readonly error: { readonly kind: string; readonly message: string };
    };

export interface UnobservedStep {
  readonly position: number;
  readonly kind: string;
  readonly message: string;
}

export interface ScriptDrainError {
  readonly kind: string;
  readonly message: string;
  readonly line?: number;
  readonly position?: number;
  readonly capability?: string;
}

export interface ScriptDrain {
  readonly requests: readonly StepRequest[];
  readonly orphans?: readonly number[];
  readonly fatal?: boolean;
  readonly returned?: JsonValue;
  readonly error?: ScriptDrainError;
  readonly unobserved: readonly UnobservedStep[];
  readonly logs: readonly string[];
}

export interface ScriptSession {
  readonly started: Promise<ScriptDrain>;
  readonly deliver: (results: readonly StepResult[]) => Promise<ScriptDrain>;
  readonly dispose: () => void;
}

type SessionEvent = { readonly message: SessionOut } | { readonly failure: ScriptRunnerError };

function toDrain(message: SessionOut, limits: SessionLimits): ScriptDrain {
  if (message.type === "dead") {
    const error: ScriptDrainError =
      message.limit === "time"
        ? { kind: "limit", message: `active time limit of ${limits.activeMs} ms exceeded` }
        : message.limit === "output"
          ? { kind: "limit", message: `output limit of ${limits.outputBytes} bytes exceeded` }
          : message.limit === "memory"
            ? { kind: "limit", message: `memory limit of ${limits.memoryBytes} bytes exceeded` }
            : { kind: "script", message: message.message ?? "script engine failed" };
    return { requests: [], error, fatal: true, unobserved: [], logs: [] };
  }
  const base = {
    requests: message.requests.map((request) => ({
      position: request.position,
      id: request.id,
      input: JSON.parse(request.input) as JsonValue,
    })),
    ...(message.orphans.length === 0 ? {} : { orphans: message.orphans }),
    unobserved: message.unobserved.map((step) => ({
      position: step.n,
      kind: step.kind,
      message: step.message,
    })),
    logs: message.logs,
  };
  if (message.fatal !== undefined) {
    const kind = message.fatal.kind === "late" ? "untracked-step" : message.fatal.kind;
    return { ...base, fatal: true, error: { kind, message: message.fatal.message } };
  }
  const ended = message.ended;
  if (ended === null) {
    return base;
  }
  if (!ended.ok) {
    const failure = ended.error;
    return {
      ...base,
      error: {
        kind: failure?.kind ?? "script",
        message: failure?.message ?? "script failed",
        ...(failure?.step === undefined ? {} : { position: failure.step }),
        ...(failure?.capability === undefined ? {} : { capability: failure.capability }),
      },
    };
  }
  return { ...base, returned: JSON.parse(ended.text ?? "null") as JsonValue };
}

export function startScript(source: string, options: StartScriptOptions): ScriptSession {
  const syntaxError = findSyntaxError(source);
  if (syntaxError !== undefined) {
    return {
      started: Promise.resolve({
        requests: [],
        error: syntaxError,
        fatal: true,
        unobserved: [],
        logs: [],
      }),
      deliver: async () => {
        throw new ScriptRunnerError("script.session_finished", "the script session has ended");
      },
      dispose: () => {},
    };
  }
  const { limits } = options;
  const stop = new SharedArrayBuffer(4);
  const worker = new Worker(WORKER_URL, { env: {} });
  const events: SessionEvent[] = [];
  let waiter: ((event: SessionEvent) => void) | undefined;
  let finished = false;
  let disposed = false;

  const push = (event: SessionEvent): void => {
    if (waiter === undefined) {
      events.push(event);
    } else {
      const resolve = waiter;
      waiter = undefined;
      resolve(event);
    }
  };
  let outputBytes = 0;
  const encoder = new TextEncoder();
  worker.onmessage = (event: MessageEvent<string>) => {
    outputBytes += encoder.encode(event.data).length;
    if (limits.outputBytes !== undefined && outputBytes > limits.outputBytes) {
      push({ message: { type: "dead", limit: "output" } });
      worker.terminate();
      return;
    }
    push({ message: JSON.parse(event.data) as SessionOut });
  };
  worker.onerror = (event: ErrorEvent) => {
    push({ failure: new ScriptRunnerError("script.worker_failed", event.message) });
  };

  const nextDrain = async (): Promise<ScriptDrain> => {
    const event =
      events.shift() ?? (await new Promise<SessionEvent>((resolve) => (waiter = resolve)));
    if ("failure" in event) {
      finished = true;
      throw event.failure;
    }
    const drain = toDrain(event.message, limits);
    if (drain.fatal) {
      finished = true;
    }
    return drain;
  };

  const init: SessionInit = {
    type: "session-init",
    script: source,
    seed: options.seed,
    now: options.now,
    memoryBytes: limits.memoryBytes,
    activeMs: limits.activeMs,
    maxAll: limits.maxAll,
    ...(limits.outputBytes === undefined ? {} : { outputBytes: limits.outputBytes }),
    stop,
  };
  worker.postMessage(init);
  const started = nextDrain();
  started.catch(() => undefined);

  return {
    started,
    deliver: async (results) => {
      if (disposed || finished) {
        throw new ScriptRunnerError("script.session_finished", "the script session has ended");
      }
      const message: SessionDeliver = { type: "deliver", replies: results };
      worker.postMessage(message);
      return await nextDrain();
    },
    dispose: () => {
      disposed = true;
      Atomics.store(new Int32Array(stop), 0, STOP_REQUESTED);
      worker.terminate();
      if (waiter !== undefined) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ failure: new ScriptRunnerError("script.session_disposed", "session disposed") });
      }
    },
  };
}
