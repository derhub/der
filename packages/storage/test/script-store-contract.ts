import { afterEach, describe, expect, it } from "bun:test";
import type { ExecuteResult, NewStep, ScriptStore, UtcTimestamp } from "@der/domain";

export interface ScriptStoreHarness {
  readonly store: ScriptStore;
  /** A store over the same data, as after a process restart. */
  reopen(): ScriptStore;
  newRun(): Promise<{ readonly runId: string; readonly botId: string }>;
  /** Moves the store's clock forward. */
  advance(ms: number): void;
  now(): UtcTimestamp;
  dispose(): void;
}

const done: ExecuteResult = { ok: true, result: 3, logs: [], truncated: false };
const failed: ExecuteResult = {
  ok: false,
  error: { kind: "script", message: "boom" },
  logs: [],
};

function step(position: number, input: NewStep["input"] = { n: position }): NewStep {
  return {
    position,
    capability: "notes.append",
    effect: "write",
    decision: "allow",
    inputHash: `hash-${position}`,
    input,
  };
}

/** Behavior every ScriptStore adapter must keep. */
export function scriptStoreContract(open: () => Promise<ScriptStoreHarness>): void {
  const harnesses: ScriptStoreHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) {
      harnesses.pop()!.dispose();
    }
  });

  async function start() {
    const harness = await open();
    harnesses.push(harness);
    const { runId, botId } = await harness.newRun();
    const execution = harness.store.acquire({ runId, botId, source: "return 1", seed: 7 });
    return { harness, store: harness.store, execution, runId, botId };
  }

  describe("acquire an execution", () => {
    it("returns the unfinished execution of the same source and starts the next occurrence after it finished", async () => {
      const { store, execution, runId, botId } = await start();

      const again = store.acquire({ runId, botId, source: "return 1", seed: 99 });
      store.finish(execution.id, { status: "completed", result: done });
      const next = store.acquire({ runId, botId, source: "return 1", seed: 99 });

      expect({
        sameId: again.id === execution.id,
        seed: again.seed,
        status: execution.status,
        occurrences: [execution.occurrence, next.occurrence],
        nextSeed: next.seed,
      }).toEqual({
        sameId: true,
        seed: 7,
        status: "running",
        occurrences: [1, 2],
        nextSeed: 99,
      });
    });
  });

  describe("register steps", () => {
    it("keeps the first input of a position and returns it to both callers", async () => {
      const { store, execution } = await start();

      const first = store.registerSteps(execution.id, [step(1, { text: "first" })]);
      const second = store.registerSteps(execution.id, [step(1, { text: "second" }), step(2)]);

      expect(first.map((s) => s.input)).toEqual([{ text: "first" }]);
      expect(second.map((s) => [s.position, s.input])).toEqual([
        [1, { text: "first" }],
        [2, { n: 2 }],
      ]);
    });
  });

  describe("complete a step", () => {
    it("settles a pending step once and keeps the first result", async () => {
      const { store, execution } = await start();
      store.registerSteps(execution.id, [step(1)]);

      store.completeStep(execution.id, 1, { status: "done", result: { id: "first" } });
      store.completeStep(execution.id, 1, { status: "failed", error: { kind: "failed" } });

      const [stored] = store.load(execution.id).steps;
      expect([stored!.status, stored!.result, stored!.error]).toEqual([
        "done",
        { id: "first" },
        null,
      ]);
    });
  });

  describe("deliver results", () => {
    it("numbers positions in call order, one batch per call, once per position", async () => {
      const { store, execution } = await start();
      store.registerSteps(execution.id, [step(1), step(2), step(3)]);

      const first = store.markDelivered(execution.id, [3, 1]);
      const second = store.markDelivered(execution.id, [2]);
      const repeat = store.markDelivered(execution.id, [3, 2]);

      expect(first).toEqual([
        { position: 3, seq: 1, batch: 1 },
        { position: 1, seq: 2, batch: 1 },
      ]);
      expect(second).toEqual([{ position: 2, seq: 3, batch: 2 }]);
      expect(repeat).toEqual([
        { position: 3, seq: 1, batch: 1 },
        { position: 2, seq: 3, batch: 2 },
      ]);
      expect(store.load(execution.id).steps.map((s) => [s.position, s.seq, s.batch])).toEqual([
        [1, 2, 1],
        [2, 3, 2],
        [3, 1, 1],
      ]);
    });
  });

  describe("restart", () => {
    it("returns the same execution, steps, results and delivery order", async () => {
      const { harness, store, execution } = await start();
      store.registerSteps(execution.id, [step(1), step(2)]);
      store.completeStep(execution.id, 1, { status: "done", result: { id: "a" } });
      store.markDelivered(execution.id, [2, 1]);
      const before = store.load(execution.id);

      const after = harness.reopen().load(execution.id);

      expect(after).toEqual(before);
      expect(after.steps.map((s) => [s.position, s.status, s.result, s.seq])).toEqual([
        [1, "done", { id: "a" }, 2],
        [2, "pending", null, 1],
      ]);
    });
  });

  describe("lease an execution", () => {
    it("refuses a second owner until the first lease expires", async () => {
      const { harness, store, execution } = await start();
      const until = new Date(Date.parse(harness.now()) + 1000).toISOString() as UtcTimestamp;

      const first = store.takeLease(execution.id, "a", until);
      const rival = store.takeLease(execution.id, "b", until);
      harness.advance(1000);
      const afterExpiry = store.takeLease(execution.id, "b", until);

      expect([first, rival, afterExpiry]).toEqual([true, false, true]);
    });

    it("lists only unfinished executions whose lease is absent or expired", async () => {
      const { harness, store, execution, runId, botId } = await start();
      const other = store.acquire({ runId, botId, source: "return 2", seed: 1 });
      const finished = store.acquire({ runId, botId, source: "return 3", seed: 1 });
      store.finish(finished.id, { status: "completed", result: done });
      const until = new Date(Date.parse(harness.now()) + 1000).toISOString() as UtcTimestamp;
      store.takeLease(execution.id, "a", until);

      const leased = store.listDrivable(harness.now());
      harness.advance(1000);
      const expired = store.listDrivable(harness.now());
      store.releaseLease(execution.id, "a");

      expect([...leased]).toEqual([other.id]);
      expect([...expired].sort()).toEqual([execution.id, other.id].sort());
    });

    it("lets only the holder release it", async () => {
      const { harness, store, execution } = await start();
      const until = new Date(Date.parse(harness.now()) + 1000).toISOString() as UtcTimestamp;
      store.takeLease(execution.id, "a", until);

      store.releaseLease(execution.id, "b");
      const rival = store.takeLease(execution.id, "b", until);
      store.releaseLease(execution.id, "a");
      const afterRelease = store.takeLease(execution.id, "b", until);

      expect([rival, afterRelease]).toEqual([false, true]);
    });
  });

  describe("finish an execution", () => {
    it("keeps the first status and result when finished twice", async () => {
      const { store, execution } = await start();

      store.finish(execution.id, { status: "completed", result: done });
      const second = store.finish(execution.id, { status: "failed", result: failed });

      expect(second.execution.status).toBe("completed");
      expect(second.execution.result).toEqual(done);
    });

    it("accepts in_doubt as a terminal status", async () => {
      const { store, execution, runId, botId } = await start();

      const outcome = store.finish(execution.id, { status: "in_doubt", result: failed });
      const next = store.acquire({ runId, botId, source: "return 1", seed: 1 });

      expect([outcome.execution.status, next.occurrence]).toEqual(["in_doubt", 2]);
    });

    it("reports detached only after detach, which succeeds once", async () => {
      const { store, execution, runId, botId } = await start();
      const plain = store.finish(execution.id, { status: "completed", result: done });
      const other = store.acquire({ runId, botId, source: "return 2", seed: 1 });

      const first = store.detach(other.id);
      const second = store.detach(other.id);
      const detached = store.finish(other.id, { status: "completed", result: done });

      expect([plain.detached, first, second, detached.detached]).toEqual([
        false,
        true,
        false,
        true,
      ]);
    });

    it("refuses to detach an execution that already finished", async () => {
      const { store, execution } = await start();
      store.finish(execution.id, { status: "completed", result: done });

      const detached = store.detach(execution.id);
      const { execution: stored } = store.load(execution.id);

      expect([detached, stored.detachedAt]).toEqual([false, null]);
    });
  });
}
