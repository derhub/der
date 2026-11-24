import { Hono } from "hono";
import * as z from "zod";
import {
  DomainError,
  channelIntakeMetadata,
  engineKind,
  formatUtcTimestamp,
  id,
  messagePart,
  runOrigin,
  utcTimestamp,
  type ApprovalEffectStore,
  type BotId,
  type BotStore,
  type Catalog,
  type Engine,
  type EngineKind,
  type EngineReadiness,
  type MaybePromise,
  type Memory,
  type MemoryRecord,
  type Routine,
  type RoutineId,
  type RoutineSlot,
  type RoutineStore,
  type RoutineTarget,
  type RunStore,
  type SessionStore,
} from "@der/domain";
import { compileSchema } from "@der/domain/compiled";
import type { SkillCatalog } from "@der/runtime/context";
import type { ServerConfig } from "../config";
import type { DurableWorkflow, RoutineScheduleClient } from "../workflows/index";
import {
  errorToProblemResponse,
  jsonResponse,
  parseJsonBody,
  problemErrorHandler,
  problemResponse,
  sameOriginMiddleware,
} from "./problem";
import { handleRunEventsSse } from "./sse";

const admitRunBodySchema = compileSchema(
  z.strictObject({
    botId: id.optional(),
    origin: runOrigin.default("http"),
    engine: engineKind.optional(),
    input: z.object({
      parts: z.array(messagePart).min(1),
    }),
    routineId: id.optional(),
    routineSlot: utcTimestamp.optional(),
  }),
);

const decisionBodySchema = compileSchema(
  z.object({
    botId: id,
    sessionId: id,
    runId: id,
    status: z.enum(["approved", "denied"]),
    actor: z.string().min(1),
    decidedAt: utcTimestamp.optional(),
    channelIntake: channelIntakeMetadata.optional(),
  }),
);

const writeMemoryBodySchema = compileSchema(
  z.object({
    markdown: z.string(),
    expectedVersion: z.number().int().nonnegative().optional(),
  }),
);

const routineBodyFields = {
  id: id.optional(),
  sessionId: id,
  name: z.string().min(1),
  cron: z.string().min(1),
  enabled: z.boolean().default(true),
};

const createRoutineBodySchema = compileSchema(
  z.union([
    z.strictObject({
      ...routineBodyFields,
      engine: engineKind.optional(),
      prompt: z.string().min(1),
    }),
    z.strictObject({ ...routineBodyFields, script: z.string().min(1) }),
  ]),
);

const updateRoutineBodySchema = compileSchema(
  z.object({
    name: z.string().min(1).optional(),
    cron: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    engine: engineKind.optional(),
    prompt: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
    expectedRevision: z.number().int().positive().optional(),
  }),
);

export type ExtraHttpHandler = (request: Request, url: URL) => Promise<Response | undefined>;

export interface HttpMemoryPort extends Memory {
  listVersions(botId: BotId): MaybePromise<readonly MemoryRecord[]>;
}

export interface HttpRoutinePort extends Pick<RoutineStore, "getRoutine"> {
  listRoutines(botId?: BotId): MaybePromise<readonly Routine[]>;
  listSlots(routineId: RoutineId): MaybePromise<readonly RoutineSlot[]>;
}

export type HttpSkillPort = Pick<SkillCatalog, "loadCatalog" | "listSkills" | "readSkillBody">;

export interface HttpRouterDeps {
  readonly bots: BotStore;
  readonly sessions: SessionStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalEffectStore;
  readonly memory: HttpMemoryPort;
  readonly routines: HttpRoutinePort;
  readonly skills: HttpSkillPort;
  readonly catalog: Catalog;
  readonly workflow: DurableWorkflow;
  readonly routineSchedule: RoutineScheduleClient;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly config: ServerConfig;
  readonly now?: () => Date;
  readonly extraHttpHandler?: ExtraHttpHandler;
}

function parsePositiveIntParam(
  raw: string | null,
  name: string,
  instance: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new DomainError({
      type: "https://der.invalid/problems/invalid-query",
      title: "Invalid query parameter",
      status: 400,
      detail: `Query parameter "${name}" must be a non-negative integer.`,
      instance,
      code: "http.invalid_query",
    });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError({
      type: "https://der.invalid/problems/invalid-query",
      title: "Query parameter out of range",
      status: 400,
      detail: `Query parameter "${name}" must be between ${min} and ${max}.`,
      instance,
      code: "http.invalid_query",
    });
  }
  return value;
}

function createHealthRoutes(deps: {
  readonly now: () => Date;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly catalog: Catalog;
}): Hono {
  const routes = new Hono();

  routes.get("/healthz", () =>
    jsonResponse({
      status: "ok",
      timestamp: formatUtcTimestamp(deps.now()),
    }),
  );

  routes.get("/api/engines", async () => {
    const readiness: EngineReadiness[] = [];
    for (const [kind, engine] of deps.engines.entries()) {
      if (engine.diagnose) {
        readiness.push(await engine.diagnose());
      } else {
        readiness.push({
          engine: kind,
          interactive: "ready",
          unattended: "unverified",
          isolationVerified: false,
          reasons: ["Engine diagnostics not configured."],
        });
      }
    }
    return jsonResponse({ engines: readiness });
  });

  routes.get("/api/capabilities", () => jsonResponse({ capabilities: deps.catalog.list() }));

  return routes;
}

function createSkillRoutes(deps: { readonly skills: HttpSkillPort }): Hono {
  const routes = new Hono();

  routes.get("/api/skills", async () => {
    const catalog = await deps.skills.loadCatalog();
    return jsonResponse({
      skills: catalog.skills,
      rejected: catalog.rejected,
    });
  });

  routes.get("/api/skills/:skillId", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const skillId = c.req.param("skillId");
    const skills = await deps.skills.listSkills();
    const metadata = skills.find((entry) => entry.id === skillId);
    if (!metadata) {
      return problemResponse({
        type: "https://der.invalid/problems/skill-not-found",
        title: "Skill not found",
        status: 404,
        detail: `Skill "${skillId}" does not exist in the catalog.`,
        instance: pathname,
        code: "skill.not_found",
      });
    }
    const body = await deps.skills.readSkillBody(skillId);
    return jsonResponse({ skill: metadata, body });
  });

  return routes;
}

function createBotRoutes(deps: { readonly bots: BotStore }): Hono {
  const routes = new Hono();

  routes.get("/api/bots", async () => jsonResponse({ bots: await deps.bots.listBots() }));

  routes.post("/api/bots", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const body = await parseJsonBody(c.req.raw, pathname);
    const bot = await deps.bots.createBot(body as Parameters<BotStore["createBot"]>[0]);
    return jsonResponse(bot, 201);
  });

  routes.patch("/api/bots/:botId", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const botId = c.req.param("botId");
    const body = await parseJsonBody(c.req.raw, pathname);
    const updated = await deps.bots.updateBot(botId, body as Parameters<BotStore["updateBot"]>[1]);
    return jsonResponse(updated);
  });

  return routes;
}

function createMemoryRoutes(deps: {
  readonly bots: BotStore;
  readonly memory: HttpMemoryPort;
}): Hono {
  const routes = new Hono();

  routes.get("/api/bots/:botId/memory", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const botId = c.req.param("botId");
    if (!(await deps.bots.getBot(botId))) {
      return problemResponse({
        type: "https://der.invalid/problems/bot-not-found",
        title: "Bot not found",
        status: 404,
        detail: `Bot ${botId} does not exist.`,
        instance: pathname,
        code: "bot.not_found",
      });
    }

    const version = parsePositiveIntParam(
      url.searchParams.get("version"),
      "version",
      pathname,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const record = await deps.memory.read(botId, version);
    if (version !== undefined && !record) {
      return problemResponse({
        type: "https://der.invalid/problems/memory-not-found",
        title: "Memory version not found",
        status: 404,
        detail: `Memory version ${version} does not exist for bot ${botId}.`,
        instance: pathname,
        code: "memory.not_found",
      });
    }
    const versions = (await deps.memory.listVersions(botId)).map((entry) => ({
      version: entry.version,
      updatedAt: entry.updatedAt,
    }));
    return jsonResponse({
      memory: record ?? null,
      versions,
    });
  });

  routes.put("/api/bots/:botId/memory", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const botId = c.req.param("botId");
    if (!(await deps.bots.getBot(botId))) {
      return problemResponse({
        type: "https://der.invalid/problems/bot-not-found",
        title: "Bot not found",
        status: 404,
        detail: `Bot ${botId} does not exist.`,
        instance: pathname,
        code: "bot.not_found",
      });
    }

    const rawBody = await parseJsonBody(c.req.raw, pathname);
    const parsedBody = writeMemoryBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return problemResponse({
        type: "https://der.invalid/problems/invalid-memory-write",
        title: "Invalid memory payload",
        status: 400,
        detail: parsedBody.error.message,
        instance: pathname,
        code: "memory.invalid_input",
      });
    }
    const written = await deps.memory.write({
      botId,
      markdown: parsedBody.data.markdown,
      ...(parsedBody.data.expectedVersion !== undefined
        ? { expectedVersion: parsedBody.data.expectedVersion }
        : {}),
    });
    return jsonResponse({ memory: written });
  });

  return routes;
}

function createRoutineRoutes(deps: {
  readonly bots: BotStore;
  readonly sessions: SessionStore;
  readonly routines: HttpRoutinePort;
  readonly routineSchedule: RoutineScheduleClient;
}): Hono {
  const routes = new Hono();

  routes.get("/api/bots/:botId/routines", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const botId = c.req.param("botId");
    if (!(await deps.bots.getBot(botId))) {
      return problemResponse({
        type: "https://der.invalid/problems/bot-not-found",
        title: "Bot not found",
        status: 404,
        detail: `Bot ${botId} does not exist.`,
        instance: pathname,
        code: "bot.not_found",
      });
    }
    return jsonResponse({ routines: await deps.routines.listRoutines(botId) });
  });

  routes.post("/api/bots/:botId/routines", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const botId = c.req.param("botId");
    const bot = await deps.bots.getBot(botId);
    if (!bot) {
      return problemResponse({
        type: "https://der.invalid/problems/bot-not-found",
        title: "Bot not found",
        status: 404,
        detail: `Bot ${botId} does not exist.`,
        instance: pathname,
        code: "bot.not_found",
      });
    }

    const rawBody = await parseJsonBody(c.req.raw, pathname);
    const parsedBody = createRoutineBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return problemResponse({
        type: "https://der.invalid/problems/invalid-routine",
        title: "Invalid routine request",
        status: 400,
        detail: parsedBody.error.message,
        instance: pathname,
        code: "routine.invalid_input",
      });
    }

    const session = await deps.sessions.getSession(parsedBody.data.sessionId);
    if (!session || session.botId !== botId) {
      return problemResponse({
        type: "https://der.invalid/problems/session-not-found",
        title: "Session not found in bot scope",
        status: 404,
        detail: `Session ${parsedBody.data.sessionId} does not belong to bot ${botId}.`,
        instance: pathname,
        code: "session.not_found",
      });
    }

    const routineId = parsedBody.data.id ?? `rt_${crypto.randomUUID()}`;
    const body = parsedBody.data;
    const target: RoutineTarget =
      "script" in body
        ? { engine: "script", script: body.script }
        : { engine: body.engine ?? session.engine ?? bot.defaultEngine, prompt: body.prompt };
    const configured = await deps.routineSchedule.configure(routineId, {
      kind: "create",
      botId,
      sessionId: body.sessionId,
      name: body.name,
      cron: body.cron,
      enabled: body.enabled,
      ...target,
    });
    return jsonResponse(configured, 201);
  });

  routes.get("/api/routines/:routineId", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const routineId = c.req.param("routineId");
    const routine = await deps.routines.getRoutine(routineId);
    if (!routine) {
      return problemResponse({
        type: "https://der.invalid/problems/routine-not-found",
        title: "Routine not found",
        status: 404,
        detail: `Routine ${routineId} does not exist.`,
        instance: pathname,
        code: "routine.not_found",
      });
    }
    const slots = await deps.routines.listSlots(routineId);
    return jsonResponse({ routine, slots });
  });

  routes.patch("/api/routines/:routineId", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const routineId = c.req.param("routineId");
    const rawBody = await parseJsonBody(c.req.raw, pathname);
    const parsedBody = updateRoutineBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return problemResponse({
        type: "https://der.invalid/problems/invalid-routine",
        title: "Invalid routine update",
        status: 400,
        detail: parsedBody.error.message,
        instance: pathname,
        code: "routine.invalid_input",
      });
    }
    const updated = await deps.routineSchedule.configure(routineId, {
      kind: "update",
      ...(parsedBody.data.name !== undefined ? { name: parsedBody.data.name } : {}),
      ...(parsedBody.data.cron !== undefined ? { cron: parsedBody.data.cron } : {}),
      ...(parsedBody.data.enabled !== undefined ? { enabled: parsedBody.data.enabled } : {}),
      ...(parsedBody.data.engine !== undefined ? { engine: parsedBody.data.engine } : {}),
      ...(parsedBody.data.prompt !== undefined ? { prompt: parsedBody.data.prompt } : {}),
      ...(parsedBody.data.script !== undefined ? { script: parsedBody.data.script } : {}),
      ...(parsedBody.data.expectedRevision !== undefined
        ? { expectedRevision: parsedBody.data.expectedRevision }
        : {}),
    });
    return jsonResponse(updated);
  });

  return routes;
}

function createSessionRoutes(deps: {
  readonly bots: BotStore;
  readonly sessions: SessionStore;
}): Hono {
  const routes = new Hono();

  routes.get("/api/bots/:botId/sessions", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const botId = c.req.param("botId");
    if (!(await deps.bots.getBot(botId))) {
      return problemResponse({
        type: "https://der.invalid/problems/bot-not-found",
        title: "Bot not found",
        status: 404,
        detail: `Bot ${botId} does not exist.`,
        instance: pathname,
        code: "bot.not_found",
      });
    }
    return jsonResponse({ sessions: await deps.sessions.listSessions(botId) });
  });

  routes.post("/api/bots/:botId/sessions", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const botId = c.req.param("botId");
    const body = (await parseJsonBody(c.req.raw, pathname)) as Record<string, unknown>;
    const created = await deps.sessions.createSession({
      ...(body as Omit<Parameters<SessionStore["createSession"]>[0], "botId">),
      botId,
    });
    return jsonResponse(created, 201);
  });

  routes.get("/api/sessions/:sessionId/messages", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const sessionId = c.req.param("sessionId");
    if (!(await deps.sessions.getSession(sessionId))) {
      return problemResponse({
        type: "https://der.invalid/problems/session-not-found",
        title: "Session not found",
        status: 404,
        detail: `Session ${sessionId} does not exist.`,
        instance: pathname,
        code: "session.not_found",
      });
    }
    const limit = parsePositiveIntParam(url.searchParams.get("limit"), "limit", pathname, 1, 200);
    const afterOrdinal = parsePositiveIntParam(
      url.searchParams.get("afterOrdinal"),
      "afterOrdinal",
      pathname,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const messages = await deps.sessions.listMessages(sessionId, {
      ...(limit !== undefined ? { limit } : {}),
      ...(afterOrdinal !== undefined ? { afterOrdinal } : {}),
    });
    return jsonResponse({ messages });
  });

  return routes;
}

function createRunRoutes(deps: {
  readonly sessions: SessionStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalEffectStore;
  readonly workflow: DurableWorkflow;
  readonly config: Pick<ServerConfig, "ssePollIntervalMs" | "sseKeepAliveMs">;
}): Hono {
  const routes = new Hono();

  routes.post("/api/sessions/:sessionId/runs", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const sessionId = c.req.param("sessionId");
    const idempotencyKey = c.req.header("idempotency-key")?.trim();
    if (!idempotencyKey) {
      return problemResponse({
        type: "https://der.invalid/problems/missing-idempotency-key",
        title: "Missing Idempotency-Key header",
        status: 400,
        detail: "POST /api/sessions/{sessionId}/runs requires a non-empty Idempotency-Key header.",
        instance: pathname,
        code: "http.missing_idempotency_key",
      });
    }

    const rawBody = await parseJsonBody(c.req.raw, pathname);
    const parsedBody = admitRunBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return problemResponse({
        type: "https://der.invalid/problems/invalid-run-request",
        title: "Invalid run request",
        status: 400,
        detail: parsedBody.error.message,
        instance: pathname,
        code: "run.invalid_request",
      });
    }

    const session = await deps.sessions.getSession(sessionId);
    if (!session) {
      return problemResponse({
        type: "https://der.invalid/problems/session-not-found",
        title: "Session not found",
        status: 404,
        detail: `Session ${sessionId} does not exist.`,
        instance: pathname,
        code: "session.not_found",
      });
    }

    const admission = await deps.workflow.admit({
      botId: parsedBody.data.botId ?? session.botId,
      sessionId,
      origin: parsedBody.data.origin,
      idempotencyKey,
      ...(parsedBody.data.engine !== undefined ? { engine: parsedBody.data.engine } : {}),
      input: parsedBody.data.input,
      ...(parsedBody.data.routineId !== undefined ? { routineId: parsedBody.data.routineId } : {}),
      ...(parsedBody.data.routineSlot !== undefined
        ? { routineSlot: parsedBody.data.routineSlot }
        : {}),
    });

    return jsonResponse(admission, 202);
  });

  routes.get("/api/sessions/:sessionId/runs", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const sessionId = c.req.param("sessionId");
    if (!(await deps.sessions.getSession(sessionId))) {
      return problemResponse({
        type: "https://der.invalid/problems/session-not-found",
        title: "Session not found",
        status: 404,
        detail: `Session ${sessionId} does not exist.`,
        instance: pathname,
        code: "session.not_found",
      });
    }
    return jsonResponse({ runs: await deps.runs.listSessionRuns(sessionId) });
  });

  routes.get("/api/runs/:runId/events", (c) => {
    const runId = c.req.param("runId");
    return handleRunEventsSse(c, runId, {
      runs: deps.runs,
      pollIntervalMs: deps.config.ssePollIntervalMs,
      keepAliveMs: deps.config.sseKeepAliveMs,
    });
  });

  routes.get("/api/runs/:runId", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const runId = c.req.param("runId");
    const run = await deps.runs.getRun(runId);
    if (!run) {
      return problemResponse({
        type: "https://der.invalid/problems/run-not-found",
        title: "Run not found",
        status: 404,
        detail: `Run ${runId} does not exist.`,
        instance: pathname,
        code: "run.not_found",
      });
    }
    const approval = (await deps.approvals.getLatestApprovalForRun(runId)) ?? null;
    return jsonResponse({ run, approval });
  });

  return routes;
}

function createApprovalRoutes(deps: {
  readonly workflow: DurableWorkflow;
  readonly now: () => Date;
}): Hono {
  const routes = new Hono();

  routes.post("/api/approvals/:approvalId/decision", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const approvalId = c.req.param("approvalId");
    const rawBody = await parseJsonBody(c.req.raw, pathname);
    const parsedBody = decisionBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return problemResponse({
        type: "https://der.invalid/problems/invalid-approval-decision",
        title: "Invalid approval decision",
        status: 400,
        detail: parsedBody.error.message,
        instance: pathname,
        code: "approval.invalid_decision",
      });
    }

    const decidedAt = formatUtcTimestamp(deps.now());
    const approval = await deps.workflow.decide(
      {
        approvalId,
        botId: parsedBody.data.botId,
        sessionId: parsedBody.data.sessionId,
        runId: parsedBody.data.runId,
        status: parsedBody.data.status,
        actor: parsedBody.data.actor,
        decidedAt,
      },
      parsedBody.data.channelIntake,
    );

    return jsonResponse({ approval });
  });

  return routes;
}

export function createHttpApp(deps: HttpRouterDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.onError(problemErrorHandler);
  app.use("*", sameOriginMiddleware(deps.config.allowedOrigins));

  app.route("/", createHealthRoutes({ now, engines: deps.engines, catalog: deps.catalog }));
  app.route("/", createSkillRoutes({ skills: deps.skills }));
  app.route("/", createBotRoutes({ bots: deps.bots }));
  app.route("/", createMemoryRoutes({ bots: deps.bots, memory: deps.memory }));
  app.route(
    "/",
    createRoutineRoutes({
      bots: deps.bots,
      sessions: deps.sessions,
      routines: deps.routines,
      routineSchedule: deps.routineSchedule,
    }),
  );
  app.route("/", createSessionRoutes({ bots: deps.bots, sessions: deps.sessions }));
  app.route(
    "/",
    createRunRoutes({
      sessions: deps.sessions,
      runs: deps.runs,
      approvals: deps.approvals,
      workflow: deps.workflow,
      config: deps.config,
    }),
  );
  app.route("/", createApprovalRoutes({ workflow: deps.workflow, now }));

  app.notFound(async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    try {
      if (deps.extraHttpHandler) {
        const extra = await deps.extraHttpHandler(c.req.raw, url);
        if (extra) {
          return extra;
        }
      }
      return problemResponse({
        type: "https://der.invalid/problems/not-found",
        title: "Route not found",
        status: 404,
        detail: `No handler registered for ${c.req.method} ${pathname}.`,
        instance: pathname,
        code: "http.not_found",
      });
    } catch (error) {
      return errorToProblemResponse(error, pathname);
    }
  });

  return app;
}
