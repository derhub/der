import {
  newQuickJSWASMModule,
  newVariant,
  RELEASE_SYNC,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { GUEST_PRELUDE } from "./guest-prelude";
import { GUEST_STEP } from "./guest-step";

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
  readonly hostCall?: unknown;
  readonly message?: unknown;
  readonly line?: unknown;
}

export type ScriptWorkerMessage =
  | { readonly type: "log"; readonly text: string }
  | { readonly type: "call"; readonly call: number; readonly id: string; readonly input: unknown }
  | {
      readonly type: "done";
      readonly result?: unknown;
      readonly error?: ScriptWorkerFailure;
      readonly limit?: "memory" | "time";
    }
  | { readonly type: "fatal"; readonly code: string; readonly message: string };

export interface SessionInit {
  readonly type: "session-init";
  readonly script: string;
  readonly seed: number;
  readonly now: number;
  readonly memoryBytes: number;
  readonly activeMs: number;
  readonly maxAll: number;
  readonly stop: SharedArrayBuffer;
}

export interface SessionReply {
  readonly position: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly kind: string; readonly message: string };
}

export interface SessionDeliver {
  readonly type: "deliver";
  readonly replies: readonly SessionReply[];
}

export interface SessionRequest {
  readonly position: number;
  readonly id: string;
  readonly input: string;
}

export interface SessionEnded {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: {
    readonly message: string;
    readonly kind: string;
    readonly step?: number;
    readonly capability?: string;
  };
}

export type SessionOut =
  | {
      readonly type: "drained";
      readonly requests: SessionRequest[];
      readonly orphans: number[];
      readonly ended: SessionEnded | null;
      readonly unobserved: { n: number; kind: string; message: string }[];
      readonly fatal?: { readonly kind: string; readonly message: string };
      readonly logs: string[];
    }
  | { readonly type: "dead"; readonly limit?: "time" | "memory"; readonly message?: string };

declare const self: Worker;

const STACK_BYTES = 512 * 1024;
const WASM_PAGE_BYTES = 65_536;
const WASM_INITIAL_PAGES = 256;
const WASM_MAX_PAGES = 32_768;
const WASM_OVERHEAD_BYTES = 32 * 1024 * 1024;
const OUT_OF_MEMORY = "InternalError: out of memory";
const WASM_OUT_OF_BOUNDS = "RuntimeError: Out of bounds memory access";
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
      finish({ type: "done", limit: "time" });
      return;
    }
    const detail = error as { name?: unknown; message?: unknown } | null;
    const message =
      typeof detail === "object" && detail !== null && typeof detail.message === "string"
        ? `${String(detail.name)}: ${detail.message}`
        : undefined;
    if (
      message === undefined ||
      message === OUT_OF_MEMORY ||
      message.startsWith(WASM_OUT_OF_BOUNDS)
    ) {
      finish({ type: "done", limit: "memory" });
    } else {
      finish({ type: "done", error: { message } });
    }
  };

  const drainJobs = (): void => {
    const jobs = inGuest(() => runtime.executePendingJobs());
    if (jobs.error) {
      const dumped: unknown = vm.dump(jobs.error);
      jobs.error.dispose();
      finishWithEngineError(dumped);
    } else if (!finished && pending.size === 0) {
      finish({ type: "done", error: { message: "script ended without a result" } });
    }
  };

  const log = vm.newFunction("log", (text) => {
    post({ type: "log", text: vm.getString(text) });
  });
  const call = vm.newFunction("call", (ordinal, id, input) => {
    const deferred = vm.newPromise();
    const number = vm.getNumber(ordinal);
    pending.set(number, deferred);
    post({
      type: "call",
      call: number,
      id: vm.getString(id),
      input: JSON.parse(vm.getString(input)),
    });
    return deferred.handle;
  });
  const done = vm.newFunction("done", (outcome) => {
    const parsed = JSON.parse(vm.getString(outcome)) as {
      result?: unknown;
      error?: ScriptWorkerFailure;
    };
    if (timedOut) {
      finish({ type: "done", limit: "time" });
    } else if (parsed.error?.message === OUT_OF_MEMORY) {
      finish({ type: "done", limit: "memory" });
    } else {
      finish({
        type: "done",
        ...(parsed.result === undefined ? {} : { result: parsed.result }),
        ...(parsed.error === undefined ? {} : { error: parsed.error }),
      });
    }
  });

  onReply = (reply) => {
    const deferred = pending.get(reply.call);
    if (finished || deferred === undefined) {
      return;
    }
    pending.delete(reply.call);
    try {
      const text = vm.newString(JSON.stringify(reply));
      deferred.resolve(text);
      text.dispose();
      drainJobs();
      deferred.dispose();
    } catch (error) {
      finishWithEngineError(error);
    }
  };

  try {
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
  } catch (error) {
    finishWithEngineError(error);
  }
}

function postSession(message: SessionOut): void {
  self.postMessage(JSON.stringify(message));
}

let onDeliver: (message: SessionDeliver) => void = () => {};

async function startSession(init: SessionInit): Promise<void> {
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

  let queue: SessionRequest[] = [];
  let ended: SessionEnded | null = null;
  let fatal: { kind: string; message: string } | undefined;
  let logs: string[] = [];
  let orphans: number[] = [];
  let activeUsed = 0;
  let activeSince: number | undefined;
  let timedOut = false;
  let dead = false;

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

  const die = (error: unknown): void => {
    if (dead) {
      return;
    }
    dead = true;
    if (timedOut) {
      postSession({ type: "dead", limit: "time" });
      return;
    }
    const detail = error as { name?: unknown; message?: unknown } | null;
    const message =
      typeof detail === "object" && detail !== null && typeof detail.message === "string"
        ? `${String(detail.name)}: ${detail.message}`
        : undefined;
    if (
      message === undefined ||
      message === OUT_OF_MEMORY ||
      message.startsWith(WASM_OUT_OF_BOUNDS)
    ) {
      postSession({ type: "dead", limit: "memory" });
    } else {
      postSession({ type: "dead", message });
    }
  };

  const request = vm.newFunction("request", (position, id, input) => {
    const deferred = vm.newPromise();
    const ordinal = vm.getNumber(position);
    pending.set(ordinal, deferred);
    queue.push({ position: ordinal, id: vm.getString(id), input: vm.getString(input) });
    return deferred.handle;
  });
  const end = vm.newFunction("end", (text) => {
    const outcome = JSON.parse(vm.getString(text)) as SessionEnded;
    if (timedOut) {
      die(null);
    } else if (!outcome.ok && outcome.error?.message === OUT_OF_MEMORY) {
      die({ name: "InternalError", message: "out of memory" });
    } else {
      ended = outcome;
    }
  });
  const fatalNative = vm.newFunction("fatal", (kind, message) => {
    fatal ??= { kind: vm.getString(kind), message: vm.getString(message) };
  });
  const log = vm.newFunction("log", (text) => {
    logs.push(vm.getString(text));
  });

  const drain = (): void => {
    const jobs = inGuest(() => runtime.executePendingJobs());
    if (jobs.error) {
      const dumped: unknown = vm.dump(jobs.error);
      jobs.error.dispose();
      die(dumped);
    }
  };

  let audit: QuickJSHandle | undefined;
  const unobservedSteps = (): { n: number; kind: string; message: string }[] => {
    if (ended === null || audit === undefined) {
      return [];
    }
    const result = vm.unwrapResult(inGuest(() => vm.callFunction(audit!, vm.undefined)));
    const text = vm.getString(result);
    result.dispose();
    return JSON.parse(text) as { n: number; kind: string; message: string }[];
  };

  const report = (): void => {
    if (dead) {
      return;
    }
    const unobserved = unobservedSteps();
    postSession({
      type: "drained",
      requests: queue,
      orphans,
      ended,
      unobserved,
      ...(fatal === undefined ? {} : { fatal }),
      logs,
    });
    queue = [];
    orphans = [];
    logs = [];
  };

  try {
    const prelude = vm.unwrapResult(vm.evalCode(GUEST_STEP, "guest-step.js"));
    const limits = vm.unwrapResult(
      vm.evalCode(`({ maxAll: ${Number(init.maxAll)} })`, "limits.js"),
    );
    const args = [
      request,
      end,
      fatalNative,
      log,
      vm.newNumber(init.seed),
      vm.newNumber(init.now),
      vm.newString(init.script),
      limits,
    ];
    const started = inGuest(() => vm.callFunction(prelude, vm.undefined, ...args));
    prelude.dispose();
    for (const handle of args.slice(4)) {
      handle.dispose();
    }
    if (started.error) {
      const dumped: unknown = vm.dump(started.error);
      started.error.dispose();
      die(dumped);
      return;
    }
    audit = started.value;
    drain();
    report();
  } catch (error) {
    die(error);
  }

  onDeliver = (message) => {
    if (dead) {
      return;
    }
    try {
      const settled: QuickJSDeferredPromise[] = [];
      for (const reply of message.replies) {
        const deferred = pending.get(reply.position);
        if (deferred === undefined) {
          orphans.push(reply.position);
          continue;
        }
        pending.delete(reply.position);
        const text = vm.newString(
          JSON.stringify(
            reply.ok ? { ok: true, value: reply.value } : { ok: false, error: reply.error },
          ),
        );
        deferred.resolve(text);
        text.dispose();
        settled.push(deferred);
      }
      drain();
      for (const deferred of settled) {
        deferred.dispose();
      }
      report();
    } catch (error) {
      die(error);
    }
  };
}

self.onmessage = (
  event: MessageEvent<ScriptWorkerInit | ScriptWorkerReply | SessionInit | SessionDeliver>,
) => {
  const data = event.data;
  if ("type" in data) {
    if (data.type === "session-init") {
      startSession(data).catch((error: unknown) => {
        postSession({
          type: "dead",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    } else {
      onDeliver(data);
    }
  } else if ("script" in data) {
    run(data).catch((error: unknown) => {
      post({
        type: "fatal",
        code: "script.engine_start_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    onReply(data);
  }
};
