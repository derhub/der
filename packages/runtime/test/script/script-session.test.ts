import { describe, expect, it } from "bun:test";
import {
  startScript,
  type ScriptDrain,
  type ScriptSession,
  type SessionLimits,
  type StepResult,
} from "@der/runtime";

const NOW = 1_795_000_000_000;
const MB = 1024 * 1024;
const roomy: SessionLimits = { memoryBytes: 1024 * MB, activeMs: 20_000, maxAll: 100 };

const ok = (position: number, value: string): StepResult => ({ position, ok: true, value });

async function inSession<T>(
  source: string,
  run: (session: ScriptSession) => Promise<T>,
  options: { seed?: number; limits?: SessionLimits } = {},
): Promise<T> {
  const session = startScript(source, {
    seed: options.seed ?? 1,
    now: NOW,
    limits: options.limits ?? roomy,
  });
  try {
    return await run(session);
  } finally {
    session.dispose();
  }
}

const requested = (drain: ScriptDrain) =>
  drain.requests.map((r) => ({ position: r.position, id: r.id, input: r.input }));

describe("run a Script as steps", () => {
  it("reports three steps started before the first await in one drain", async () => {
    const source = `
      const a = step.run("a", { n: 1 });
      const b = step.run("b", { n: 2 });
      const c = step.run("c", { n: 3 });
      return await step.all([a, b, c]);`;
    await inSession(source, async (session) => {
      const first = await session.started;
      expect(requested(first)).toEqual([
        { position: 1, id: "a", input: { n: 1 } },
        { position: 2, id: "b", input: { n: 2 } },
        { position: 3, id: "c", input: { n: 3 } },
      ]);
      expect("returned" in first).toBe(false);
      const last = await session.deliver([ok(1, "A"), ok(2, "B"), ok(3, "C")]);
      expect(last.returned).toEqual(["A", "B", "C"]);
    });
  });

  it("requests the same steps at the same positions when results arrive in a different order than the calls", async () => {
    const source = `
      const x = step.run("x", {});
      const y = step.run("y", {});
      const first = await y;
      const z = await step.run("z", { first });
      return [first, await x, z];`;
    const play = () =>
      inSession(source, async (session) => {
        const drains = [await session.started];
        drains.push(await session.deliver([ok(2, "Y")]));
        drains.push(await session.deliver([ok(1, "X"), ok(3, "Z")]));
        return drains;
      });
    const expected = [
      [
        { position: 1, id: "x", input: {} },
        { position: 2, id: "y", input: {} },
      ],
      [{ position: 3, id: "z", input: { first: "Y" } }],
      [],
    ];
    for (const drains of [await play(), await play()]) {
      expect(drains.map(requested)).toEqual(expected);
      expect(drains[2]?.returned).toEqual(["Y", "X", "Z"]);
    }
  });

  it.each([
    { delivered: 2, expected: "B" },
    { delivered: 1, expected: "A" },
  ])(
    "lets Promise.race pick step $delivered when it is delivered first",
    async ({ delivered, expected }) => {
      const source = `return await Promise.race([step.run("a", {}), step.run("b", {})]);`;
      for (let run = 0; run < 2; run += 1) {
        const drain = await inSession(source, async (session) => {
          await session.started;
          return session.deliver([ok(delivered, expected)]);
        });
        expect(drain.returned).toBe(expected);
      }
    },
  );

  it("gives two sessions with the same seed and now the same random numbers and clock", async () => {
    const source = `return [Math.random(), Math.random(), Date.now(), new Date().getTime()];`;
    const play = (seed: number) =>
      inSession(source, async (session) => (await session.started).returned, { seed });
    const first = await play(7);
    expect(await play(7)).toEqual(first);
    expect(await play(8)).not.toEqual(first);
    expect((first as number[]).slice(2)).toEqual([NOW, NOW]);
  });

  it("reports a rejected step nobody awaited and not one awaited in try/catch", async () => {
    const rejection = {
      position: 1,
      ok: false,
      error: { kind: "capability", message: "memory.read failed" },
    } satisfies StepResult;
    const forgotten = `
      step.run("bad", {});
      await step.run("good", {});
      return "done";`;
    const caught = `
      try { await step.run("bad", {}); } catch {}
      return "done";`;

    const forgottenDrain = await inSession(forgotten, async (session) => {
      await session.started;
      return session.deliver([rejection, ok(2, "fine")]);
    });
    expect(forgottenDrain.returned).toBe("done");
    expect(forgottenDrain.unobserved).toEqual([
      { position: 1, kind: "capability", message: "memory.read failed" },
    ]);

    const caughtDrain = await inSession(caught, async (session) => {
      await session.started;
      return session.deliver([rejection]);
    });
    expect(caughtDrain.returned).toBe("done");
    expect(caughtDrain.unobserved).toEqual([]);
  });

  it("throws an error naming await when the state of an un-awaited step is read", async () => {
    const drain = await inSession(
      `const pending = step.run("a", {}); return pending.state;`,
      (session) => session.started,
    );
    expect(drain.error?.kind).toBe("script");
    expect(drain.error?.message).toContain("write await before step.run");
  });

  it("names the path of input that is not plain JSON at the call", async () => {
    const drain = await inSession(
      `try { step.run("a", { nested: { bad: () => 1 } }); } catch (e) { return e.message; }`,
      (session) => session.started,
    );
    expect(drain.returned).toBe("step.run: input.nested.bad is a function, not JSON");
  });

  it("ends the session with an untracked-step error when a step starts after the Script returned", async () => {
    const source = `
      const pending = step.run("a", {});
      (async () => { await pending; step.run("late", {}); })();
      return "early";`;
    await inSession(source, async (session) => {
      expect((await session.started).returned).toBe("early");
      const drain = await session.deliver([ok(1, "A")]);
      expect(drain.error?.kind).toBe("untracked-step");
      expect(drain.error?.message).toContain('step.run("late")');
    });
  });

  it("does not count the time spent waiting for a delivery against the time limit", async () => {
    const limits = { ...roomy, activeMs: 150 };
    await inSession(
      `return await step.run("slow", {});`,
      async (session) => {
        await session.started;
        await Bun.sleep(400);
        expect((await session.deliver([ok(1, "late")])).returned).toBe("late");
      },
      { limits },
    );
  });

  it("stops a busy loop at the time limit", async () => {
    const drain = await inSession(`while (true) {}`, (session) => session.started, {
      limits: { ...roomy, activeMs: 150 },
    });
    expect(drain.error).toEqual({
      kind: "limit",
      message: "active time limit of 150 ms exceeded",
    });
  });

  it("ends a drain at the output limit as soon as its logs pass it, before the drain ends", async () => {
    const drain = await inSession(
      `for (let i = 0; i < 64; i++) console.log("x".repeat(256)); while (true) {}`,
      (session) => session.started,
      { limits: { ...roomy, activeMs: 2_000, outputBytes: 512 } },
    );
    expect(drain.error).toEqual({ kind: "limit", message: "output limit of 512 bytes exceeded" });
  });

  it("tells a Script that calls der to use step.run", async () => {
    const drain = await inSession(`return der.memory.read({});`, (session) => session.started);
    expect(drain.error).toEqual({
      kind: "script",
      message: "der is not available: call a capability with await step.run(id, input)",
    });
  });
});
