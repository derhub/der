import type * as z from "zod";
import {
  PROBLEM_DETAILS_MEDIA_TYPE,
  type Approval,
  type ApprovalId,
  type Bot,
  type BotId,
  type CapabilityDescriptor,
  type CreateBotInput,
  type EngineKind,
  type EngineReadiness,
  type MemoryRecord,
  type Message,
  type MessagePart,
  type Routine,
  type RoutineId,
  type RunAdmission,
  type RunId,
  type RunOrigin,
  type Session,
  type SessionId,
  type SkillId,
  type UpdateBotInput,
} from "@der/domain";
import {
  approvalDecisionResponseSchema,
  botMemoryResponseSchema,
  botResponseSchema,
  botsResponseSchema,
  capabilitiesResponseSchema,
  configureRoutineResponseSchema,
  enginesResponseSchema,
  healthResponseSchema,
  messagesResponseSchema,
  OperatorApiError,
  parseProblemDetailsResponse,
  routineDetailResponseSchema,
  routinesResponseSchema,
  runAdmissionResponseSchema,
  runDetailResponseSchema,
  sessionResponseSchema,
  sessionsResponseSchema,
  skillDetailResponseSchema,
  skillsCatalogResponseSchema,
  writeMemoryResponseSchema,
  type BotMemoryResponse,
  type ConfigureRoutineResponse,
  type HealthResponse,
  type RoutineDetailResponse,
  type RunDetailResponse,
  type SkillDetailResponse,
  type SkillsCatalogResponse,
} from "./schemas";

export interface OperatorApiOptions {
  readonly baseUrl?: string;
  readonly fetcher?: typeof fetch;
}

export interface CreateSessionPayload {
  readonly title: string;
  readonly engine?: EngineKind;
}

export interface AdmitRunPayload {
  readonly botId?: BotId;
  readonly origin: RunOrigin;
  readonly engine?: EngineKind;
  readonly input: {
    readonly parts: readonly MessagePart[];
  };
}

export interface DecideApprovalPayload {
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly status: "approved" | "denied";
  readonly actor: string;
}

export interface WriteMemoryPayload {
  readonly markdown: string;
  readonly expectedVersion?: number;
}

export interface CreateRoutinePayload {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly engine?: EngineKind;
  readonly prompt: string;
}

export interface UpdateRoutinePayload {
  readonly name?: string;
  readonly cron?: string;
  readonly enabled?: boolean;
  readonly engine?: EngineKind;
  readonly prompt?: string;
  readonly expectedRevision?: number;
}

export interface OperatorApi {
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  listEngines(signal?: AbortSignal): Promise<EngineReadiness[]>;
  listCapabilities(signal?: AbortSignal): Promise<CapabilityDescriptor[]>;
  listBots(signal?: AbortSignal): Promise<Bot[]>;
  createBot(input: CreateBotInput, signal?: AbortSignal): Promise<Bot>;
  updateBot(botId: BotId, input: UpdateBotInput, signal?: AbortSignal): Promise<Bot>;
  listSessions(botId: BotId, signal?: AbortSignal): Promise<Session[]>;
  createSession(botId: BotId, input: CreateSessionPayload, signal?: AbortSignal): Promise<Session>;
  listMessages(
    sessionId: SessionId,
    options?: {
      readonly limit?: number;
      readonly afterOrdinal?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<Message[]>;
  admitRun(
    sessionId: SessionId,
    input: AdmitRunPayload,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<RunAdmission>;
  getRun(runId: RunId, signal?: AbortSignal): Promise<RunDetailResponse>;
  decideApproval(
    approvalId: ApprovalId,
    input: DecideApprovalPayload,
    signal?: AbortSignal,
  ): Promise<Approval>;
  readMemory(botId: BotId, version?: number, signal?: AbortSignal): Promise<BotMemoryResponse>;
  writeMemory(botId: BotId, input: WriteMemoryPayload, signal?: AbortSignal): Promise<MemoryRecord>;
  listSkills(signal?: AbortSignal): Promise<SkillsCatalogResponse>;
  readSkill(skillId: SkillId, signal?: AbortSignal): Promise<SkillDetailResponse>;
  listRoutines(botId: BotId, signal?: AbortSignal): Promise<Routine[]>;
  createRoutine(
    botId: BotId,
    input: CreateRoutinePayload,
    signal?: AbortSignal,
  ): Promise<ConfigureRoutineResponse>;
  getRoutine(routineId: RoutineId, signal?: AbortSignal): Promise<RoutineDetailResponse>;
  updateRoutine(
    routineId: RoutineId,
    input: UpdateRoutinePayload,
    signal?: AbortSignal,
  ): Promise<ConfigureRoutineResponse>;
}

const ACCEPT_JSON = `application/json, ${PROBLEM_DETAILS_MEDIA_TYPE}`;

export function createOperatorApi(options: OperatorApiOptions = {}): OperatorApi {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const fetcher: typeof fetch = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));

  async function requestJson<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init?: {
      readonly method?: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
      readonly signal?: AbortSignal;
    },
  ): Promise<z.infer<TSchema>> {
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {
      accept: ACCEPT_JSON,
      ...init?.headers,
    };

    const fetchInit: RequestInit = {
      method,
      headers,
      credentials: "same-origin",
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    };

    if (init?.body !== undefined) {
      headers["content-type"] = "application/json";
      fetchInit.body = JSON.stringify(init.body);
    }

    const url = `${baseUrl}${path}`;
    const response = await fetcher(url, fetchInit);

    if (!response.ok) {
      throw await parseProblemDetailsResponse(response, path);
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw new OperatorApiError({
        type: "https://der.invalid/problems/invalid-response",
        title: "Invalid JSON response",
        status: 502,
        detail: `Server returned malformed JSON for ${method} ${path}.`,
        instance: path,
        code: "web.invalid_response_json",
      });
    }

    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new OperatorApiError({
        type: "https://der.invalid/problems/schema-mismatch",
        title: "Unexpected server payload",
        status: 502,
        detail: `Response from ${method} ${path} failed contract validation: ${parsed.error.message}`,
        instance: path,
        code: "web.response_schema_mismatch",
      });
    }

    return parsed.data;
  }

  function signalOpt(signal: AbortSignal | undefined) {
    return signal !== undefined ? { signal } : undefined;
  }

  return {
    getHealth(signal) {
      return requestJson("/healthz", healthResponseSchema, signalOpt(signal));
    },
    async listEngines(signal) {
      const data = await requestJson("/api/engines", enginesResponseSchema, signalOpt(signal));
      return data.engines;
    },
    async listCapabilities(signal) {
      const data = await requestJson(
        "/api/capabilities",
        capabilitiesResponseSchema,
        signalOpt(signal),
      );
      return data.capabilities;
    },
    async listBots(signal) {
      const data = await requestJson("/api/bots", botsResponseSchema, signalOpt(signal));
      return data.bots;
    },
    createBot(input, signal) {
      return requestJson("/api/bots", botResponseSchema, {
        method: "POST",
        body: input,
        ...(signal !== undefined ? { signal } : {}),
      });
    },
    updateBot(botId, input, signal) {
      return requestJson(`/api/bots/${encodeURIComponent(botId)}`, botResponseSchema, {
        method: "PATCH",
        body: input,
        ...(signal !== undefined ? { signal } : {}),
      });
    },
    async listSessions(botId, signal) {
      const data = await requestJson(
        `/api/bots/${encodeURIComponent(botId)}/sessions`,
        sessionsResponseSchema,
        signalOpt(signal),
      );
      return data.sessions;
    },
    createSession(botId, input, signal) {
      return requestJson(`/api/bots/${encodeURIComponent(botId)}/sessions`, sessionResponseSchema, {
        method: "POST",
        body: input,
        ...(signal !== undefined ? { signal } : {}),
      });
    },
    async listMessages(sessionId, opts) {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) {
        params.set("limit", String(opts.limit));
      }
      if (opts?.afterOrdinal !== undefined) {
        params.set("afterOrdinal", String(opts.afterOrdinal));
      }
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const data = await requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
        messagesResponseSchema,
        signalOpt(opts?.signal),
      );
      return data.messages;
    },
    admitRun(sessionId, input, idempotencyKey, signal) {
      return requestJson(
        `/api/sessions/${encodeURIComponent(sessionId)}/runs`,
        runAdmissionResponseSchema,
        {
          method: "POST",
          body: input,
          headers: { "idempotency-key": idempotencyKey },
          ...(signal !== undefined ? { signal } : {}),
        },
      );
    },
    getRun(runId, signal) {
      return requestJson(
        `/api/runs/${encodeURIComponent(runId)}`,
        runDetailResponseSchema,
        signalOpt(signal),
      );
    },
    async decideApproval(approvalId, input, signal) {
      const data = await requestJson(
        `/api/approvals/${encodeURIComponent(approvalId)}/decision`,
        approvalDecisionResponseSchema,
        {
          method: "POST",
          body: input,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      return data.approval;
    },
    readMemory(botId, version, signal) {
      const query = version !== undefined ? `?version=${encodeURIComponent(String(version))}` : "";
      return requestJson(
        `/api/bots/${encodeURIComponent(botId)}/memory${query}`,
        botMemoryResponseSchema,
        signalOpt(signal),
      );
    },
    async writeMemory(botId, input, signal) {
      const data = await requestJson(
        `/api/bots/${encodeURIComponent(botId)}/memory`,
        writeMemoryResponseSchema,
        {
          method: "PUT",
          body: input,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
      return data.memory;
    },
    listSkills(signal) {
      return requestJson("/api/skills", skillsCatalogResponseSchema, signalOpt(signal));
    },
    readSkill(skillId, signal) {
      return requestJson(
        `/api/skills/${encodeURIComponent(skillId)}`,
        skillDetailResponseSchema,
        signalOpt(signal),
      );
    },
    async listRoutines(botId, signal) {
      const data = await requestJson(
        `/api/bots/${encodeURIComponent(botId)}/routines`,
        routinesResponseSchema,
        signalOpt(signal),
      );
      return data.routines;
    },
    createRoutine(botId, input, signal) {
      return requestJson(
        `/api/bots/${encodeURIComponent(botId)}/routines`,
        configureRoutineResponseSchema,
        {
          method: "POST",
          body: input,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
    },
    getRoutine(routineId, signal) {
      return requestJson(
        `/api/routines/${encodeURIComponent(routineId)}`,
        routineDetailResponseSchema,
        signalOpt(signal),
      );
    },
    updateRoutine(routineId, input, signal) {
      return requestJson(
        `/api/routines/${encodeURIComponent(routineId)}`,
        configureRoutineResponseSchema,
        {
          method: "PATCH",
          body: input,
          ...(signal !== undefined ? { signal } : {}),
        },
      );
    },
  };
}
