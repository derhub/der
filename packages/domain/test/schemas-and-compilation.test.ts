import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";
import { compiledParsers } from "@der/domain/compiled";
import {
  defineCapability,
  defineIntegration,
  IntegrationRegistry,
  type ApprovalEffectStore,
  type BotStore,
  type Engine,
  type Memory,
  type OutboxSink,
  type OutboxStore,
  type RoutineStore,
  type RunCoordinator,
  type RunStore,
  type Sandbox,
  type SessionStore,
  type Store,
  type Workflow,
  type WorkflowDriver,
} from "@der/domain/interfaces";
import type { Memory as MemoryCapability } from "@der/domain/memory";
import { cloudEvent, DomainError, problemDetails, utcTimestamp } from "@der/domain/protocol";
import {
  approval,
  approvalDecision,
  approvalResolutionInput,
  bot,
  channelBinding,
  channelCursor,
  channelReceipt,
  channelUpdate,
  effectOperationKind,
  effectRecord,
  memoryRecord,
  message,
  outboxDestination,
  outboxEvent,
  routine,
  routineSlot,
  run,
  runAdmission,
  runEvent,
  runRequest,
  session,
  skill,
} from "@der/domain/schemas";
import { memoryRecord as standaloneMemoryRecord } from "@der/domain/memory/schema";

const fixtures = {
  utc: "2026-11-22T15:00:00Z",
  bot: {
    id: "bot-1",
    name: "Ops Assistant",
    persona: "Concise self-hosted coworker.",
    defaultEngine: "codex" as const,
    allowedEngines: ["codex" as const, "claude-code" as const],
    capabilityPolicy: { "mcp.github": "ask" as const },
    eventChainLimit: 3,
    createdAt: "2026-11-22T15:00:00Z",
    updatedAt: "2026-11-22T15:00:00Z",
  },
  session: {
    id: "sess-1",
    botId: "bot-1",
    title: "Daily check",
    createdAt: "2026-11-22T15:00:00Z",
    updatedAt: "2026-11-22T15:00:00Z",
  },
  message: {
    id: "msg-1",
    botId: "bot-1",
    sessionId: "sess-1",
    ordinal: 1,
    role: "user" as const,
    parts: [{ type: "text" as const, text: "Check lamp state" }],
    runId: "run-1",
    createdAt: "2026-11-22T15:00:00Z",
  },
  run: {
    id: "run-1",
    botId: "bot-1",
    sessionId: "sess-1",
    origin: "http" as const,
    engine: "codex" as const,
    status: "running" as const,
    routineId: null,
    checkpoint: null,
    usage: null,
    contextMode: null,
    createdAt: "2026-11-22T15:00:00Z",
    updatedAt: "2026-11-22T15:00:00Z",
    finishedAt: null,
  },
  runRequest: {
    botId: "bot-1",
    sessionId: "sess-1",
    origin: "web" as const,
    idempotencyKey: "key-1",
    input: {
      parts: [{ type: "text" as const, text: "Check lamp state" }],
    },
  },
  runEvent: {
    runId: "run-1",
    sequence: 1,
    chunkKey: "run-1:1",
    chunk: { type: "content", delta: "Checking...", nested: [1, true, null] },
    isTerminal: false,
    createdAt: "2026-11-22T15:00:01Z",
  },
  effectIdentity: {
    runId: "run-1",
    operationKind: "mcp" as const,
    operationId: "notes.append_note",
    canonicalArguments: { title: "Shift", body: "All green" },
    attemptId: "attempt-1",
  },
  routine: {
    id: "rt-1",
    botId: "bot-1",
    sessionId: "sess-1",
    name: "Morning briefing",
    cron: "0 8 * * *",
    enabled: true,
    revision: 1,
    engine: "codex" as const,
    prompt: "Summarize overnight alerts.",
    script: null,
    createdAt: "2026-11-22T15:00:00Z",
    updatedAt: "2026-11-22T15:00:00Z",
  },
  routineSlot: {
    routineId: "rt-1",
    slot: "2026-11-23T08:00:00Z",
    revision: 1,
    disposition: "admitted" as const,
    runId: "run-2",
    recordedAt: "2026-11-23T08:00:01Z",
  },
  memoryRecord: {
    id: "mem-1",
    botId: "bot-1",
    version: 3,
    markdown: "# Preferences\n\nKeep updates short.\n",
    updatedAt: "2026-11-22T15:00:00Z",
  },
  skill: {
    id: "skill-1",
    name: "home-lights",
    description: "Control home lighting scenes safely.",
    relativePath: "home-lights/SKILL.md",
  },
  channelBinding: {
    id: "bind-1",
    integration: "telegram" as const,
    externalChatId: "chat-42",
    externalActorId: "user-7",
    botId: "bot-1",
    sessionId: "sess-1",
    enabled: true,
    createdAt: "2026-11-22T15:00:00Z",
    updatedAt: "2026-11-22T15:00:00Z",
  },
  channelUpdate: {
    integration: "telegram" as const,
    externalUpdateId: "upd-100",
    externalChatId: "chat-42",
    externalActorId: "user-7",
    receivedAt: "2026-11-22T15:01:00Z",
    payload: {
      kind: "message" as const,
      text: "Status?",
    },
  },
  problem: {
    type: "https://der.invalid/problems/run-active",
    title: "Active run exists",
    status: 409,
    detail: "Session sess-1 already has an active run.",
    instance: "/api/sessions/sess-1/runs",
    code: "run.active_conflict",
  },
};

const approvalFixture = {
  id: "appr-1",
  botId: "bot-1",
  sessionId: "sess-1",
  runId: "run-1",
  effect: fixtures.effectIdentity,
  prompt: "Turn on living room light?",
  awakeable: "awk_123",
  deadline: "2026-11-22T15:05:00Z",
  decision: {
    status: "pending" as const,
    awakeable: "awk_123",
    deadline: "2026-11-22T15:05:00Z",
  },
  createdAt: "2026-11-22T15:00:02Z",
  updatedAt: "2026-11-22T15:00:02Z",
};

const cloudEventFixture = {
  specversion: "1.0" as const,
  id: "evt-1",
  source: "/bots/bot-1",
  type: "der.approval.requested" as const,
  time: "2026-11-22T15:00:02Z",
  subject: "sessions/sess-1/runs/run-1/approvals/appr-1",
  datacontenttype: "application/json" as const,
  data: {
    botId: "bot-1",
    sessionId: "sess-1",
    runId: "run-1",
    approvalId: "appr-1",
    operationKind: "mcp" as const,
    operationId: "notes.append_note",
    prompt: "Append daily shift note?",
    deadline: "2026-11-22T15:05:00Z",
  },
};

const outboxEventFixture = {
  id: "outbox-1",
  bindingId: "bind-1",
  eventId: "evt-1",
  envelope: cloudEventFixture,
  state: "pending" as const,
  attempts: 0,
  nextRetryAt: null,
  deliveredAt: null,
  lastError: null,
  createdAt: "2026-11-22T15:00:02Z",
  updatedAt: "2026-11-22T15:00:02Z",
};

describe("validate core domain entities", () => {
  it("parses all ten domain entities and supporting records", () => {
    expect(bot.parse(fixtures.bot)).toEqual(fixtures.bot);
    expect(session.parse(fixtures.session)).toEqual(fixtures.session);
    expect(message.parse(fixtures.message)).toEqual(fixtures.message);
    expect(run.parse(fixtures.run)).toEqual(fixtures.run);
    expect(runRequest.parse(fixtures.runRequest)).toEqual(fixtures.runRequest);
    expect(
      runAdmission.parse({
        run: fixtures.run,
        initialMessage: fixtures.message,
        isDuplicate: false,
        payloadFingerprint: "sha256:abc",
      }).isDuplicate,
    ).toBe(false);
    expect(runEvent.parse(fixtures.runEvent)).toEqual(fixtures.runEvent);
    expect(approval.parse(approvalFixture)).toEqual(approvalFixture);
    expect(
      effectRecord.parse({
        id: "eff-1",
        identity: fixtures.effectIdentity,
        status: "unknown",
        outcome: null,
        startedAt: fixtures.utc,
        updatedAt: fixtures.utc,
      }).status,
    ).toBe("unknown");
    expect(routine.parse(fixtures.routine)).toEqual(fixtures.routine);
    expect(routineSlot.parse(fixtures.routineSlot)).toEqual(fixtures.routineSlot);
    expect(memoryRecord.parse(fixtures.memoryRecord)).toEqual(fixtures.memoryRecord);
    expect(skill.parse(fixtures.skill)).toEqual(fixtures.skill);
    expect(channelBinding.parse(fixtures.channelBinding)).toEqual(fixtures.channelBinding);
    expect(
      channelReceipt.parse({
        integration: "telegram",
        consumer: "bot-main",
        externalUpdateId: "upd-100",
        disposition: "admitted",
        referenceId: "run-1",
        recordedAt: fixtures.utc,
      }).disposition,
    ).toBe("admitted");
    expect(
      channelCursor.parse({
        integration: "telegram",
        consumer: "bot-main",
        position: "100",
        updatedAt: fixtures.utc,
      }).position,
    ).toBe("100");
    expect(channelUpdate.parse(fixtures.channelUpdate)).toEqual(fixtures.channelUpdate);
    expect(outboxEvent.parse(outboxEventFixture)).toEqual(outboxEventFixture);
  });

  it("preserves native chunk data as JSON and rejects non-JSON values", () => {
    expect(runEvent.safeParse({ ...fixtures.runEvent, chunk: undefined }).success).toBe(false);
    expect(runEvent.safeParse({ ...fixtures.runEvent, chunk: () => "no" }).success).toBe(false);
    expect(runEvent.safeParse({ ...fixtures.runEvent, chunk: Number.NaN }).success).toBe(false);
  });

  it.each([
    {
      label: "pending",
      value: { status: "pending", awakeable: "awk_1", deadline: "2026-11-22T15:05:00Z" },
      valid: true,
    },
    {
      label: "approved",
      value: { status: "approved", actor: "operator", decidedAt: "2026-11-22T15:01:00Z" },
      valid: true,
    },
    {
      label: "denied",
      value: { status: "denied", actor: "operator", decidedAt: "2026-11-22T15:01:00Z" },
      valid: true,
    },
    {
      label: "expired",
      value: { status: "expired", decidedAt: "2026-11-22T15:05:00Z" },
      valid: true,
    },
    {
      label: "approved without actor",
      value: { status: "approved", decidedAt: "2026-11-22T15:01:00Z" },
      valid: false,
    },
    {
      label: "pending without awakeable",
      value: { status: "pending", deadline: "2026-11-22T15:05:00Z" },
      valid: false,
    },
    {
      label: "expired with non-UTC timestamp",
      value: { status: "expired", decidedAt: "2026-11-22T15:05:00+00:00" },
      valid: false,
    },
  ])("validates approval decision $label", ({ value, valid }) => {
    expect(approvalDecision.safeParse(value).success).toBe(valid);
  });
});

describe("keep Memory schema and capability entry points distinct", () => {
  it("exports Memory schema separately from the Memory capability interface", () => {
    expect(standaloneMemoryRecord).toBe(memoryRecord);

    const memoryCapability: MemoryCapability = {
      async read() {
        return fixtures.memoryRecord;
      },
      async write(input) {
        return {
          id: "mem-1",
          botId: input.botId,
          version: (input.expectedVersion ?? 0) + 1,
          markdown: input.markdown,
          updatedAt: fixtures.utc,
        };
      },
    };

    const botStore: BotStore = {
      createBot: () => fixtures.bot,
      getBot: () => fixtures.bot,
      listBots: () => [fixtures.bot],
      updateBot: () => fixtures.bot,
    };
    const sessionStore: SessionStore = {
      createSession: () => fixtures.session,
      getSession: () => fixtures.session,
      listSessions: () => [fixtures.session],
      listMessages: () => [fixtures.message],
    };
    const runStore: RunStore = {
      async admit() {
        return {
          run: fixtures.run,
          initialMessage: fixtures.message,
          isDuplicate: false,
          payloadFingerprint: "sha256:abc",
        };
      },
      getRun: () => fixtures.run,
      listSessionRuns: () => [fixtures.run],
      markRunRunning: async () => fixtures.run,
      appendRunEvents: async () => [fixtures.runEvent],
      getRunStreamState: () => ({
        highWaterMark: 1,
        terminalSequence: undefined,
        status: "running",
      }),
      readRunEventsAfter: () => [fixtures.runEvent],
      async *replay() {
        yield fixtures.runEvent;
      },
      finishRun: async () => ({
        run: fixtures.run,
        terminalEvent: fixtures.runEvent,
        outboxEvents: [],
      }),
    };
    const approvalEffectStore: ApprovalEffectStore = {
      requestApproval: async () => ({
        approval: approvalFixture,
        outboxEvents: [],
        isDuplicate: false,
      }),
      getApproval: () => approvalFixture,
      getLatestApprovalForRun: () => approvalFixture,
      decide: async () => approvalFixture,
      beginEffect: async () => ({
        kind: "started",
        effect: {
          id: "eff-1",
          identity: fixtures.effectIdentity,
          status: "started",
          outcome: null,
          startedAt: fixtures.utc,
          updatedAt: fixtures.utc,
        },
      }),
      completeEffect: async () => ({
        id: "eff-1",
        identity: fixtures.effectIdentity,
        status: "completed",
        outcome: { ok: true },
        startedAt: fixtures.utc,
        updatedAt: fixtures.utc,
      }),
      markEffectUnknown: async () => ({
        id: "eff-1",
        identity: fixtures.effectIdentity,
        status: "unknown",
        outcome: null,
        startedAt: fixtures.utc,
        updatedAt: fixtures.utc,
      }),
      getEffect: () => undefined,
      findWriteInDoubt: () => undefined,
    };
    const outboxStore: OutboxStore = {
      listOutboxEvents: () => [outboxEventFixture],
      listDueOutboxEvents: () => [outboxEventFixture],
      recordOutboxDelivery: async () => outboxEventFixture,
    };
    const routineStore: RoutineStore = {
      createRoutine: () => fixtures.routine,
      getRoutine: () => fixtures.routine,
    };
    const storeCapability: Store = {
      ...botStore,
      ...sessionStore,
      ...runStore,
      ...approvalEffectStore,
      ...outboxStore,
      ...routineStore,
      getEngineSession: () => null,
      takeEngineSession: () => undefined,
    };

    const outboxSink: OutboxSink = {
      kind: "webhook",
      async deliver() {
        return { status: "delivered", deliveredAt: fixtures.utc };
      },
    };
    const workflowDriver: WorkflowDriver = {
      runStep: async (_name, fn) => fn(),
      awaitApproval: async () => approvalFixture,
      resolveApproval: async () => {},
    };
    const runCoordinator: RunCoordinator = {
      admit: (request) => storeCapability.admit(request),
      decide: (decision) => storeCapability.decide(decision),
      executeRun: async () => {},
    };

    const memoryFromIndex: Memory = memoryCapability;
    const engineCapability: Engine = {
      kind: "fixture",
      async *run() {
        yield { type: "completed" };
      },
    };
    const sandboxCapability: Sandbox = {
      async execute() {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
    };
    const workflowCapability: Workflow = {
      admit: (request) => storeCapability.admit(request),
      decide: (decision) => storeCapability.decide(decision),
    };

    expect(typeof memoryFromIndex.read).toBe("function");
    expect(typeof engineCapability.run).toBe("function");
    expect(typeof sandboxCapability.execute).toBe("function");
    expect(typeof outboxSink.deliver).toBe("function");
    expect(typeof workflowCapability.admit).toBe("function");
    expect(typeof workflowDriver.runStep).toBe("function");
    expect(typeof runCoordinator.executeRun).toBe("function");
    expect(effectOperationKind.safeParse("home-assistant").success).toBe(false);
    expect(
      outboxDestination.parse({
        id: "dest-1",
        kind: "webhook",
        target: "https://example.invalid/hook",
        botId: "bot-1",
        sessionId: "sess-1",
        enabled: true,
        createdAt: fixtures.utc,
        updatedAt: fixtures.utc,
      }).kind,
    ).toBe("webhook");
  });
});

describe("register integrations through IntegrationRegistry", () => {
  it("rejects a duplicate capability id and a duplicate outbox sink kind", async () => {
    const registry = new IntegrationRegistry();
    const search = defineCapability({
      id: "notes.search",
      description: "Search notes.",
      input: z.object({ query: z.string().min(1) }),
      output: z.object({ matches: z.array(z.string()) }),
      effect: "read",
      approval: "none",
      async execute(input) {
        return { matches: [input.query] };
      },
    });

    await registry.register(
      defineIntegration({
        id: "notes",
        setup() {
          return {
            capabilities: [search],
            outboxSinks: [
              {
                kind: "webhook",
                async deliver() {
                  return { status: "delivered", deliveredAt: fixtures.utc };
                },
              },
            ],
          };
        },
      }),
    );

    expect(registry.getOutboxSink("webhook")?.kind).toBe("webhook");
    expect(registry.listOutboxSinks().map((s) => s.kind)).toEqual(["webhook"]);

    const duplicateCapabilityIntegration = defineIntegration({
      id: "notes-duplicate",
      setup() {
        return { capabilities: [search] };
      },
    });
    await expect(registry.register(duplicateCapabilityIntegration)).rejects.toThrow(DomainError);
    await expect(registry.register(duplicateCapabilityIntegration)).rejects.toThrow(
      /Capability "notes.search" is already registered/,
    );

    const duplicateSinkIntegration = defineIntegration({
      id: "webhook-duplicate",
      setup() {
        return {
          outboxSinks: [
            {
              kind: "webhook",
              async deliver() {
                return { status: "delivered", deliveredAt: fixtures.utc };
              },
            },
          ],
        };
      },
    });

    await expect(registry.register(duplicateSinkIntegration)).rejects.toThrow(
      /Outbox sink "webhook" is already registered/,
    );
  });

  it("stops every registered integration even when an earlier stop() throws", async () => {
    const registry = new IntegrationRegistry();
    const stopped: string[] = [];

    await registry.register(
      defineIntegration({
        id: "first",
        setup() {
          return {
            async stop() {
              stopped.push("first");
            },
          };
        },
      }),
    );
    await registry.register(
      defineIntegration({
        id: "second",
        setup() {
          return {
            async stop() {
              stopped.push("second");
              throw new Error("second stop failed");
            },
          };
        },
      }),
    );
    await registry.register(
      defineIntegration({
        id: "third",
        setup() {
          return {
            async stop() {
              stopped.push("third");
            },
          };
        },
      }),
    );

    await registry.start();
    await expect(registry.stop()).rejects.toThrow("second stop failed");
    expect(stopped).toEqual(["third", "second", "first"]);
  });

  it("reserves integration IDs synchronously during async register() and releases on failure", async () => {
    const registry = new IntegrationRegistry();
    let resolveSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });

    const first = registry.register(
      defineIntegration({
        id: "async-int",
        async setup() {
          await setupGate;
          return {};
        },
      }),
    );

    await expect(
      registry.register(
        defineIntegration({
          id: "async-int",
          setup() {
            return {};
          },
        }),
      ),
    ).rejects.toThrow(/Integration "async-int" is already registered/);

    resolveSetup();
    await first;

    await expect(
      registry.register(
        defineIntegration({
          id: "flaky-int",
          async setup() {
            throw new Error("setup boom");
          },
        }),
      ),
    ).rejects.toThrow("setup boom");

    await expect(
      registry.register(
        defineIntegration({
          id: "flaky-int",
          setup() {
            return {};
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    { name: "a prompt routine", patch: {}, valid: true },
    {
      name: "a script routine",
      patch: { engine: "script", prompt: null, script: "return 1" },
      valid: true,
    },
    { name: "both prompt and script", patch: { script: "return 1" }, valid: false },
    { name: "neither prompt nor script", patch: { prompt: null }, valid: false },
    {
      name: "a script with a chat engine",
      patch: { prompt: null, script: "return 1" },
      valid: false,
    },
    { name: "a prompt with engine script", patch: { engine: "script" }, valid: false },
  ])("routine target accepts exactly one of prompt or script: $name", ({ patch, valid }) => {
    const candidate = { ...fixtures.routine, ...patch };
    expect(routine.safeParse(candidate).success).toBe(valid);
    expect(compiledParsers.routine.safeParse(candidate).success).toBe(valid);
  });

  it.each([
    { origin: "routine", routineId: "rt-1", valid: true },
    { origin: "routine", routineId: undefined, valid: false },
    { origin: "http", routineId: "rt-1", valid: false },
    { origin: "web", routineId: undefined, valid: false },
  ])(
    "runRequest admits engine script only for a routine firing: $origin $routineId",
    ({ origin, routineId, valid }) => {
      const request = {
        ...fixtures.runRequest,
        origin,
        engine: "script",
        ...(routineId === undefined ? {} : { routineId }),
      };
      expect(runRequest.safeParse(request).success).toBe(valid);
    },
  );

  it("allows http, web, and routine on active runRequest while rejecting telegram and channelIntake", () => {
    expect(runRequest.safeParse({ ...fixtures.runRequest, origin: "http" }).success).toBe(true);
    expect(runRequest.safeParse({ ...fixtures.runRequest, origin: "web" }).success).toBe(true);
    expect(runRequest.safeParse({ ...fixtures.runRequest, origin: "routine" }).success).toBe(true);
    expect(runRequest.safeParse({ ...fixtures.runRequest, origin: "telegram" }).success).toBe(
      false,
    );
    expect(
      runRequest.safeParse({
        ...fixtures.runRequest,
        channelIntake: {
          integration: "fixture",
          consumer: "c-1",
          externalUpdateId: "u-1",
        },
      }).success,
    ).toBe(false);

    expect(run.safeParse({ ...fixtures.run, origin: "telegram" }).success).toBe(true);
    expect(run.safeParse({ ...fixtures.run, origin: "http" }).success).toBe(true);
  });
});

describe("match compiled server and CSP-compatible Web parsing", () => {
  const cases = [
    {
      name: "utcTimestamp",
      schema: utcTimestamp,
      compiled: compiledParsers.utcTimestamp,
      valid: fixtures.utc,
      invalid: "2026-11-22T15:00:00+00:00",
    },
    {
      name: "problemDetails",
      schema: problemDetails,
      compiled: compiledParsers.problemDetails,
      valid: fixtures.problem,
      invalid: { ...fixtures.problem, extra: true },
    },
    {
      name: "cloudEvent",
      schema: cloudEvent,
      compiled: compiledParsers.cloudEvent,
      valid: cloudEventFixture,
      invalid: { ...cloudEventFixture, type: "der.invalid.event" },
    },
    {
      name: "bot",
      schema: bot,
      compiled: compiledParsers.bot,
      valid: fixtures.bot,
      invalid: { ...fixtures.bot, allowedEngines: ["invalid-engine"] },
    },
    {
      name: "session",
      schema: session,
      compiled: compiledParsers.session,
      valid: fixtures.session,
      invalid: { ...fixtures.session, botId: "" },
    },
    {
      name: "message",
      schema: message,
      compiled: compiledParsers.message,
      valid: fixtures.message,
      invalid: { ...fixtures.message, ordinal: 0 },
    },
    {
      name: "run",
      schema: run,
      compiled: compiledParsers.run,
      valid: fixtures.run,
      invalid: { ...fixtures.run, status: "unknown-status" },
    },
    {
      name: "runRequest",
      schema: runRequest,
      compiled: compiledParsers.runRequest,
      valid: fixtures.runRequest,
      invalid: { ...fixtures.runRequest, input: { parts: [] } },
    },
    {
      name: "runEvent",
      schema: runEvent,
      compiled: compiledParsers.runEvent,
      valid: fixtures.runEvent,
      invalid: { ...fixtures.runEvent, sequence: 0 },
    },
    {
      name: "approval",
      schema: approval,
      compiled: compiledParsers.approval,
      valid: approvalFixture,
      invalid: { ...approvalFixture, decision: { status: "approved", decidedAt: fixtures.utc } },
    },
    {
      name: "approvalResolutionInput",
      schema: approvalResolutionInput,
      compiled: compiledParsers.approvalResolutionInput,
      valid: {
        approvalId: "appr-1",
        botId: "bot-1",
        sessionId: "sess-1",
        runId: "run-1",
        status: "approved",
        actor: "operator",
        decidedAt: fixtures.utc,
      },
      invalid: {
        approvalId: "appr-1",
        botId: "bot-1",
        sessionId: "sess-1",
        runId: "run-1",
        status: "pending",
        decidedAt: fixtures.utc,
      },
    },
    {
      name: "routine",
      schema: routine,
      compiled: compiledParsers.routine,
      valid: fixtures.routine,
      invalid: { ...fixtures.routine, revision: 0 },
    },
    {
      name: "memoryRecord",
      schema: memoryRecord,
      compiled: compiledParsers.memoryRecord,
      valid: fixtures.memoryRecord,
      invalid: { ...fixtures.memoryRecord, version: 0 },
    },
    {
      name: "skill",
      schema: skill,
      compiled: compiledParsers.skill,
      valid: fixtures.skill,
      invalid: { ...fixtures.skill, name: "" },
    },
    {
      name: "channelBinding",
      schema: channelBinding,
      compiled: compiledParsers.channelBinding,
      valid: fixtures.channelBinding,
      invalid: { ...fixtures.channelBinding, integration: "   " },
    },
    {
      name: "outboxEvent",
      schema: outboxEvent,
      compiled: compiledParsers.outboxEvent,
      valid: outboxEventFixture,
      invalid: { ...outboxEventFixture, attempts: -1 },
    },
  ] as const;

  it.each(cases)(
    "matches compiled server parsing and jitless CSP parsing for $name",
    ({ schema, compiled, valid, invalid }) => {
      const compiledValid = compiled.safeParse(valid);
      const compiledInvalid = compiled.safeParse(invalid);

      const previousJitless = z.config().jitless;
      z.config({ jitless: true });
      try {
        const cspValid = schema.safeParse(valid);
        const cspInvalid = schema.safeParse(invalid);

        expect(compiledValid.success).toBe(true);
        expect(cspValid.success).toBe(true);
        if (compiledValid.success && cspValid.success) {
          expect(compiledValid.data).toEqual(cspValid.data);
        }

        expect(compiledInvalid.success).toBe(false);
        expect(cspInvalid.success).toBe(false);
      } finally {
        z.config({ jitless: previousJitless ?? false });
      }
    },
  );
});

describe("enforce domain boundary hygiene", () => {
  it("keeps vendor SDK dependencies outside packages/domain", () => {
    const manifestPath = resolve(import.meta.dirname, "../package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["zod"]);
    expect(manifest.dependencies?.["zod"]).toBe("4.6.7");
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual([]);
  });

  it("excludes forbidden Port, Impl, and Manager suffixes from domain source", () => {
    const srcDir = resolve(import.meta.dirname, "../src");
    const forbiddenSuffix = /\b[A-Za-z0-9_]+(?:Port|Impl|Manager)\b/;

    function walk(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...walk(fullPath));
        } else if (entry.name.endsWith(".ts")) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const sourceFiles = walk(srcDir);
    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const file of sourceFiles) {
      expect(forbiddenSuffix.test(file)).toBe(false);
      const source = readFileSync(file, "utf8");
      expect(forbiddenSuffix.test(source)).toBe(false);
    }
  });
});
