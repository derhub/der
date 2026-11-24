// The sandbox runtime of an await Script. `step` is the only door to the host. The user text is compiled with the
// AsyncFunction constructor, which sees the global scope and nothing of this closure, so a Script cannot reach `request`.
// A step is a StepPromise (a Promise subclass whose `then` records that something observes it); `await`, Promise.all,
// Promise.race and .catch all go through `then`.

export const GUEST_STEP = String.raw`(function (request, endScript, fatalNative, log, seed, now, source, limits) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const NativePromise = Promise;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  let ordinal = 0;
  let ended = false;
  const observed = new WeakSet();
  const brand = new WeakSet();
  const meta = new WeakMap();
  const floating = new Map();
  const stepErrors = new WeakMap();

  class StepError extends Error {
    constructor(n, capability, input, e) {
      super(e.message);
      this.name = "StepError";
      this.kind = e.kind;
      this.step = n;
      this.capability = capability;
      this.input = input;
      stepErrors.set(this, { message: e.message, kind: e.kind, step: n, capability });
    }
  }

  class StepPromise extends Promise {
    static get [Symbol.species]() { return NativePromise; }
    then(onFulfilled, onRejected) {
      observed.add(this);
      const m = meta.get(this);
      if (m !== undefined) floating.delete(m);
      return super.then(onFulfilled, onRejected);
    }
  }

  function fatal(kind, message) {
    fatalNative(kind, message);
    throw new Error(message);
  }

  function describe(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "an array";
    if (typeof v === "object") { const tag = Object.prototype.toString.call(v).slice(8, -1); return tag === "Object" ? "an object" : "a " + tag; }
    return typeof v === "string" ? JSON.stringify(v) : String(typeof v === "function" ? "a function" : v);
  }

  function check(v, path, depth) {
    if (depth > 64) throw new TypeError("step.run: " + path + " is nested more than 64 levels (or cyclic)");
    if (v === null || typeof v === "boolean" || typeof v === "string") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new TypeError("step.run: " + path + " is " + v + ", which JSON cannot hold");
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (!(i in v)) throw new TypeError("step.run: " + path + "[" + i + "] is a hole in the array");
        check(v[i], path + "[" + i + "]", depth + 1);
      }
      return;
    }
    if (typeof v === "object") {
      if (brand.has(v)) throw new TypeError("step.run: " + path + " is a step promise; await it and pass its result");
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("step.run: " + path + " is " + describe(v) + ", not plain JSON data");
      for (const k of Object.keys(v)) check(v[k], path + "." + k, depth + 1);
      return;
    }
    throw new TypeError("step.run: " + path + " is " + describe(v) + ", not JSON");
  }

  function run(id, input) {
    if (ended) fatal("late", "step.run(" + stringify(id) + ") was called after the Script returned, from code nothing awaited. Await every function that starts steps.");
    if (typeof id !== "string" || id === "") throw new TypeError("step.run: the capability id must be a non-empty string, got " + describe(id));
    const value = input === undefined ? {} : input;
    check(value, "input", 0);
    const n = (ordinal += 1);
    const inputText = stringify(value);
    const raw = request(n, id, inputText);
    const p = new StepPromise((resolve, reject) => {
      raw.then((text) => {
        const reply = parse(text);
        if (reply.ok) return resolve(reply.value);
        const error = new StepError(n, id, parse(inputText), reply.error);
        if (!observed.has(p)) floating.set(n, error);
        reject(error);
      });
    });
    brand.add(p);
    meta.set(p, n);
    // A step promise has no data of its own: reading .value of a step that was not awaited is the commonest mistake, so it is loud
    const guarded = new Proxy(p, {
      get(target, key) {
        if (typeof key === "string" && key !== "then" && key !== "catch" && key !== "finally" && key !== "constructor") {
          throw new TypeError("step " + n + " (" + id + ") is a promise, not its result: write await before step.run (it has no property " + stringify(key) + ")");
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    brand.add(guarded);
    return guarded;
  }

  function elements(name, items) {
    if (!Array.isArray(items)) throw new TypeError(name + " takes an array, got " + describe(items));
    if (items.length > limits.maxAll) fatal("limit", name + " got " + items.length + " elements; the limit is " + limits.maxAll + " per call.");
    for (let i = 0; i < items.length; i += 1) {
      const x = items[i];
      if (x instanceof NativePromise && Object.prototype.toString.call(x) === "[object Promise]") continue;
      throw new TypeError(name + " element " + i + " is " + describe(x) + ", not a promise: pass step.run(...) calls or calls of async functions");
    }
    return items;
  }
  const all = (items) => NativePromise.all(elements("step.all", items));
  const allSettled = (items) => NativePromise.allSettled(elements("step.allSettled", items));
  const step = Object.freeze({ run, all, allSettled });

  function installReplayedClockAndRandom() {
    let state = seed >>> 0;
    Math.random = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const NativeDate = Date;
    function ReplayDate(...args) {
      if (!new.target) return new NativeDate(now).toString();
      return Reflect.construct(NativeDate, args.length === 0 ? [now] : args, new.target);
    }
    ReplayDate.prototype = NativeDate.prototype;
    NativeDate.prototype.constructor = ReplayDate;
    ReplayDate.UTC = NativeDate.UTC;
    ReplayDate.parse = NativeDate.parse;
    ReplayDate.now = () => now;
    globalThis.Date = ReplayDate;
    globalThis.performance = { now: () => 0, timeOrigin: now };
    delete globalThis.WeakRef;
    delete globalThis.FinalizationRegistry;
  }

  function installConsole() {
    const write = (...args) => log(args.map((a) => { if (typeof a === "string") return a; try { const t = stringify(a); return t === undefined ? String(a) : t; } catch { return String(a); } }).join(" "));
    globalThis.console = { log: write, info: write, warn: write, error: write, debug: write };
  }

  function disableCodeGeneration() {
    const refuse = function () { throw new EvalError("code generation from strings is not available in a Script"); };
    const constructors = [Function, AsyncFunction, Object.getPrototypeOf(function* () {}).constructor, Object.getPrototypeOf(async function* () {}).constructor];
    for (const native of constructors) {
      const stub = function () { return refuse(); };
      stub.prototype = native.prototype;
      Object.defineProperty(native.prototype, "constructor", { value: stub, writable: true, configurable: true });
      if (native === Function) globalThis.Function = stub;
    }
    globalThis.eval = refuse;
  }

  const failure = (e) => {
    if (stepErrors.has(e)) return stepErrors.get(e);
    if (e instanceof ReferenceError && /\bder\b/.test(e.message)) {
      return { message: "der is not available: call a capability with await step.run(id, input)", kind: "script" };
    }
    return { message: e instanceof Error ? e.name + ": " + e.message : String(e), kind: "script" };
  };

  async function main() {
    let outcome;
    try {
      const fn = new AsyncFunction("step", source);
      disableCodeGeneration();
      const value = await fn(step);
      const text = stringify(value === undefined ? null : value);
      outcome = { ok: true, text: text === undefined ? "null" : text };
    } catch (e) {
      outcome = { ok: false, error: failure(e) };
    }
    ended = true;
    endScript(stringify(outcome));
  }

  installReplayedClockAndRandom();
  installConsole();
  main();
  return () => stringify([...floating.entries()].map(([n, e]) => ({ n, ...stepErrors.get(e) })));
})`;
