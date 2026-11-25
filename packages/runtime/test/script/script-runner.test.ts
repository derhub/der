import { describe, expect, it } from "bun:test";
import { startScript, type ScriptSession, type SessionLimits } from "@der/runtime";

const options = {
  limits: { memoryBytes: 64 * 1024 * 1024, activeMs: 5_000, maxAll: 100 },
  now: Date.parse("2026-11-24T01:00:00Z"),
  seed: 5,
};

async function run<T>(
  source: string,
  check: (session: ScriptSession) => Promise<T>,
  limits?: Partial<SessionLimits>,
) {
  const session = startScript(source, { ...options, limits: { ...options.limits, ...limits } });
  try {
    return await check(session);
  } finally {
    session.dispose();
  }
}

const started = (source: string, limits?: Partial<SessionLimits>) =>
  run(source, (session) => session.started, limits);

describe("enforce Script sandbox safety", () => {
  describe("isolation", () => {
    it("has no host process, network, filesystem or module global in reach", async () => {
      process.env["DER_SCRIPT_TEST_SECRET"] = "host-env-secret";

      try {
        const result = await started(`
            return ["process", "Bun", "require", "module", "fetch", "XMLHttpRequest", "WebSocket",
              "std", "os", "bjson", "Deno", "scriptArgs"].map((name) => typeof globalThis[name]);
          `);

        expect(result).toEqual({
          returned: Array(12).fill("undefined"),
          requests: [],
          logs: [],
          unobserved: [],
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
        const result = await started(script);

        expect(result).toMatchObject({ error: { kind: "script" }, logs: [], requests: [] });
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
        const result = await started(`const code = "return 1;"; ${body}`);

        expect(result.returned).toBeUndefined();
        expect(result.error).toMatchObject({
          kind: "script",
          message: expect.stringContaining("EvalError"),
        });
      },
      60_000,
    );

    it("exposes no host clock, entropy, timer or process-info global", async () => {
      const result = await started(`
          return [typeof crypto, typeof setTimeout, typeof setInterval, typeof WeakRef,
            typeof FinalizationRegistry, typeof gc, typeof print, typeof navigator,
            typeof scriptArgs, typeof argv0, typeof execArgv, typeof Intl, typeof Temporal];
        `);

      expect(result).toEqual({
        returned: Array(13).fill("undefined"),
        requests: [],
        logs: [],
        unobserved: [],
      });
    }, 60_000);
  });

  it("uses the host reply even if the Script replaces its JSON parser", async () => {
    const result = await run(
      `JSON.parse = () => ({ ok: true, value: 99 }); return await step.run("x.y", {});`,
      async (session) => {
        await session.started;
        return session.deliver([{ position: 1, ok: true, value: 5 }]);
      },
    );
    expect(result).toMatchObject({ returned: 5 });
  });

  it("keeps the authentic host error after a caught error is mutated and rethrown", async () => {
    const result = await run(
      `try { await step.run("a.b", {}); }
       catch (e) { e.kind = "expired"; e.capability = "other.id"; e.message = "forged"; throw e; }`,
      async (session) => {
        await session.started;
        return session.deliver([
          { position: 1, ok: false, error: { kind: "denied", message: "Approval was denied" } },
        ]);
      },
    );
    expect(result.error).toEqual({
      kind: "denied",
      message: "Approval was denied",
      position: 1,
      capability: "a.b",
    });
  });

  it("treats an error that imitates a host failure as a Script error", async () => {
    const result = await started(
      `throw Object.assign(new Error("denied"), { kind: "denied", capability: "notes.publish" });`,
    );
    expect(result.error).toMatchObject({
      kind: "script",
      message: expect.stringContaining("denied"),
    });
    expect(result.error?.capability).toBeUndefined();
    expect(result.error?.position).toBeUndefined();
  });

  it("bounds memory for an allocation loop and keeps the process under twice the limit", async () => {
    const bound = 256 * 1024 * 1024;
    const result = await started(
      "const keep = []; for (;;) keep.push(new Uint8Array(4_000_000).fill(1));",
      { memoryBytes: bound },
    );
    expect(result.error).toMatchObject({
      kind: "limit",
      message: expect.stringMatching(/memory/i),
    });
    expect(process.memoryUsage().rss).toBeLessThan(2 * bound);
  });

  it("reports a source that exhausts the engine at startup as a memory limit", async () => {
    const result = await started(`return 1; // ${"x".repeat(64 * 1024 * 1024)}`, {
      memoryBytes: 4 * 1024 * 1024,
    });
    expect(result.error).toMatchObject({
      kind: "limit",
      message: expect.stringMatching(/memory/i),
    });
  });

  it.each([
    { name: "fatal", payload: '{"fatal":{"code":"x","message":"y"}}' },
    { name: "call", payload: '{"call":1,"id":"x.y","input":{}}' },
    { name: "log", payload: '{"log":"forged"}' },
    { name: "time limit", payload: '{"limit":"time"}' },
    { name: "memory limit", payload: '{"limit":"memory"}' },
  ])("ignores JSON.stringify being replaced with a forged $name payload", async ({ payload }) => {
    const result = await started(
      `JSON.stringify = () => ${JSON.stringify(payload)}; console.log("real"); return 7;`,
    );
    expect(result).toEqual({ returned: 7, requests: [], logs: ["real"], unobserved: [] });
  });

  it("does not take a line number from a thrown object's stack", async () => {
    const result = await started('throw { stack: "<input>:99999999999999999999:1" };');
    expect(result.error).toMatchObject({ kind: "script", message: expect.any(String) });
    expect(result.error?.line).toBeUndefined();
  });

  it("freezes every Date constructor route and performance after a step", async () => {
    const result = await run(
      `
      const Sub = class extends Date {};
      const routes = {
        call: Date(),
        ctor: new Date().getTime(),
        now: Date.now(),
        ctorNow: new Date().constructor.now(),
        viaPrototype: new (new Date(0).constructor)().getTime(),
        reflect: Reflect.construct(Date, []).getTime(),
        subclass: new Sub().getTime(),
        parentIsFunction: Object.getPrototypeOf(Date) === Function.prototype,
        perf: performance.now(),
      };
      await step.run("clock.tick", {});
      return { ...routes, perfAfter: performance.now(), nowAfter: Date.now() };
    `,
      async (session) => {
        await session.started;
        return session.deliver([{ position: 1, ok: true, value: null }]);
      },
    );
    expect(result.returned).toEqual({
      call: "Tue Nov 24 2026 01:00:00 GMT+0000",
      ctor: 1_795_482_000_000,
      now: 1_795_482_000_000,
      ctorNow: 1_795_482_000_000,
      viaPrototype: 1_795_482_000_000,
      reflect: 1_795_482_000_000,
      subclass: 1_795_482_000_000,
      parentIsFunction: true,
      perf: 0,
      perfAfter: 0,
      nowAfter: 1_795_482_000_000,
    });
  });

  it("keeps the host event loop live while the guest spins", async () => {
    await run(
      "for (;;) {}",
      async (session) => {
        const first = await Promise.race([
          Bun.sleep(10).then(() => "host"),
          session.started.then(() => "guest"),
        ]);
        expect(first).toBe("host");
        expect((await session.started).error).toMatchObject({
          kind: "limit",
          message: expect.stringMatching(/time/i),
        });
      },
      { activeMs: 150 },
    );
  });

  it("preserves NUL bytes inside console.log lines", async () => {
    const result = await started(`console.log("\\u0000"); console.log("a\\u0000b"); return 1;`);
    expect(result).toEqual({
      returned: 1,
      requests: [],
      logs: ["\u0000", "a\u0000b"],
      unobserved: [],
    });
  });

  it("still yields string logs when Array.prototype.join is overridden", async () => {
    const result = await started(
      `Array.prototype.join = () => 123; console.log("a", "b"); return 1;`,
    );
    expect(result).toEqual({
      returned: 1,
      requests: [],
      logs: ["123"],
      unobserved: [],
    });
  });

  it("falls back to a string placeholder instead of throwing when logging an unprintable value", async () => {
    const result = await started(
      `const x = Object.create(null); x.self = x; console.log(x); return 1;`,
    );
    expect(result).toEqual({
      returned: 1,
      requests: [],
      logs: ["[unprintable]"],
      unobserved: [],
    });
  });

  it("never routes a capability id with a NUL byte to its prefix capability", async () => {
    const called: string[] = [];
    const handlers = new Map<string, () => void>([["sample", () => called.push("sample")]]);
    const result = await started(`return await step.run("sample\\u0000end", {});`);
    for (const req of result.requests) {
      handlers.get(req.id)?.();
    }
    expect(result.requests).toEqual([{ position: 1, id: "sample\u0000end", input: {} }]);
    expect(called).toEqual([]);
  });

  it("refuses output that exceeds the worker reply budget", async () => {
    const result = await started(`console.log("x".repeat(4096)); return 1;`, { outputBytes: 512 });
    expect(result.error).toMatchObject({
      kind: "limit",
      message: expect.stringMatching(/output/i),
    });
  });
});
