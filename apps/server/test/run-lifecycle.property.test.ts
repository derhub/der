import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  formatUtcTimestamp,
  type Engine,
  type EngineEvent,
  type JsonValue,
  type Run,
  type RunEvent,
  type StreamChunk,
} from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { startServer } from "#main";
import { createRunCoordinator } from "#workflows/coordinator";
import { createDirectWorkflowDriver } from "#workflows/direct-workflow";
import {
  finalizeDirectRunStep,
  finalizeInterruptedUncertainStep,
  persistPendingApprovalStep,
} from "#workflows/run-steps";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const CHUNK_TYPES = [
  "TEXT_MESSAGE_CONTENT",
  "TOOL_CALL_END",
  "ENGINE_ATTEMPT_FINISHED",
  "RUN_FINISHED",
  "RUN_ERROR",
] as const;
const TERMINAL_TYPES = new Set<string>(["RUN_FINISHED", "RUN_ERROR"]);
const ACTIVE = new Set<string>(["queued", "running", "waiting_approval"]);

type ChunkSpec = {
  readonly type: (typeof CHUNK_TYPES)[number];
  readonly reservedKey: boolean;
  readonly flag: boolean | undefined;
};

type Step =
  | { readonly kind: "append"; readonly run: number; readonly chunk: ChunkSpec }
  | {
      readonly kind: "engine";
      readonly run: number;
      readonly chunks: readonly ChunkSpec[];
      readonly end: "completed" | "failed";
    }
  | {
      readonly kind: "finish";
      readonly run: number;
      readonly outcome: "completed" | "failed" | "interrupted";
    }
  | { readonly kind: "interruptUncertain"; readonly run: number }
  | { readonly kind: "requestApproval"; readonly run: number }
  | { readonly kind: "decide"; readonly run: number; readonly status: "approved" | "denied" }
  | { readonly kind: "restart" };

const chunkSpec = fc.record({
  type: fc.constantFrom(...CHUNK_TYPES),
  reservedKey: fc.boolean(),
  flag: fc.constantFrom(true, false, undefined),
});

const runIndex = fc.nat({ max: 2 });

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("append"), run: runIndex, chunk: chunkSpec }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("engine"),
      run: runIndex,
      chunks: fc.array(chunkSpec, { maxLength: 3 }),
      end: fc.constantFrom("completed", "failed"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("finish"),
      run: runIndex,
      outcome: fc.constantFrom("completed", "failed", "interrupted"),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("interruptUncertain"), run: runIndex }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("requestApproval"), run: runIndex }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("decide"),
      run: runIndex,
      status: fc.constantFrom("approved", "denied"),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "restart" as const }) },
);

const scenario = fc.record({
  origins: fc.array(fc.constantFrom("event", "http"), { minLength: 1, maxLength: 3 }),
  steps: fc.array(step, { minLength: 1, maxLength: 10 }),
});

function chunkOf(run: Run, spec: ChunkSpec, n: number): { chunkKey: string; chunk: JsonValue } {
  const chunk: JsonValue =
    spec.type === "ENGINE_ATTEMPT_FINISHED"
      ? {
          type: "CUSTOM",
          name: "der.engine-attempt-finished",
          value: { kind: "completed", suffix: "" },
        }
      : { type: spec.type, runId: run.id, n };
  return {
    chunkKey: spec.reservedKey ? `${run.id}:terminal` : `${run.id}:chunk:${n}`,
    chunk,
  };
}

function scriptedEngine(chunks: readonly ChunkSpec[], end: "completed" | "failed"): Engine {
  return {
    kind: "fixture",
    async *run(run: Run): AsyncIterable<EngineEvent> {
      for (const [n, spec] of chunks.entries()) {
        yield {
          type: "chunk",
          ...chunkOf(run, spec, 100 + n),
          ...(spec.flag === undefined ? {} : { isTerminal: spec.flag }),
        };
      }
      yield end === "completed"
        ? { type: "completed", finalMessage: { parts: [{ type: "text", text: "done" }] } }
        : { type: "failed", code: "engine.scripted", detail: "scripted failure" };
    },
  };
}

function completingEngine(): Engine {
  return scriptedEngine([{ type: "RUN_FINISHED", reservedKey: false, flag: true }], "completed");
}

/** Every ended Run has one terminal chunk, last and matching its status; an active Run has none. */
function streamViolations(store: SqliteStore, runIds: readonly string[]): string[] {
  const violations: string[] = [];
  for (const id of runIds) {
    const status = store.getRun(id)!.status;
    const events: RunEvent[] = store.readRunEventsAfter(id, 0, 10_000);
    const typeOf = (event: RunEvent) =>
      (event.chunk as { readonly type?: unknown } | null)?.type as string | undefined;
    const terminal = events.filter(
      (event) => event.isTerminal || TERMINAL_TYPES.has(typeOf(event) ?? ""),
    );
    const reserved = events.filter((event) => event.chunkKey === `${id}:terminal`);
    const shape = terminal.map((event) => `${typeOf(event)}@${event.sequence}:${event.isTerminal}`);
    if (ACTIVE.has(status)) {
      if (terminal.length > 0 || reserved.length > 0) {
        violations.push(
          `${status} Run holds terminal chunks [${shape.join(",")}] or reserved rows ${reserved.length}`,
        );
      }
      continue;
    }
    const expected = status === "completed" ? "RUN_FINISHED" : "RUN_ERROR";
    const last = events.at(-1);
    const [only] = terminal;
    if (
      only === undefined ||
      terminal.length !== 1 ||
      only !== last ||
      !only.isTerminal ||
      typeOf(only) !== expected ||
      reserved.some((event) => event !== only)
    ) {
      violations.push(
        `${status} Run has terminal chunks [${shape.join(",")}], expected one ${expected} last`,
      );
    }
  }
  return violations;
}

async function restartDirect(dbPath: string, dir: string): Promise<void> {
  const server = await startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateMode: "direct",
      databasePath: dbPath,
      memoryProjectionDir: `${dir}/memory`,
      skillsRootDir: `${dir}/skills`,
      workspaceRootDir: `${dir}/workspaces`,
      enabledEngines: ["fixture"],
      scriptSweepIntervalMs: 50,
    },
    engines: new Map([["fixture", completingEngine()]]),
  });
  try {
    await waitUntil(
      () =>
        server.store.database.db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running', 'waiting_approval')",
          )
          .get()!.n === 0,
      { timeoutMs: 2_000, label: "recovered Runs settled" },
    ).catch(() => undefined);
  } finally {
    await server.close();
  }
}

async function apply(store: SqliteStore, runs: readonly Run[], at: Step, n: number): Promise<void> {
  if (at.kind === "restart") {
    return;
  }
  const run = store.getRun(runs[at.run % runs.length]!.id)!;
  const deps = { store, engines: new Map(), approvalTimeoutMs: 60_000 };
  switch (at.kind) {
    case "append": {
      // Bypasses the type that excludes terminal payloads, to drive the store's own check.
      const { chunkKey, chunk } = chunkOf(run, at.chunk, n);
      await store.appendRunEvents(run.id, [{ chunkKey, chunk: chunk as StreamChunk }]);
      return;
    }
    case "engine": {
      const driver = createDirectWorkflowDriver();
      const coordinator = createRunCoordinator({
        ...deps,
        engines: new Map([["fixture", scriptedEngine(at.chunks, at.end)]]),
        driver,
      });
      try {
        await coordinator.executeRun(run.id, driver);
      } finally {
        driver.close();
      }
      return;
    }
    case "finish":
      await finalizeDirectRunStep(deps, {
        run,
        outcome:
          at.outcome === "completed"
            ? { kind: "completed", finalMessageParts: [{ type: "text", text: "done" }] }
            : at.outcome === "failed"
              ? { kind: "failed", code: "engine.scripted", detail: "scripted failure" }
              : { kind: "interrupted", detail: "scripted interruption" },
      });
      return;
    case "interruptUncertain":
      await finalizeInterruptedUncertainStep(deps, {
        run,
        effectId: `eff_${n}`,
        detail: "scripted uncertain outcome",
      });
      return;
    case "requestApproval":
      await persistPendingApprovalStep(deps, {
        run,
        effect: {
          runId: run.id,
          operationKind: "capability",
          operationId: "notes.append",
          canonicalArguments: { n },
          attemptId: `attempt_${n}`,
        },
        prompt: "Append?",
        awakeable: `awk_${n}`,
        deadline: formatUtcTimestamp(new Date(Date.now() + 60_000)),
      });
      return;
    case "decide": {
      const [pending] = store.listPendingApprovalsForRun(run.id);
      if (pending === undefined) {
        return;
      }
      await store.decide({
        approvalId: pending.id,
        botId: run.botId,
        sessionId: run.sessionId,
        runId: run.id,
        status: at.status,
        actor: "operator",
        decidedAt: formatUtcTimestamp(new Date()),
      });
      return;
    }
  }
}

async function runScenario(input: {
  readonly origins: readonly ("event" | "http")[];
  readonly steps: readonly Step[];
}): Promise<string[]> {
  const tempDb = createTempDatabase("der-lifecycle-property-");
  let store = openSqliteStore({ filename: tempDb.dbPath });
  try {
    store.createBot({
      id: "bot-1",
      name: "Bot",
      persona: "",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
    });
    const runs: Run[] = [];
    for (const [index, origin] of input.origins.entries()) {
      store.createSession({ id: `sess-${index}`, botId: "bot-1", title: `${index}` });
      const { run } = await store.admit({
        botId: "bot-1",
        sessionId: `sess-${index}`,
        origin,
        idempotencyKey: `key-${index}`,
        input: { parts: [{ type: "text", text: "go" }] },
      });
      runs.push(run);
    }
    const ids = runs.map((run) => run.id);
    for (const [n, at] of input.steps.entries()) {
      if (at.kind === "restart") {
        store.close();
        await restartDirect(tempDb.dbPath, tempDb.dir);
        store = openSqliteStore({ filename: tempDb.dbPath });
      } else {
        await apply(store, runs, at, n).catch(() => undefined);
      }
      const violations = streamViolations(store, ids);
      if (violations.length > 0) {
        return [`after step ${n} (${at.kind})`, ...violations];
      }
    }
    return [];
  } finally {
    store.close();
    tempDb.cleanup();
  }
}

describe("property: a Run's stream and status", () => {
  it("gives every ended Run exactly one terminal chunk matching its status and an active Run none", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        expect(await runScenario(input)).toEqual([]);
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
