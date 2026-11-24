import { describe, expect, it } from "bun:test";
import * as z from "zod";
import {
  CapabilityCatalog,
  defineCapability,
  PROBLEM_DETAILS_MEDIA_TYPE,
  SSE_CACHE_CONTROL,
  SSE_CONTENT_TYPE,
  type Approval,
  type ApprovalEffectStore,
  type Bot,
  type BotStore,
  type Engine,
  type EngineKind,
  type MemoryRecord,
  type Message,
  type Routine,
  type RoutineSlot,
  type Run,
  type RunAdmission,
  type RunEvent,
  type RunStore,
  type RunStreamState,
  type Session,
  type SessionStore,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { openSqliteStore } from "@der/storage";
import { parseServerConfig } from "#config";
import {
  createHttpApp,
  type HttpMemoryPort,
  type HttpRoutinePort,
  type HttpRouterDeps,
  type HttpSkillPort,
} from "#http/index";
import type { DurableWorkflow, RoutineScheduleClient } from "#workflows/index";
import { collectSseFrames } from "./fixtures/restate-harness";

const FIXED_NOW = new Date("2026-11-23T00:00:00.000Z");
const FIXED_TS = "2026-11-23T00:00:00.000Z";

function createMinimalDeps(overrides: Partial<HttpRouterDeps> = {}): HttpRouterDeps {
  const bot: Bot = {
    id: "bot-1",
    name: "Alpha",
    persona: "Concise",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
    capabilityPolicy: {},
    eventChainLimit: 3,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };

  const session: Session = {
    id: "sess-1",
    botId: bot.id,
    title: "Main",
    engine: "fixture",
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };

  const run: Run = {
    id: "run-1",
    botId: bot.id,
    sessionId: session.id,
    origin: "http",
    engine: "fixture",
    status: "completed",
    routineId: null,
    checkpoint: null,
    usage: null,
    contextMode: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    finishedAt: FIXED_TS,
  };

  const admission: RunAdmission = {
    run,
    initialMessage: {
      id: "msg-1",
      botId: bot.id,
      sessionId: session.id,
      ordinal: 1,
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      runId: run.id,
      createdAt: FIXED_TS,
    },
    isDuplicate: false,
    payloadFingerprint: "fp-1",
  };

  const events: RunEvent[] = [
    {
      runId: run.id,
      sequence: 1,
      chunkKey: "run-1:1",
      chunk: { type: "RUN_STARTED", runId: run.id },
      isTerminal: false,
      createdAt: FIXED_TS,
    },
    {
      runId: run.id,
      sequence: 2,
      chunkKey: "run-1:2",
      chunk: { type: "RUN_FINISHED", runId: run.id },
      isTerminal: true,
      createdAt: FIXED_TS,
    },
  ];

  const streamState: RunStreamState = {
    highWaterMark: 2,
    terminalSequence: 2,
    status: "completed",
  };

  const bots: BotStore = {
    listBots: () => [bot],
    getBot: (id) => (id === bot.id ? bot : undefined),
    createBot: (input) => ({
      ...bot,
      id: input.id ?? "bot-created",
      name: input.name,
      persona: input.persona ?? "",
    }),
    updateBot: (_id, patch) => ({
      ...bot,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
    }),
  };

  const sessions: SessionStore = {
    listSessions: (botId) => (botId === bot.id ? [session] : []),
    getSession: (id) => (id === session.id ? session : undefined),
    createSession: (input) => ({
      ...session,
      id: input.id ?? "sess-created",
      botId: input.botId,
      title: input.title,
    }),
    listMessages: (): Message[] => [
      {
        id: "msg-1",
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        ordinal: 1,
        role: "user",
        parts: [{ type: "text", text: "hello" }],
        createdAt: FIXED_TS,
      },
    ],
  };

  const runs: RunStore = {
    admit: async () => admission,
    getRun: (id) => (id === run.id ? run : undefined),
    listSessionRuns: (id) => (id === run.sessionId ? [run] : []),
    markRunRunning: async () => run,
    appendRunEvents: async () => [],
    getRunStreamState: (id) => (id === run.id ? streamState : undefined),
    readRunEventsAfter: (id, after) =>
      id === run.id ? events.filter((event) => event.sequence > after) : [],
    replay: async function* (id, after) {
      for (const event of events) {
        if (id === run.id && event.sequence > after) {
          yield event;
        }
      }
    },
    finishRun: async () => {
      throw new Error("not used");
    },
  };

  const approvals: ApprovalEffectStore = {
    requestApproval: async () => {
      throw new Error("not used");
    },
    getApproval: () => undefined,
    getLatestApprovalForRun: () => undefined,
    decide: async () => {
      throw new Error("not used");
    },
    beginEffect: async () => {
      throw new Error("not used");
    },
    completeEffect: async () => {
      throw new Error("not used");
    },
    markEffectUnknown: async () => {
      throw new Error("not used");
    },
    getEffect: () => undefined,
    findWriteInDoubt: () => undefined,
  };

  const memoryRecord: MemoryRecord = {
    id: "mem-1",
    botId: bot.id,
    version: 1,
    markdown: "# Notes",
    updatedAt: FIXED_TS,
  };

  const memory: HttpMemoryPort = {
    read: async (botId, version) =>
      botId === bot.id && (version === undefined || version === 1) ? memoryRecord : undefined,
    write: async (input) => ({
      ...memoryRecord,
      version: 2,
      markdown: input.markdown,
    }),
    listVersions: (botId) => (botId === bot.id ? [memoryRecord] : []),
  };

  const routine: Routine = {
    id: "rt-1",
    botId: bot.id,
    sessionId: session.id,
    name: "Daily",
    cron: "0 9 * * *",
    enabled: true,
    revision: 1,
    engine: "fixture",
    prompt: "Check status",
    script: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  };

  const routines: HttpRoutinePort = {
    getRoutine: (id) => (id === routine.id ? routine : undefined),
    listRoutines: (botId) => (botId === undefined || botId === bot.id ? [routine] : []),
    listSlots: (): RoutineSlot[] => [],
  };

  const skills: HttpSkillPort = {
    loadCatalog: async () => ({
      skills: [
        {
          id: "ops-brief",
          name: "ops-brief",
          description: "Summarize alerts.",
          relativePath: "ops-brief/SKILL.md",
        },
      ],
      rejected: [],
    }),
    listSkills: async () => [
      {
        id: "ops-brief",
        name: "ops-brief",
        description: "Summarize alerts.",
        relativePath: "ops-brief/SKILL.md",
      },
    ],
    readSkillBody: async () => "Read open alerts.",
  };

  const catalog = new CapabilityCatalog();

  const workflow: DurableWorkflow = {
    admit: async () => admission,
    decide: async (decision): Promise<Approval> => ({
      id: decision.approvalId,
      botId: decision.botId,
      sessionId: decision.sessionId,
      runId: decision.runId,
      effect: {
        runId: decision.runId,
        operationKind: "fixture",
        operationId: "fixture.apply",
        canonicalArguments: {},
        attemptId: "att-1",
      },
      prompt: "Approve?",
      awakeable: "awk-1",
      deadline: FIXED_TS,
      decision:
        decision.status === "expired"
          ? { status: "expired", decidedAt: decision.decidedAt }
          : { status: decision.status, actor: decision.actor, decidedAt: decision.decidedAt },
      createdAt: FIXED_TS,
      updatedAt: FIXED_TS,
    }),
  };

  const routineSchedule: RoutineScheduleClient = {
    configure: async (routineId) => ({
      routine: { ...routine, id: routineId },
      nextSlot: FIXED_TS,
    }),
    tick: async () => {
      throw new Error("tick is not used by the router");
    },
    inspect: async () => {
      throw new Error("inspect is not used by the router");
    },
  };

  const engines = new Map<EngineKind, Engine>([
    [
      "fixture",
      {
        kind: "fixture",
        run: async function* () {},
      },
    ],
  ]);

  return {
    bots,
    sessions,
    runs,
    approvals,
    memory,
    routines,
    skills,
    catalog,
    workflow,
    routineSchedule,
    engines,
    config: parseServerConfig({
      allowedOrigins: ["http://127.0.0.1:5173"],
      ssePollIntervalMs: 10,
      sseKeepAliveMs: 2_000,
    }),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

describe("serve Hono HTTP router on narrow domain ports", () => {
  it("validates query params, JSON bodies, headers, and unmatched routes with RFC 9457 Problem Details", async () => {
    const app = createHttpApp(createMinimalDeps());

    const healthRes = await app.fetch(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: "ok", timestamp: FIXED_TS });

    const invalidLimitRes = await app.fetch(
      new Request("http://localhost/api/sessions/sess-1/messages?limit=999"),
    );
    expect(invalidLimitRes.status).toBe(400);
    expect(invalidLimitRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await invalidLimitRes.json()).code).toBe(
      "http.invalid_query",
    );

    const emptyBodyRes = await app.fetch(
      new Request("http://localhost/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "   ",
      }),
    );
    expect(emptyBodyRes.status).toBe(400);
    expect(compiledParsers.problemDetails.parse(await emptyBodyRes.json()).code).toBe(
      "http.invalid_json",
    );

    const invalidRunRes = await app.fetch(
      new Request("http://localhost/api/sessions/sess-1/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "k-1",
        },
        body: JSON.stringify({ input: { parts: [] } }),
      }),
    );
    expect(invalidRunRes.status).toBe(400);
    expect(compiledParsers.problemDetails.parse(await invalidRunRes.json()).code).toBe(
      "run.invalid_request",
    );

    const invalidMemoryRes = await app.fetch(
      new Request("http://localhost/api/bots/bot-1/memory", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: 123 }),
      }),
    );
    expect(invalidMemoryRes.status).toBe(400);
    expect(compiledParsers.problemDetails.parse(await invalidMemoryRes.json()).code).toBe(
      "memory.invalid_input",
    );

    const missingSkillRes = await app.fetch(new Request("http://localhost/api/skills/nope"));
    expect(missingSkillRes.status).toBe(404);
    expect(compiledParsers.problemDetails.parse(await missingSkillRes.json()).code).toBe(
      "skill.not_found",
    );

    const notFoundRes = await app.fetch(new Request("http://localhost/api/does-not-exist"));
    expect(notFoundRes.status).toBe(404);
    expect(compiledParsers.problemDetails.parse(await notFoundRes.json()).code).toBe(
      "http.not_found",
    );
  });

  it("lists the catalog on GET /api/capabilities", async () => {
    const catalog = new CapabilityCatalog();
    catalog.add(
      defineCapability({
        id: "notes.append",
        description: "Append a note.",
        input: z.object({ text: z.string() }),
        output: z.object({ count: z.number() }),
        effect: "write",
        approval: "always",
        execute: async () => ({ count: 1 }),
      }) as never,
    );
    const app = createHttpApp(createMinimalDeps({ catalog }));

    const listed = await app.fetch(new Request("http://localhost/api/capabilities"));

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      capabilities: [
        {
          id: "notes.append",
          description: "Append a note.",
          effect: "write",
          requiresApproval: true,
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          outputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
            additionalProperties: false,
          },
        },
      ],
    });
  });

  it("accepts explicit origin http and omitted origin with matching idempotency fingerprint on POST /api/sessions/:sessionId/runs", async () => {
    const store = openSqliteStore({ filename: ":memory:" });
    try {
      const bot = store.createBot({
        id: "bot-http-origin",
        name: "HTTP Origin Bot",
        persona: "Concise",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });
      const session = store.createSession({
        id: "sess-http-origin",
        botId: bot.id,
        title: "HTTP Origin Session",
      });
      const baseDeps = createMinimalDeps();
      const app = createHttpApp({
        ...baseDeps,
        bots: store,
        sessions: store,
        runs: store,
        approvals: store,
        workflow: {
          ...baseDeps.workflow,
          admit: (request) => store.admit(request),
        },
      });

      const omittedRes = await app.fetch(
        new Request(`http://localhost/api/sessions/${session.id}/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "idem-http-origin-1",
          },
          body: JSON.stringify({
            input: { parts: [{ type: "text", text: "Hello over HTTP" }] },
          }),
        }),
      );
      expect(omittedRes.status).toBe(202);
      const omittedBody = (await omittedRes.json()) as {
        run: Run;
        isDuplicate: boolean;
        payloadFingerprint: string;
      };
      expect(omittedBody.isDuplicate).toBe(false);
      expect(omittedBody.run.origin).toBe("http");

      const explicitRes = await app.fetch(
        new Request(`http://localhost/api/sessions/${session.id}/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "idem-http-origin-1",
          },
          body: JSON.stringify({
            origin: "http",
            input: { parts: [{ type: "text", text: "Hello over HTTP" }] },
          }),
        }),
      );
      expect(explicitRes.status).toBe(202);
      const explicitBody = (await explicitRes.json()) as {
        run: Run;
        isDuplicate: boolean;
        payloadFingerprint: string;
      };
      expect(explicitBody.isDuplicate).toBe(true);
      expect(explicitBody.run.id).toBe(omittedBody.run.id);
      expect(explicitBody.run.origin).toBe("http");
      expect(explicitBody.payloadFingerprint).toBe(omittedBody.payloadFingerprint);
    } finally {
      store.close();
    }
  });

  it("rejects telegram or invalid run origins and channelIntake on POST /api/sessions/:sessionId/runs with RFC 9457 Problem Details", async () => {
    const app = createHttpApp(createMinimalDeps());
    const invalidPayloads = [
      {
        origin: "telegram",
        input: { parts: [{ type: "text", text: "removed telegram origin" }] },
      },
      {
        origin: "legacy-channel",
        input: { parts: [{ type: "text", text: "unknown origin" }] },
      },
      {
        origin: "web",
        input: { parts: [{ type: "text", text: "disallowed channel intake" }] },
        channelIntake: {
          integration: "fixture",
          consumer: "c-1",
          externalUpdateId: "u-1",
        },
      },
    ];

    for (const [index, body] of invalidPayloads.entries()) {
      const res = await app.fetch(
        new Request("http://localhost/api/sessions/sess-1/runs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `reject-origin-${index}`,
          },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
      expect(compiledParsers.problemDetails.parse(await res.json()).code).toBe(
        "run.invalid_request",
      );
    }
  });

  it("returns 200 on GET /api/runs/:runId when the latest approval has a legacy operationKind", async () => {
    const legacyApproval: Approval = {
      id: "appr-legacy",
      botId: "bot-1",
      sessionId: "sess-1",
      runId: "run-1",
      effect: {
        runId: "run-1",
        operationKind: "legacy",
        operationId: "legacy.action",
        canonicalArguments: { target: "lamp" },
        attemptId: "att-legacy",
      },
      prompt: "Legacy approval?",
      awakeable: "awk-legacy",
      deadline: FIXED_TS,
      decision: {
        status: "approved",
        actor: "operator",
        decidedAt: FIXED_TS,
      },
      createdAt: FIXED_TS,
      updatedAt: FIXED_TS,
    };

    const baseDeps = createMinimalDeps();
    const app = createHttpApp({
      ...baseDeps,
      approvals: {
        ...baseDeps.approvals,
        getLatestApprovalForRun: (runId) => (runId === "run-1" ? legacyApproval : undefined),
      },
    });

    const res = await app.fetch(new Request("http://localhost/api/runs/run-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: Run; approval: Approval | null };
    expect(body.run.id).toBe("run-1");
    expect(body.approval?.effect.operationKind).toBe("legacy");
  });

  it("streams SSE events via Hono streamSSE, respects Last-Event-ID, and returns 204 on consumed terminal cursor", async () => {
    const app = createHttpApp(createMinimalDeps());

    const streamRes = await app.fetch(new Request("http://localhost/api/runs/run-1/events"));
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toBe(SSE_CONTENT_TYPE);
    expect(streamRes.headers.get("cache-control")).toBe(SSE_CACHE_CONTROL);
    const frames = await collectSseFrames(streamRes);
    expect(frames).toEqual([
      {
        kind: "event",
        id: "1",
        event: "message",
        data: JSON.stringify({ type: "RUN_STARTED", runId: "run-1" }),
      },
      {
        kind: "event",
        id: "2",
        event: "message",
        data: JSON.stringify({ type: "RUN_FINISHED", runId: "run-1" }),
      },
    ]);

    const resumeRes = await app.fetch(
      new Request("http://localhost/api/runs/run-1/events", {
        headers: { "last-event-id": "1" },
      }),
    );
    expect(resumeRes.status).toBe(200);
    const resumedFrames = await collectSseFrames(resumeRes);
    expect(resumedFrames).toHaveLength(1);
    expect(resumedFrames[0]).toMatchObject({ kind: "event", id: "2", event: "message" });

    const terminalRes = await app.fetch(
      new Request("http://localhost/api/runs/run-1/events", {
        headers: { "last-event-id": "2" },
      }),
    );
    expect(terminalRes.status).toBe(204);
  });

  it("delegates unmatched routes to extraHttpHandler when provided", async () => {
    const app = createHttpApp(
      createMinimalDeps({
        extraHttpHandler: async (_req, url) =>
          url.pathname === "/custom" ? new Response("custom-ok", { status: 200 }) : undefined,
      }),
    );

    const customRes = await app.fetch(new Request("http://localhost/custom"));
    expect(customRes.status).toBe(200);
    expect(await customRes.text()).toBe("custom-ok");
  });
});

describe("edit a bot's capability policy over HTTP", () => {
  function openApp() {
    const store = openSqliteStore({ filename: ":memory:" });
    store.createBot({
      id: "bot-policy",
      name: "Policy Bot",
      persona: "",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
    });
    return { store, app: createHttpApp({ ...createMinimalDeps(), bots: store }) };
  }

  const patch = (app: ReturnType<typeof createHttpApp>, body: unknown) =>
    app.fetch(
      new Request("http://localhost/api/bots/bot-policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("saves a policy and chain limit and lists them again", async () => {
    const { store, app } = openApp();
    try {
      const res = await patch(app, {
        capabilityPolicy: { "mcp.github": "deny", "notes.publish": "ask" },
        eventChainLimit: 2,
      });
      expect(res.status).toBe(200);

      const listed = (await (await app.fetch(new Request("http://localhost/api/bots"))).json()) as {
        bots: { capabilityPolicy: unknown; eventChainLimit: number }[];
      };
      expect(
        listed.bots.map(({ capabilityPolicy, eventChainLimit }) => ({
          capabilityPolicy,
          eventChainLimit,
        })),
      ).toEqual([
        { capabilityPolicy: { "mcp.github": "deny", "notes.publish": "ask" }, eventChainLimit: 2 },
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects a decision that is not allow, ask or deny", async () => {
    const { store, app } = openApp();
    try {
      const res = await patch(app, { capabilityPolicy: { notes: "sometimes" } });
      expect(res.status).toBe(400);
      expect(store.getBot("bot-policy")?.capabilityPolicy).toEqual({});
    } finally {
      store.close();
    }
  });
});
