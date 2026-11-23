import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import { GUEST_PRELUDE } from "./guest-prelude";

export interface ScriptWorkerInit {
  readonly script: string;
  readonly seed: number;
  readonly now: number;
  readonly memoryBytes: number;
  readonly activeMs: number;
  readonly stop: SharedArrayBuffer;
}

export interface ScriptWorkerReply {
  readonly call: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly kind: string; readonly message: string };
  readonly now?: number | undefined;
}

export interface ScriptWorkerFailure {
  readonly kind: string;
  readonly message: string;
  readonly call?: string;
  readonly line?: number;
}

export type ScriptWorkerMessage =
  | { readonly log: string }
  | { readonly call: number; readonly id: string; readonly input: unknown }
  | {
      readonly done: true;
      readonly result?: unknown;
      readonly error?: ScriptWorkerFailure;
      readonly limit?: "memory" | "time";
    }
  | { readonly fatal: { readonly code: string; readonly message: string } };

declare const self: Worker;

const STACK_BYTES = 512 * 1024;
const WASM_PAGE_BYTES = 65_536;
const WASM_INITIAL_PAGES = 256;
const WASM_MAX_PAGES = 32_768;
const WASM_OVERHEAD_BYTES = 32 * 1024 * 1024;
const OUT_OF_MEMORY = "InternalError: out of memory";
const STOP_REQUESTED = 1;

// The engine renders local time through the worker's Date; pinning it to UTC keeps a Script's
// date strings independent of the host timezone.
const NativeDate = Date;
class UtcDate extends NativeDate {
  constructor(...args: unknown[]) {
    if (args.length >= 2) {
      const [year, month, day, hours, minutes, seconds, ms] = args as number[];
      super(
        NativeDate.UTC(year!, month!, day ?? 1, hours ?? 0, minutes ?? 0, seconds ?? 0, ms ?? 0),
      );
    } else {
      super(...(args as [number]));
    }
  }
}
for (const unit of [
  "FullYear",
  "Month",
  "Date",
  "Day",
  "Hours",
  "Minutes",
  "Seconds",
  "Milliseconds",
]) {
  Object.defineProperty(UtcDate.prototype, `get${unit}`, {
    value(this: Record<string, () => number>) {
      return this[`getUTC${unit}`]!();
    },
  });
}
UtcDate.prototype.getTimezoneOffset = () => 0;
globalThis.Date = UtcDate as DateConstructor;

function post(message: ScriptWorkerMessage): void {
  self.postMessage(JSON.stringify(message));
}

let onReply: (reply: ScriptWorkerReply) => void = () => {};

async function run(init: ScriptWorkerInit): Promise<void> {
  const pages = Math.min(
    WASM_MAX_PAGES,
    Math.max(
      WASM_INITIAL_PAGES,
      Math.ceil((init.memoryBytes + WASM_OVERHEAD_BYTES) / WASM_PAGE_BYTES),
    ),
  );
  const wasmMemory = new WebAssembly.Memory({ initial: WASM_INITIAL_PAGES, maximum: pages });
  const quickjs = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory }));
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(init.memoryBytes);
  runtime.setMaxStackSize(STACK_BYTES);
  const vm = runtime.newContext();
  const stop = new Int32Array(init.stop);
  const pending = new Map<number, QuickJSDeferredPromise>();

  let activeUsed = 0;
  let activeSince: number | undefined;
  let timedOut = false;
  let finished = false;

  runtime.setInterruptHandler(() => {
    if (Atomics.load(stop, 0) === STOP_REQUESTED) {
      return true;
    }
    if (
      activeSince !== undefined &&
      activeUsed + (performance.now() - activeSince) > init.activeMs
    ) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const inGuest = <T>(work: () => T): T => {
    activeSince = performance.now();
    try {
      return work();
    } finally {
      activeUsed += performance.now() - activeSince;
      activeSince = undefined;
    }
  };

  const finish = (message: ScriptWorkerMessage): void => {
    if (!finished) {
      finished = true;
      post(message);
    }
  };

  const finishWithEngineError = (error: unknown): void => {
    if (timedOut) {
      finish({ done: true, limit: "time" });
      return;
    }
    const detail = error as { name?: unknown; message?: unknown } | null;
    const message =
      typeof detail === "object" && detail !== null && typeof detail.message === "string"
        ? `${String(detail.name)}: ${detail.message}`
        : undefined;
    if (message === undefined || message === OUT_OF_MEMORY) {
      finish({ done: true, limit: "memory" });
    } else {
      finish({ done: true, error: { kind: "script", message } });
    }
  };

  const drainJobs = (): void => {
    const jobs = inGuest(() => runtime.executePendingJobs());
    if (jobs.error) {
      const dumped: unknown = vm.dump(jobs.error);
      jobs.error.dispose();
      finishWithEngineError(dumped);
    } else if (!finished && pending.size === 0) {
      finish({ done: true, error: { kind: "script", message: "script ended without a result" } });
    }
  };

  const log = vm.newFunction("log", (text) => {
    post({ log: vm.getString(text) });
  });
  const call = vm.newFunction("call", (ordinal, id, input) => {
    const deferred = vm.newPromise();
    const number = vm.getNumber(ordinal);
    pending.set(number, deferred);
    post({ call: number, id: vm.getString(id), input: JSON.parse(vm.getString(input)) });
    return deferred.handle;
  });
  const done = vm.newFunction("done", (outcome) => {
    const parsed = JSON.parse(vm.getString(outcome)) as {
      result?: unknown;
      error?: ScriptWorkerFailure;
    };
    if (timedOut) {
      finish({ done: true, limit: "time" });
    } else if (parsed.error?.message === OUT_OF_MEMORY) {
      finish({ done: true, limit: "memory" });
    } else {
      finish({ done: true, ...parsed });
    }
  });

  onReply = (reply) => {
    const deferred = pending.get(reply.call);
    if (finished || deferred === undefined) {
      return;
    }
    pending.delete(reply.call);
    const text = vm.newString(JSON.stringify(reply));
    deferred.resolve(text);
    text.dispose();
    drainJobs();
    deferred.dispose();
  };

  const prelude = vm.unwrapResult(vm.evalCode(GUEST_PRELUDE, "prelude.js"));
  const args = [
    log,
    call,
    done,
    vm.newNumber(init.seed),
    vm.newNumber(init.now),
    vm.newString(init.script),
  ];
  const started = inGuest(() => vm.callFunction(prelude, vm.undefined, ...args));
  prelude.dispose();
  for (const handle of args) {
    handle.dispose();
  }
  if (started.error) {
    const dumped: unknown = vm.dump(started.error);
    started.error.dispose();
    finishWithEngineError(dumped);
    return;
  }
  started.value.dispose();
  drainJobs();
}

self.onmessage = (event: MessageEvent<ScriptWorkerInit | ScriptWorkerReply>) => {
  if ("script" in event.data) {
    run(event.data).catch((error: unknown) => {
      post({
        fatal: {
          code: "script.engine_start_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  } else {
    onReply(event.data);
  }
};
