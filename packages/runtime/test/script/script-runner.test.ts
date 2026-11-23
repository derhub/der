import { describe, expect, it } from "bun:test";
import type { JsonValue } from "@der/domain";
import { runScript, type ScriptCallReply, type ScriptLimits } from "@der/runtime";

const START = 1_795_000_000_000;
const MB = 1024 * 1024;
const roomyLimits: ScriptLimits = {
  memoryBytes: 1024 * MB,
  activeMs: 20_000,
  maxCalls: 100,
  outputBytes: 1 * MB,
};

interface RecordedCall {
  readonly id: string;
  readonly input: JsonValue;
}

function recordingHost(replies: readonly ScriptCallReply[]) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    call: async (id: string, input: JsonValue): Promise<ScriptCallReply> => {
      calls.push({ id, input });
      const reply = replies[calls.length - 1];
      if (reply === undefined) {
        throw new Error(`no reply scripted for call ${calls.length} (${id})`);
      }
      return reply;
    },
  };
}

const noCalls = async (): Promise<ScriptCallReply> => {
  throw new Error("unexpected host call");
};

describe("run a script", () => {
  describe("host calls", () => {
    it("returns a value computed from three sequential replies", async () => {
      const host = recordingHost([
        { ok: true, value: 1 },
        { ok: true, value: 20 },
        { ok: true, value: 300 },
      ]);

      const result = await runScript({
        script: `
          const a = await der.math.add({ x: 1 });
          const b = await der.math.add({ x: 2 });
          const c = await der.math.add({ x: 3 });
          return a + b + c;
        `,
        call: host.call,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({ ok: true, result: 321, logs: [], truncated: false });
      expect(host.calls).toEqual([
        { id: "math.add", input: { x: 1 } },
        { id: "math.add", input: { x: 2 } },
        { id: "math.add", input: { x: 3 } },
      ]);
    }, 60_000);

    it("returns console output as logs and an uncaught throw as a script error with its line", async () => {
      const result = await runScript({
        script: `console.log("hello", { n: 1 });\nconst x = 1;\nthrow new Error("boom");`,
        call: noCalls,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "script", message: "Error: boom", line: 3 },
        logs: ['hello {"n":1}'],
      });
    }, 60_000);

    it("ends with the host error kind and call id when a reply is an error", async () => {
      const host = recordingHost([
        { ok: false, error: { kind: "denied", message: "operator denied memory.write" } },
      ]);

      const result = await runScript({
        script: `await der.memory.write({ text: "x" }); return "unreachable";`,
        call: host.call,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "denied", message: "operator denied memory.write", call: "memory.write" },
        logs: [],
      });
    }, 60_000);

    it("lets the script catch a failed call and continue", async () => {
      const host = recordingHost([{ ok: false, error: { kind: "capability", message: "nope" } }]);

      const result = await runScript({
        script: `try { await der.a.b({}); } catch (e) { return e.message; }`,
        call: host.call,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({ ok: true, result: "nope", logs: [], truncated: false });
    }, 60_000);
  });

  describe("memory bound", () => {
    it("ends an allocation loop as a limit error and keeps the test process under twice the bound", async () => {
      const bound = 256 * MB;

      const result = await runScript({
        script: `const keep = []; for (;;) keep.push(new Uint8Array(4_000_000).fill(1));`,
        call: noCalls,
        limits: { ...roomyLimits, memoryBytes: bound },
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", message: `memory limit of ${bound} bytes exceeded` },
        logs: [],
      });
      expect(process.memoryUsage().rss).toBeLessThan(2 * bound);
    }, 60_000);

    it("ends a script whose source exhausts the engine memory at start as a limit error", async () => {
      const result = await runScript({
        script: `return 1; // ${"x".repeat(64 * MB)}`,
        call: noCalls,
        limits: { ...roomyLimits, memoryBytes: 4 * MB },
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", message: `memory limit of ${4 * MB} bytes exceeded` },
        logs: [],
      });
    }, 60_000);
  });

  describe("active time", () => {
    it("kills a busy loop at the bound", async () => {
      const started = performance.now();

      const result = await runScript({
        script: `for (;;) {}`,
        call: noCalls,
        limits: { ...roomyLimits, activeMs: 500 },
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", message: "active time limit of 500 ms exceeded" },
        logs: [],
      });
      expect(performance.now() - started).toBeLessThan(15_000);
    }, 60_000);

    it("keeps the host event loop live while a script spins to its time bound", async () => {
      const ticks: number[] = [];
      const timer = setInterval(() => ticks.push(performance.now()), 50);

      const result = await runScript({
        script: `for (;;) {}`,
        call: noCalls,
        limits: { ...roomyLimits, activeMs: 1000 },
        seed: 1,
        now: START,
      }).finally(() => clearInterval(timer));

      const gaps = ticks.slice(1).map((tick, index) => tick - ticks[index]!);
      expect(result).toMatchObject({ ok: false, error: { kind: "limit" } });
      expect(ticks.length).toBeGreaterThanOrEqual(15);
      expect(Math.max(...gaps)).toBeLessThan(200);
    }, 60_000);

    it("completes a script whose call is answered after the bound", async () => {
      const result = await runScript({
        script: `return await der.slow.read({});`,
        call: async () => {
          await Bun.sleep(1500);
          return { ok: true, value: "late" };
        },
        limits: { ...roomyLimits, activeMs: 1000 },
        seed: 1,
        now: START,
      });

      expect(result).toEqual({ ok: true, result: "late", logs: [], truncated: false });
    }, 60_000);
  });

  describe("isolation", () => {
    it("has no host process, network, filesystem or module global in reach", async () => {
      process.env["DER_SCRIPT_TEST_SECRET"] = "host-env-secret";

      try {
        const result = await runScript({
          script: `
            return ["process", "Bun", "require", "module", "fetch", "XMLHttpRequest", "WebSocket",
              "std", "os", "bjson", "Deno", "scriptArgs"].map((name) => typeof globalThis[name]);
          `,
          call: noCalls,
          limits: roomyLimits,
          seed: 1,
          now: START,
        });

        expect(result).toEqual({
          ok: true,
          result: Array(12).fill("undefined"),
          logs: [],
          truncated: false,
        });
      } finally {
        delete process.env["DER_SCRIPT_TEST_SECRET"];
      }
    }, 60_000);

    const importRoutes: ReadonlyArray<readonly [string, string]> = [
      ["a literal dynamic import", `return await import("qjs:os");`],
      ["a dynamic import of a variable", `const n = "qjs:os"; return await import(n);`],
      ["a dynamic import of a path", `return await import("/workspace/guest.mjs");`],
      ["import.meta", `return import.meta;`],
      ["a static import", `import * as os from "qjs:os"; return os.now();`],
      ["a static export", `export const x = 1;`],
      ["eval of an import string", `return await eval("import('qjs:os')");`],
      [
        "new Function over an import string",
        `return await new Function("return import('qjs:os')")();`,
      ],
    ];

    it.each(importRoutes)(
      "fails %s as a script error",
      async (_route, script) => {
        const result = await runScript({
          script,
          call: noCalls,
          limits: roomyLimits,
          seed: 1,
          now: START,
        });

        expect(result).toMatchObject({ ok: false, error: { kind: "script" }, logs: [] });
      },
      60_000,
    );

    const codeGenerationRoutes: ReadonlyArray<readonly [string, string]> = [
      ["eval", `return eval(code);`],
      ["indirect eval", `return (0, eval)(code);`],
      ["new Function", `return new Function(code)();`],
      ["Function called as a function", `return Function(code)();`],
      ["a function constructor", `return (function () {}).constructor(code)();`],
      ["an async function constructor", `return await (async () => {}).constructor(code)();`],
      ["a generator function constructor", `return (function* () {}).constructor(code);`],
      [
        "an async generator function constructor",
        `return (async function* () {}).constructor(code);`,
      ],
      ["Reflect.construct over Function", `return Reflect.construct(Function, [code])();`],
      [
        "Reflect.construct over an async constructor",
        `return Reflect.construct((async () => {}).constructor, [code]);`,
      ],
      ["Function.prototype.constructor", `return Function.prototype.constructor(code)();`],
      ["a subclass of Function", `return new (class extends Function {})(code)();`],
    ];

    it.each(codeGenerationRoutes)(
      "refuses code from a string through %s",
      async (_route, body) => {
        const result = await runScript({
          script: `const code = "return 1;"; ${body}`,
          call: noCalls,
          limits: roomyLimits,
          seed: 1,
          now: START,
        });

        expect(result).toMatchObject({
          ok: false,
          error: {
            kind: "script",
            message: "EvalError: code generation from strings is not available in a Script",
          },
        });
      },
      60_000,
    );

    it("exposes no host clock, entropy, timer or process-info global", async () => {
      const result = await runScript({
        script: `
          return [typeof crypto, typeof setTimeout, typeof setInterval, typeof WeakRef,
            typeof FinalizationRegistry, typeof gc, typeof print, typeof navigator,
            typeof scriptArgs, typeof argv0, typeof execArgv, typeof Intl, typeof Temporal];
        `,
        call: noCalls,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: true,
        result: Array(13).fill("undefined"),
        logs: [],
        truncated: false,
      });
    }, 60_000);
  });

  describe("repeatable run", () => {
    const script = `
      const t0 = Date.now();
      const r0 = Math.random();
      const a = await der.clock.tick({});
      const t1 = Date.now();
      const r1 = Math.random();
      const b = await der.clock.tick({});
      return { t0, t1, t2: Date.now(), iso: new Date().toISOString(), r: [r0, r1], a, b };
    `;
    const replies: ScriptCallReply[] = [
      { ok: true, value: "a", now: START + 5_000 },
      { ok: true, value: "b", now: START + 9_000 },
    ];

    async function once(seed: number) {
      const host = recordingHost(replies);
      const result = await runScript({
        script,
        call: host.call,
        limits: roomyLimits,
        seed,
        now: START,
      });
      return { result, calls: host.calls };
    }

    it("produces the same calls and result on two runs and takes the clock from the replies", async () => {
      const first = await once(42);
      const second = await once(42);

      expect(second).toEqual(first);
      expect(first.calls).toEqual([
        { id: "clock.tick", input: {} },
        { id: "clock.tick", input: {} },
      ]);
      expect(first.result).toMatchObject({
        ok: true,
        result: {
          t0: 1_795_000_000_000,
          t1: 1_795_000_005_000,
          t2: 1_795_000_009_000,
          iso: "2026-11-18T11:06:49.000Z",
          a: "a",
          b: "b",
        },
      });
    }, 120_000);

    it("draws different random values for a different seed", async () => {
      const seeded = await once(42);
      const other = await once(43);

      const randoms = (run: typeof seeded) => (run.result.ok ? (run.result.result as any).r : null);
      expect(randoms(other)).not.toEqual(randoms(seeded));
      for (const value of [...randoms(seeded), ...randoms(other)]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }, 120_000);
    it("answers every Date and performance route from the replayed clock", async () => {
      const result = await runScript({
        script: `
          const sub = class extends Date {};
          const routes = {
            call: Date(),
            ctor: new Date().getTime(),
            now: Date.now(),
            ctorNow: new Date().constructor.now(),
            viaPrototype: new (new Date(0).constructor)().getTime(),
            reflect: Reflect.construct(Date, []).getTime(),
            subclass: new sub().getTime(),
            parentIsFunction: Object.getPrototypeOf(Date) === Function.prototype,
            perf: performance.now(),
          };
          await der.clock.tick({});
          routes.perfAfter = performance.now();
          routes.nowAfter = Date.now();
          return routes;
        `,
        call: async () => ({ ok: true, value: null, now: START + 5_000 }),
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: true,
        result: {
          call: "Wed Nov 18 2026 11:06:40 GMT+0000",
          ctor: 1_795_000_000_000,
          now: 1_795_000_000_000,
          ctorNow: 1_795_000_000_000,
          viaPrototype: 1_795_000_000_000,
          reflect: 1_795_000_000_000,
          subclass: 1_795_000_000_000,
          parentIsFunction: true,
          perf: 0,
          perfAfter: 5_000,
          nowAfter: 1_795_000_005_000,
        },
        logs: [],
        truncated: false,
      });
    }, 60_000);
  });

  describe("forged worker protocol", () => {
    const forgedOutcomes: ReadonlyArray<readonly [string, string]> = [
      ["a fatal payload", `{"fatal":{"code":"x","message":"y"}}`],
      ["a call payload", `{"call":1,"id":"x.y","input":{}}`],
      ["a log payload", `{"log":"forged"}`],
      ["a time limit payload", `{"limit":"time"}`],
      ["a memory limit payload", `{"limit":"memory"}`],
    ];

    it.each(forgedOutcomes)(
      "ignores a script that overwrites JSON.stringify to emit %s",
      async (_name, payload) => {
        const host = recordingHost([]);

        const result = await runScript({
          script: `JSON.stringify = () => '${payload}'; return 1;`,
          call: host.call,
          limits: roomyLimits,
          seed: 1,
          now: START,
        });

        expect(result).toEqual({ ok: true, result: 1, logs: [], truncated: false });
        expect(host.calls).toEqual([]);
      },
      60_000,
    );

    it("ignores a script that overwrites JSON.parse to forge a reply", async () => {
      const host = recordingHost([{ ok: true, value: 5 }]);

      const result = await runScript({
        script: `JSON.parse = () => ({ ok: true, value: 99 }); return await der.x.y({});`,
        call: host.call,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({ ok: true, result: 5, logs: [], truncated: false });
    }, 60_000);

    it("carries a call still queued behind a slow one to its outcome before returning", async () => {
      const calledIds: string[] = [];
      const result = await runScript({
        script: `der.slow.first({}); der.queued.second({}); return 1;`,
        call: async (id) => {
          calledIds.push(id);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { ok: true, value: null };
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({ ok: true, result: 1, logs: [], truncated: false });
      expect(calledIds).toEqual(["slow.first", "queued.second"]);
    }, 60_000);
  });

  describe("forged done envelope", () => {
    const forgeries: ReadonlyArray<readonly [string, string, string]> = [
      ["a non-string message", `{error:n({kind:"script",message:n({a:1})})}`, "script"],
      [
        "kind denied with a call id",
        `{error:n({kind:"denied",message:"forged",call:"notes.publish"})}`,
        "denied",
      ],
      [
        "kind cancelled with a call id",
        `{error:n({kind:"cancelled",message:"forged",call:"notes.publish"})}`,
        "cancelled",
      ],
    ];

    it.each(forgeries)(
      "ignores a toJSON on Object.prototype that forges %s",
      async (_name, forged) => {
        const host = recordingHost([]);

        const result = await runScript({
          script: `const n=(o)=>Object.assign(Object.create(null),o); Object.prototype.toJSON=function(){delete Object.prototype.toJSON; return n(${forged})}; throw new Error("boom");`,
          call: host.call,
          limits: roomyLimits,
          seed: 1,
          now: START,
        });

        expect(result).toEqual({
          ok: false,
          error: { kind: "script", message: "Error: boom", line: 1 },
          logs: [],
        });
      },
      60_000,
    );

    it("reports the host's kind, message and call id when a script mutates a caught host error and rethrows it", async () => {
      const host = recordingHost([
        { ok: false, error: { kind: "denied", message: "Approval for a.b was denied" } },
      ]);

      const result = await runScript({
        script: `try { await der.a.b({}); } catch (e) { e.kind = "expired"; e.call = "other.id"; e.message = "forged"; throw e; }`,
        call: host.call,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "denied", message: "Approval for a.b was denied", call: "a.b" },
        logs: [],
      });
    }, 60_000);

    it("ends as a script error when a script throws a look-alike of a host error", async () => {
      const host = recordingHost([]);

      const result = await runScript({
        script: `throw Object.assign(new Error("denied"), { kind: "denied", call: "notes.publish" });`,
        call: host.call,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "script", message: "Error: denied", line: 1 },
        logs: [],
      });
    }, 60_000);
  });

  describe("a call outlives the verdict", () => {
    const limitCases: ReadonlyArray<readonly [string, string, ScriptLimits]> = [
      [
        "output limit",
        `der.ledger.post({}); for (let i = 0; i < 3000000; i++) {} console.log("x".repeat(5000)); return 1;`,
        { ...roomyLimits, outputBytes: 2_000 },
      ],
      ["time limit", `der.ledger.post({}); for (;;) {}`, { ...roomyLimits, activeMs: 300 }],
      [
        "memory limit",
        `der.ledger.post({}); const keep = []; for (;;) keep.push(new Uint8Array(4_000_000).fill(1));`,
        { ...roomyLimits, memoryBytes: 64 * MB },
      ],
    ];

    it.each(limitCases)(
      "returns only after the write in flight finished when the script hits its %s",
      async (_name, script, limits) => {
        let recorded = false;

        const result = await runScript({
          script,
          call: async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            recorded = true;
            return { ok: true, value: null };
          },
          limits,
          seed: 1,
          now: START,
        });

        expect(result).toMatchObject({ ok: false, error: { kind: "limit" } });
        expect(recorded).toBe(true);
      },
      60_000,
    );

    it("tells a call in flight that the verdict is set so it begins no further stage", async () => {
      const seenSettled: boolean[] = [];

      await runScript({
        script: `der.ledger.post({}); for (let i = 0; i < 3000000; i++) {} console.log("x".repeat(5000)); return 1;`,
        call: async (_id, _input, context) => {
          seenSettled.push(context.settled());
          await new Promise((resolve) => setTimeout(resolve, 300));
          seenSettled.push(context.settled());
          return { ok: true, value: null };
        },
        limits: { ...roomyLimits, outputBytes: 2_000 },
        seed: 1,
        now: START,
      });

      expect(seenSettled).toEqual([false, true]);
    }, 60_000);

    it("returns without waiting for the call when the signal aborts", async () => {
      const controller = new AbortController();
      let reached: () => void = () => {};
      const callReached = new Promise<void>((resolve) => {
        reached = resolve;
      });

      const running = runScript({
        script: `der.ledger.post({}); for (let i = 0; i < 3000000; i++) {} console.log("x".repeat(5000)); return 1;`,
        call: () => {
          reached();
          return new Promise<ScriptCallReply>(() => {});
        },
        limits: { ...roomyLimits, outputBytes: 2_000 },
        seed: 1,
        now: START,
        signal: controller.signal,
      });
      await callReached;
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();

      expect(await running).toMatchObject({ ok: false, error: { kind: "limit" } });
    }, 60_000);
  });

  describe("calls issued without await", () => {
    it("lets a halt after the script returned win over its result", async () => {
      const result = await runScript({
        script: `der.a.b({}); return 1;`,
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { halt: true };
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "cancelled", message: "script halted by the host" },
        logs: [],
      });
    }, 60_000);

    it("rethrows a host failure that happens after the script returned", async () => {
      const failure = await runScript({
        script: `der.a.b({}); return 1;`,
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("store unavailable");
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      }).catch((error: unknown) => error);

      expect((failure as Error).message).toBe("store unavailable");
    }, 60_000);

    it("does not run calls queued behind a call that halted and reports the halt", async () => {
      const calledIds: string[] = [];

      const result = await runScript({
        script: `der.first.call({}); der.second.call({}); return 1;`,
        call: async (id) => {
          calledIds.push(id);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { halt: true };
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(result).toEqual({
        ok: false,
        error: { kind: "cancelled", message: "script halted by the host" },
        logs: [],
      });
      expect(calledIds).toEqual(["first.call"]);
    }, 60_000);

    it("reports the capability error of a call issued without await instead of the script's own result", async () => {
      const result = await runScript({
        script: `der.x.y({}); return { posted: true };`,
        call: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: false, error: { kind: "capability", message: "insufficient funds" } };
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "capability", message: "insufficient funds", call: "x.y" },
        logs: [],
      });
    }, 60_000);

    it("ends as cancelled when the signal aborts while a call is still pending", async () => {
      const controller = new AbortController();
      let reached: () => void = () => {};
      const callReached = new Promise<void>((resolve) => {
        reached = resolve;
      });

      const running = runScript({
        script: `der.approval.wait({}); return 1;`,
        call: () => {
          reached();
          return new Promise<ScriptCallReply>(() => {});
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
        signal: controller.signal,
      });
      await callReached;
      controller.abort();

      expect(await running).toEqual({
        ok: false,
        error: { kind: "cancelled", message: "script cancelled" },
        logs: [],
      });
    }, 60_000);

    it("ends a script that exceeds the call cap with unawaited calls as a limit error", async () => {
      const calledIds: string[] = [];

      const result = await runScript({
        script: `for (let i = 0; i < 5; i++) der.x.y({}); return 1;`,
        call: async (id) => {
          calledIds.push(id);
          return { ok: true, value: null };
        },
        limits: { ...roomyLimits, maxCalls: 3 },
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", message: "call limit of 3 exceeded" },
        logs: [],
      });
      expect(calledIds).toHaveLength(3);
    }, 60_000);
  });

  describe("host failure inside a call", () => {
    const catchThenRead = `try { await der.a.b({}); } catch (e) { await der.after.catch({}); } return 1;`;

    it("halts the script without a reply when the host asks to halt", async () => {
      const calledIds: string[] = [];

      const result = await runScript({
        script: catchThenRead,
        call: async (id) => {
          calledIds.push(id);
          return { halt: true };
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "cancelled", message: "script halted by the host" },
        logs: [],
      });
      expect(calledIds).toEqual(["a.b"]);
    }, 60_000);

    it("halts the script and rethrows when the host call throws", async () => {
      const calledIds: string[] = [];

      const failure = await runScript({
        script: catchThenRead,
        call: async (id) => {
          calledIds.push(id);
          throw new Error("store unavailable");
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
      }).catch((error: unknown) => error);

      expect((failure as Error).message).toBe("store unavailable");
      expect(calledIds).toEqual(["a.b"]);
    }, 60_000);
  });

  describe("reported line", () => {
    it("drops a line beyond the safe integer range from a thrown value", async () => {
      const result = await runScript({
        script: `throw { stack: "<input>:99999999999999999999:1" };`,
        call: noCalls,
        limits: roomyLimits,
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "script", message: "[object Object]" },
        logs: [],
      });
    }, 60_000);
  });

  describe("other limits", () => {
    it("ends a script that exceeds the call count as a limit error", async () => {
      const host = recordingHost([
        { ok: true, value: 1 },
        { ok: true, value: 1 },
        { ok: true, value: 1 },
      ]);

      const result = await runScript({
        script: `for (let i = 0; i < 10; i++) await der.x.y({});`,
        call: host.call,
        limits: { ...roomyLimits, maxCalls: 3 },
        seed: 1,
        now: START,
      });

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", message: "call limit of 3 exceeded" },
        logs: [],
      });
      expect(host.calls).toHaveLength(3);
    }, 60_000);

    it("ends a script that prints past the output bound as a limit error", async () => {
      const result = await runScript({
        script: `for (;;) console.log("x".repeat(1000));`,
        call: noCalls,
        limits: { ...roomyLimits, outputBytes: 50_000 },
        seed: 1,
        now: START,
      });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "limit", message: "output limit of 50000 bytes exceeded" },
      });
    }, 60_000);

    it("ends a script parked on a call as cancelled when the signal aborts", async () => {
      const controller = new AbortController();
      const started = performance.now();
      let parked: () => void = () => {};
      const reachedCall = new Promise<void>((resolve) => {
        parked = resolve;
      });

      const running = runScript({
        script: `return await der.approval.wait({});`,
        call: () => {
          parked();
          return new Promise<ScriptCallReply>(() => {});
        },
        limits: roomyLimits,
        seed: 1,
        now: START,
        signal: controller.signal,
      });
      await reachedCall;
      const abortedAt = performance.now();
      controller.abort();
      const result = await running;

      expect(result).toEqual({
        ok: false,
        error: { kind: "cancelled", message: "script cancelled" },
        logs: [],
      });
      expect(performance.now() - abortedAt).toBeLessThan(1000);
      expect(performance.now() - started).toBeLessThan(30_000);
    }, 60_000);
  });
});
