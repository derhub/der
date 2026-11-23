import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  DomainError,
  type Engine,
  type EngineEvent,
  type EngineKind,
  type EngineReadiness,
  type Run,
} from "@der/domain";
import { MEMORY_ROUTINE_SLOTS_MIGRATION } from "@der/storage/memory";
import { openSqliteRoutines } from "@der/storage/routines";
import { startServer } from "../src/main";
import {
  createRoutineScheduleClient,
  createRoutineScheduleObject,
  nextUtcSlotAfter,
  resolveLatestDueUtcSlot,
} from "../src/workflows/routine-schedule";
import {
  allocateLocalTcpNumber,
  createTempDatabase,
  ensureLocalRestate,
  registerRestateDeployment,
  waitUntil,
  type LocalRestateHandle,
  type TempDatabaseHandle,
} from "./fixtures/restate-harness";

let restateHandle: LocalRestateHandle | undefined;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  restateHandle = await ensureLocalRestate();
}, 30_000);

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

afterAll(async () => {
  await restateHandle?.stop();
}, 15_000);

function createConfigurableEngine(kind: EngineKind, getReadiness: () => EngineReadiness): Engine {
  return {
    kind,
    async diagnose(): Promise<EngineReadiness> {
      return getReadiness();
    },
    async *run(run: Run): AsyncIterable<EngineEvent> {
      yield {
        type: "chunk",
        chunkKey: `${run.id}:started`,
        chunk: { type: "RUN_STARTED", threadId: run.sessionId, runId: run.id },
      };
      yield {
        type: "completed",
        finalMessage: {
          parts: [{ type: "text", text: `Routine ${run.routineId ?? "none"} ok` }],
        },
      };
    },
  };
}

describe("UTC cron slot resolution and missed-slot coalescing", () => {
  it("coalesces multiple missed UTC slots to the latest due slot and computes the next strictly future slot", () => {
    const latest = resolveLatestDueUtcSlot(
      "*/5 * * * *",
      Date.parse("2026-06-01T10:17:30.000Z"),
      Date.parse("2026-06-01T10:00:00.000Z"),
    );
    expect(latest).toBe("2026-06-01T10:15:00.000Z");

    const exactBoundary = resolveLatestDueUtcSlot(
      "*/5 * * * *",
      Date.parse("2026-06-01T10:15:00.000Z"),
      Date.parse("2026-06-01T10:10:00.000Z"),
    );
    expect(exactBoundary).toBe("2026-06-01T10:15:00.000Z");

    const noneDue = resolveLatestDueUtcSlot(
      "*/5 * * * *",
      Date.parse("2026-06-01T10:14:59.000Z"),
      Date.parse("2026-06-01T10:10:00.000Z"),
    );
    expect(noneDue).toBeUndefined();

    expect(nextUtcSlotAfter("*/5 * * * *", Date.parse("2026-06-01T10:15:00.000Z"))).toBe(
      "2026-06-01T10:20:00.000Z",
    );
  });
});

describe("RoutineSchedule Restate Virtual Object", () => {
  it("updates revisions durably, skips stale revisions, coalesces missed UTC slots, deduplicates slots, and records active-session skips", async () => {
    const restate = restateHandle!;
    const tempDb: TempDatabaseHandle = createTempDatabase("der-routine-schedule-");
    cleanups.push(() => tempDb.cleanup());
    const routineId = `rt-daily-${crypto.randomUUID().slice(0, 8)}`;

    let currentTime = new Date("2026-06-01T10:00:00.000Z");
    const restateListen = await allocateLocalTcpNumber();
    const codexReadiness: EngineReadiness = {
      engine: "codex",
      interactive: "ready",
      unattended: "ready",
      isolationVerified: true,
      reasons: [],
    };
    const engines = new Map<EngineKind, Engine>([
      ["codex", createConfigurableEngine("codex", () => codexReadiness)],
    ]);

    let routinesStore!: ReturnType<typeof openSqliteRoutines>;
    const server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen,
        restateIngressUrl: restate.ingressUrl,
        restateAdminUrl: restate.adminUrl,
        restateMode: "restate",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        approvalTimeoutMs: 30_000,
        ssePollIntervalMs: 20,
        sseKeepAliveMs: 5_000,
        seedFixture: false,
      },
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
      now: () => currentTime,
      engines,
      extraRestateServices: [
        createRoutineScheduleObject({
          getStore: () => server.store,
          getRoutines: () => routinesStore,
          engines,
          now: () => currentTime,
          scheduleDelayCapMs: 3_600_000,
        }),
      ],
    });
    routinesStore = openSqliteRoutines({ database: server.store.database });
    cleanups.push(() => server.close());

    await registerRestateDeployment(restate.adminUrl, server.restateUrl!, { force: true });

    const bot = server.store.createBot({
      id: "bot-sched",
      name: "Scheduler Bot",
      persona: "Scheduled checks",
      defaultEngine: "codex",
      allowedEngines: ["codex", "fixture"],
    });
    const session = server.store.createSession({
      id: "sess-sched",
      botId: bot.id,
      title: "Scheduled Session",
      engine: "codex",
    });

    const scheduleClient = createRoutineScheduleClient(restate.ingressUrl);

    const created = await scheduleClient.configure(routineId, {
      kind: "create",
      botId: bot.id,
      sessionId: session.id,
      name: "Five-minute check",
      cron: "*/5 * * * *",
      enabled: true,
      engine: "codex",
      prompt: "Check service health",
    });
    expect(created.routine.revision).toBe(1);
    expect(created.nextSlot).toBe("2026-06-01T10:05:00.000Z");

    const updated = await scheduleClient.configure(routineId, {
      kind: "update",
      cron: "*/5 * * * *",
      prompt: "Check updated service health",
      enabled: true,
    });
    expect(updated.routine.revision).toBe(2);

    currentTime = new Date("2026-06-01T10:17:30.000Z");

    const staleTick = await scheduleClient.tick(routineId, {
      revision: 1,
      scheduledSlot: "2026-06-01T10:05:00.000Z",
    });
    expect(staleTick.disposition).toBe("skipped_obsolete_revision");
    expect(staleTick.runId).toBeNull();
    expect(routinesStore.listSlots(routineId)).toHaveLength(0);

    const coalescedTick = await scheduleClient.tick(routineId, {
      revision: 2,
      scheduledSlot: "2026-06-01T10:05:00.000Z",
    });
    expect(coalescedTick.disposition).toBe("admitted");
    expect(coalescedTick.slot).toBe("2026-06-01T10:15:00.000Z");
    expect(coalescedTick.runId).toBeTruthy();

    await waitUntil(
      () => {
        const run = server.store.getRun(coalescedTick.runId!);
        return run?.status === "completed" ? run : false;
      },
      { timeoutMs: 15_000, label: "coalesced routine run completion" },
    );

    const dedupedTick = await scheduleClient.tick(routineId, {
      revision: 2,
      scheduledSlot: "2026-06-01T10:15:00.000Z",
    });
    expect(dedupedTick.disposition).toBe("already_recorded");
    expect(dedupedTick.slot).toBe("2026-06-01T10:15:00.000Z");
    expect(dedupedTick.runId).toBe(coalescedTick.runId);

    const activeRun = await server.store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "web",
      idempotencyKey: "interactive-blocker-1",
      engine: "fixture",
      input: { parts: [{ type: "text", text: "lamp-blocking" }] },
    });
    expect(activeRun.run.status).toBe("queued");

    currentTime = new Date("2026-06-01T10:20:05.000Z");
    const activeSkipTick = await scheduleClient.tick(routineId, {
      revision: 2,
      scheduledSlot: "2026-06-01T10:20:00.000Z",
    });
    expect(activeSkipTick.disposition).toBe("skipped_active_run");
    expect(activeSkipTick.slot).toBe("2026-06-01T10:20:00.000Z");
    expect(activeSkipTick.runId).toBeNull();

    const slots = routinesStore.listSlots(routineId);
    expect(slots.map((s) => ({ slot: s.slot, disposition: s.disposition }))).toEqual([
      { slot: "2026-06-01T10:15:00.000Z", disposition: "admitted" },
      { slot: "2026-06-01T10:20:00.000Z", disposition: "skipped_active_run" },
    ]);

    await scheduleClient.configure(routineId, { kind: "update", enabled: false });
  }, 45_000);

  it("blocks routines on engines without verified unattended eligibility at configure and at tick admission", async () => {
    const restate = restateHandle!;
    const tempDb: TempDatabaseHandle = createTempDatabase("der-routine-eligibility-");
    cleanups.push(() => tempDb.cleanup());
    const unverifiedId = `rt-unverified-${crypto.randomUUID().slice(0, 8)}`;
    const revokedId = `rt-revoked-${crypto.randomUUID().slice(0, 8)}`;

    let currentTime = new Date("2026-06-01T11:00:00.000Z");
    const restateListen = await allocateLocalTcpNumber();
    const claudeUnattended: EngineReadiness["unattended"] = "unverified";
    let antigravityUnattended: EngineReadiness["unattended"] = "ready";

    const engines = new Map<EngineKind, Engine>([
      [
        "claude-code",
        createConfigurableEngine("claude-code", () => ({
          engine: "claude-code",
          interactive: "ready",
          unattended: claudeUnattended,
          isolationVerified: true,
          reasons: ["Unattended usage unverified."],
        })),
      ],
      [
        "antigravity",
        createConfigurableEngine("antigravity", () => ({
          engine: "antigravity",
          interactive: "ready",
          unattended: antigravityUnattended,
          isolationVerified: true,
          reasons: antigravityUnattended === "ready" ? [] : ["Unattended policy revoked."],
        })),
      ],
    ]);

    let routinesStore!: ReturnType<typeof openSqliteRoutines>;
    const server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen,
        restateIngressUrl: restate.ingressUrl,
        restateAdminUrl: restate.adminUrl,
        restateMode: "restate",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        approvalTimeoutMs: 30_000,
        ssePollIntervalMs: 20,
        sseKeepAliveMs: 5_000,
        seedFixture: false,
      },
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
      now: () => currentTime,
      engines,
      extraRestateServices: [
        createRoutineScheduleObject({
          getStore: () => server.store,
          getRoutines: () => routinesStore,
          engines,
          now: () => currentTime,
          scheduleDelayCapMs: 3_600_000,
        }),
      ],
    });
    routinesStore = openSqliteRoutines({ database: server.store.database });
    cleanups.push(() => server.close());

    await registerRestateDeployment(restate.adminUrl, server.restateUrl!, { force: true });

    const bot = server.store.createBot({
      id: "bot-elig",
      name: "Eligibility Bot",
      persona: "Strict",
      defaultEngine: "antigravity",
      allowedEngines: ["claude-code", "antigravity"],
    });
    const session = server.store.createSession({
      id: "sess-elig",
      botId: bot.id,
      title: "Eligibility Session",
    });

    const scheduleClient = createRoutineScheduleClient(restate.ingressUrl);

    let configErr: unknown;
    try {
      await scheduleClient.configure(unverifiedId, {
        kind: "create",
        botId: bot.id,
        sessionId: session.id,
        name: "Blocked routine",
        cron: "*/5 * * * *",
        enabled: true,
        engine: "claude-code",
        prompt: "Should not configure",
      });
    } catch (error) {
      configErr = error;
    }
    expect(configErr).toBeInstanceOf(DomainError);
    expect((configErr as DomainError).code).toBe("routine.engine_ineligible");

    const configured = await scheduleClient.configure(revokedId, {
      kind: "create",
      botId: bot.id,
      sessionId: session.id,
      name: "Revoked later",
      cron: "*/5 * * * *",
      enabled: true,
      engine: "antigravity",
      prompt: "Check state",
    });
    expect(configured.routine.revision).toBe(1);

    antigravityUnattended = "blocked";
    currentTime = new Date("2026-06-01T11:05:10.000Z");

    const blockedTick = await scheduleClient.tick(revokedId, {
      revision: 1,
      scheduledSlot: "2026-06-01T11:05:00.000Z",
    });
    expect(blockedTick.disposition).toBe("blocked_ineligible");
    expect(blockedTick.slot).toBe("2026-06-01T11:05:00.000Z");
    expect(blockedTick.runId).toBeNull();

    const recorded = routinesStore.getSlot(revokedId, "2026-06-01T11:05:00.000Z");
    expect(recorded?.disposition).toBe("blocked_ineligible");
    expect(recorded?.runId).toBeNull();

    await scheduleClient.configure(revokedId, { kind: "update", enabled: false });
  }, 45_000);

  it("fires a real Restate delayed self-invocation and completes an unattended scheduled Run", async () => {
    const restate = restateHandle!;
    const tempDb: TempDatabaseHandle = createTempDatabase("der-routine-delayed-");
    cleanups.push(() => tempDb.cleanup());
    const routineId = `rt-delayed-${crypto.randomUUID().slice(0, 8)}`;

    const restateListen = await allocateLocalTcpNumber();
    const engines = new Map<EngineKind, Engine>([
      [
        "codex",
        createConfigurableEngine("codex", () => ({
          engine: "codex",
          interactive: "ready",
          unattended: "ready",
          isolationVerified: true,
          reasons: [],
        })),
      ],
    ]);

    let routinesStore!: ReturnType<typeof openSqliteRoutines>;
    const server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen,
        restateIngressUrl: restate.ingressUrl,
        restateAdminUrl: restate.adminUrl,
        restateMode: "restate",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        approvalTimeoutMs: 30_000,
        ssePollIntervalMs: 20,
        sseKeepAliveMs: 5_000,
        seedFixture: false,
      },
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
      engines,
      extraRestateServices: [
        createRoutineScheduleObject({
          getStore: () => server.store,
          getRoutines: () => routinesStore,
          engines,
        }),
      ],
    });
    routinesStore = openSqliteRoutines({ database: server.store.database });
    cleanups.push(() => server.close());

    await registerRestateDeployment(restate.adminUrl, server.restateUrl!, { force: true });

    const bot = server.store.createBot({
      id: "bot-delay",
      name: "Delayed Bot",
      persona: "Auto",
      defaultEngine: "codex",
      allowedEngines: ["codex"],
    });
    const session = server.store.createSession({
      id: "sess-delay",
      botId: bot.id,
      title: "Delayed Session",
    });

    const scheduleClient = createRoutineScheduleClient(restate.ingressUrl);
    await scheduleClient.configure(routineId, {
      kind: "create",
      botId: bot.id,
      sessionId: session.id,
      name: "Every-second delayed check",
      cron: "* * * * * *",
      enabled: true,
      engine: "codex",
      prompt: "Delayed health check",
    });

    const admittedSlot = await waitUntil(
      () => {
        const slots = routinesStore.listSlots(routineId);
        return slots.find((entry) => entry.disposition === "admitted" && entry.runId !== null);
      },
      { timeoutMs: 15_000, label: "Restate delayed tick admission" },
    );

    await scheduleClient.configure(routineId, { kind: "update", enabled: false });

    const completedRun = await waitUntil(
      () => {
        const run = server.store.getRun(admittedSlot.runId!);
        return run?.status === "completed" ? run : false;
      },
      { timeoutMs: 15_000, label: "delayed scheduled run completion" },
    );
    expect(completedRun.origin).toBe("routine");
    expect(completedRun.routineId).toBe(routineId);
  }, 45_000);
});
