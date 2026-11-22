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
  type Engine,
  type EngineKind,
  type EngineReadiness,
} from "@der/domain";
import { compileSchema } from "@der/domain/compiled";
import type { SqliteStore } from "@der/storage";
import type { ServerConfig } from "../config";
import type { DurableWorkflow } from "../workflows/index";
import {
  enforceSameOrigin,
  errorToProblemResponse,
  jsonResponse,
  parseJsonBody,
  problemResponse,
} from "./problem";
import { handleRunEventsSse } from "./sse";

const admitRunBodySchema = compileSchema(
  z.object({
    botId: id.optional(),
    origin: runOrigin.default("http"),
    engine: engineKind.optional(),
    input: z.object({
      parts: z.array(messagePart).min(1),
    }),
    routineId: id.optional(),
    routineSlot: utcTimestamp.optional(),
    channelIntake: channelIntakeMetadata.optional(),
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

export type ExtraHttpHandler = (request: Request, url: URL) => Promise<Response | undefined>;

export interface HttpRouterDeps {
  readonly store: SqliteStore;
  readonly workflow: DurableWorkflow;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly config: ServerConfig;
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

export function createHttpHandler(deps: HttpRouterDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const originError = enforceSameOrigin(request, deps.config.allowedOrigins, pathname);
    if (originError) {
      return originError;
    }

    try {
      if (request.method === "GET" && pathname === "/healthz") {
        return jsonResponse({
          status: "ok",
          timestamp: formatUtcTimestamp(deps.store.database.now()),
        });
      }

      if (request.method === "GET" && pathname === "/api/engines") {
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
      }

      if (pathname === "/api/bots") {
        if (request.method === "GET") {
          return jsonResponse({ bots: deps.store.listBots() });
        }
        if (request.method === "POST") {
          const body = await parseJsonBody(request, pathname);
          const bot = deps.store.createBot(body as Parameters<SqliteStore["createBot"]>[0]);
          return jsonResponse(bot, 201);
        }
      }

      const botMatch = /^\/api\/bots\/([^/]+)$/.exec(pathname);
      if (botMatch?.[1] && request.method === "PATCH") {
        const botId = decodeURIComponent(botMatch[1]);
        const body = await parseJsonBody(request, pathname);
        const updated = deps.store.updateBot(
          botId,
          body as Parameters<SqliteStore["updateBot"]>[1],
        );
        return jsonResponse(updated);
      }

      const botSessionsMatch = /^\/api\/bots\/([^/]+)\/sessions$/.exec(pathname);
      if (botSessionsMatch?.[1]) {
        const botId = decodeURIComponent(botSessionsMatch[1]);
        if (request.method === "GET") {
          if (!deps.store.getBot(botId)) {
            return problemResponse({
              type: "https://der.invalid/problems/bot-not-found",
              title: "Bot not found",
              status: 404,
              detail: `Bot ${botId} does not exist.`,
              instance: pathname,
              code: "bot.not_found",
            });
          }
          return jsonResponse({ sessions: deps.store.listSessions(botId) });
        }
        if (request.method === "POST") {
          const body = (await parseJsonBody(request, pathname)) as Record<string, unknown>;
          const created = deps.store.createSession({
            ...(body as Omit<Parameters<SqliteStore["createSession"]>[0], "botId">),
            botId,
          });
          return jsonResponse(created, 201);
        }
      }

      const sessionMessagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
      if (sessionMessagesMatch?.[1] && request.method === "GET") {
        const sessionId = decodeURIComponent(sessionMessagesMatch[1]);
        if (!deps.store.getSession(sessionId)) {
          return problemResponse({
            type: "https://der.invalid/problems/session-not-found",
            title: "Session not found",
            status: 404,
            detail: `Session ${sessionId} does not exist.`,
            instance: pathname,
            code: "session.not_found",
          });
        }
        const limit = parsePositiveIntParam(
          url.searchParams.get("limit"),
          "limit",
          pathname,
          1,
          200,
        );
        const afterOrdinal = parsePositiveIntParam(
          url.searchParams.get("afterOrdinal"),
          "afterOrdinal",
          pathname,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const messages = deps.store.listMessages(sessionId, {
          ...(limit !== undefined ? { limit } : {}),
          ...(afterOrdinal !== undefined ? { afterOrdinal } : {}),
        });
        return jsonResponse({ messages });
      }

      const sessionRunsMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(pathname);
      if (sessionRunsMatch?.[1] && request.method === "POST") {
        const sessionId = decodeURIComponent(sessionRunsMatch[1]);
        const idempotencyKey = request.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) {
          return problemResponse({
            type: "https://der.invalid/problems/missing-idempotency-key",
            title: "Missing Idempotency-Key header",
            status: 400,
            detail:
              "POST /api/sessions/{sessionId}/runs requires a non-empty Idempotency-Key header.",
            instance: pathname,
            code: "http.missing_idempotency_key",
          });
        }

        const rawBody = await parseJsonBody(request, pathname);
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

        const session = deps.store.getSession(sessionId);
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
          ...(parsedBody.data.routineId !== undefined
            ? { routineId: parsedBody.data.routineId }
            : {}),
          ...(parsedBody.data.routineSlot !== undefined
            ? { routineSlot: parsedBody.data.routineSlot }
            : {}),
          ...(parsedBody.data.channelIntake !== undefined
            ? { channelIntake: parsedBody.data.channelIntake }
            : {}),
        });

        return jsonResponse(admission, 202);
      }

      const runEventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
      if (runEventsMatch?.[1] && request.method === "GET") {
        const runId = decodeURIComponent(runEventsMatch[1]);
        return handleRunEventsSse(request, url, runId, {
          store: deps.store,
          pollIntervalMs: deps.config.ssePollIntervalMs,
          keepAliveMs: deps.config.sseKeepAliveMs,
        });
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname);
      if (runMatch?.[1] && request.method === "GET") {
        const runId = decodeURIComponent(runMatch[1]);
        const run = deps.store.getRun(runId);
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
        const approval = deps.store.getLatestApprovalForRun(runId) ?? null;
        return jsonResponse({ run, approval });
      }

      const approvalDecisionMatch = /^\/api\/approvals\/([^/]+)\/decision$/.exec(pathname);
      if (approvalDecisionMatch?.[1] && request.method === "POST") {
        const approvalId = decodeURIComponent(approvalDecisionMatch[1]);
        const rawBody = await parseJsonBody(request, pathname);
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

        const decidedAt =
          parsedBody.data.decidedAt ?? formatUtcTimestamp(deps.store.database.now());
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
      }

      if (deps.extraHttpHandler) {
        const extra = await deps.extraHttpHandler(request, url);
        if (extra) {
          return extra;
        }
      }

      return problemResponse({
        type: "https://der.invalid/problems/not-found",
        title: "Route not found",
        status: 404,
        detail: `No handler registered for ${request.method} ${pathname}.`,
        instance: pathname,
        code: "http.not_found",
      });
    } catch (error) {
      return errorToProblemResponse(error, pathname);
    }
  };
}
