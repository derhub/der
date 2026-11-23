export const GUEST_PRELUDE = String.raw`(function (log, call, done, seed, now, source) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const WRAPPER_LINES = 2;
  const HOST_ERROR_KINDS = ["denied", "expired", "cancelled", "capability"];

  let clock = now;
  let callOrdinal = 0;

  class HostError extends Error {
    constructor(call, error) {
      super(error && typeof error.message === "string" ? error.message : "capability call failed");
      this.call = call;
      this.kind = error && HOST_ERROR_KINDS.includes(error.kind) ? error.kind : "capability";
    }
  }

  function installReplayedClockAndRandom() {
    const origin = now;
    let state = seed >>> 0;
    Math.random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const NativeDate = Date;
    function ReplayDate(...args) {
      if (!new.target) return new NativeDate(clock).toString();
      return Reflect.construct(NativeDate, args.length === 0 ? [clock] : args, new.target);
    }
    ReplayDate.prototype = NativeDate.prototype;
    NativeDate.prototype.constructor = ReplayDate;
    ReplayDate.UTC = NativeDate.UTC;
    ReplayDate.parse = NativeDate.parse;
    ReplayDate.now = () => clock;
    globalThis.Date = ReplayDate;
    globalThis.performance = { now: () => clock - origin, timeOrigin: origin };
    delete globalThis.WeakRef;
    delete globalThis.FinalizationRegistry;
  }

  function formatLogArgument(value) {
    if (typeof value === "string") return value;
    try {
      const text = stringify(value);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  }

  function installConsole() {
    const write = (...args) => log(args.map(formatLogArgument).join(" "));
    globalThis.console = { log: write, info: write, warn: write, error: write, debug: write };
  }

  async function hostCall(id, input) {
    callOrdinal += 1;
    const reply = parse(await call(callOrdinal, id, stringify(input === undefined ? null : input)));
    if (typeof reply.now === "number") clock = reply.now;
    if (reply.ok) return reply.value;
    throw new HostError(id, reply.error);
  }

  function namespace(path) {
    return new Proxy(function () {}, {
      get(_target, key) {
        return typeof key === "string" && key !== "then" ? namespace([...path, key]) : undefined;
      },
      apply(_target, _this, args) {
        return hostCall(path.join("."), args[0]);
      },
    });
  }

  function disableCodeGeneration() {
    const refuse = function () {
      throw new EvalError("code generation from strings is not available in a Script");
    };
    const constructors = [
      Function,
      AsyncFunction,
      Object.getPrototypeOf(function* () {}).constructor,
      Object.getPrototypeOf(async function* () {}).constructor,
    ];
    for (const native of constructors) {
      const stub = function () {
        return refuse();
      };
      stub.prototype = native.prototype;
      Object.defineProperty(native.prototype, "constructor", {
        value: stub,
        writable: true,
        configurable: true,
      });
      if (native === Function) globalThis.Function = stub;
    }
    globalThis.eval = refuse;
  }

  function lineOf(error) {
    const match = error && typeof error.stack === "string" ? /<input>:(\d+):\d+/.exec(error.stack) : null;
    const line = match ? Number(match[1]) - WRAPPER_LINES : 0;
    return line > 0 ? line : undefined;
  }

  function failure(error) {
    if (error instanceof HostError) {
      return { kind: error.kind, message: error.message, call: error.call };
    }
    const message = error instanceof Error ? error.name + ": " + error.message : String(error);
    return { kind: "script", message, line: lineOf(error) };
  }

  async function main() {
    let outcome;
    try {
      const run = new AsyncFunction("der", source);
      disableCodeGeneration();
      const result = await run(namespace([]));
      outcome = stringify({ result: result === undefined ? null : result });
    } catch (error) {
      outcome = stringify({ error: failure(error) });
    }
    done(outcome);
  }

  installReplayedClockAndRandom();
  installConsole();
  main();
})`;
