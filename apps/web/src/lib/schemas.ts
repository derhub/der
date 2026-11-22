import * as z from "zod";
import {
  approval,
  bot,
  engineReadiness,
  jsonValue,
  memoryRecord,
  message,
  PROBLEM_DETAILS_MEDIA_TYPE,
  problemDetails,
  routine,
  routineSlot,
  run,
  runAdmission,
  session,
  skill,
  toolDescriptor,
  utcTimestamp,
  type ProblemDetails,
} from "@der/domain";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  timestamp: utcTimestamp,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const enginesResponseSchema = z.object({
  engines: z.array(engineReadiness),
});

export const toolsResponseSchema = z.object({
  tools: z.array(toolDescriptor),
});

export const botsResponseSchema = z.object({
  bots: z.array(bot),
});

export const sessionsResponseSchema = z.object({
  sessions: z.array(session),
});

export const messagesResponseSchema = z.object({
  messages: z.array(message),
});

export const runDetailResponseSchema = z.object({
  run,
  approval: approval.nullable(),
});
export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>;

export const approvalDecisionResponseSchema = z.object({
  approval,
});

export const memoryVersionSummarySchema = z.object({
  version: z.number().int().positive(),
  updatedAt: utcTimestamp,
});
export type MemoryVersionSummary = z.infer<typeof memoryVersionSummarySchema>;

export const botMemoryResponseSchema = z.object({
  memory: memoryRecord.nullable(),
  versions: z.array(memoryVersionSummarySchema),
});
export type BotMemoryResponse = z.infer<typeof botMemoryResponseSchema>;

export const writeMemoryResponseSchema = z.object({
  memory: memoryRecord,
});

export const rejectedSkillSchema = z.object({
  relativePath: z.string().min(1),
  reason: z.string().min(1),
});
export type RejectedSkill = z.infer<typeof rejectedSkillSchema>;

export const skillsCatalogResponseSchema = z.object({
  skills: z.array(skill),
  rejected: z.array(rejectedSkillSchema),
});
export type SkillsCatalogResponse = z.infer<typeof skillsCatalogResponseSchema>;

export const skillDetailResponseSchema = z.object({
  skill,
  body: z.string(),
});
export type SkillDetailResponse = z.infer<typeof skillDetailResponseSchema>;

export const routinesResponseSchema = z.object({
  routines: z.array(routine),
});

export const configureRoutineResponseSchema = z.object({
  routine,
  nextSlot: utcTimestamp.nullable(),
});
export type ConfigureRoutineResponse = z.infer<typeof configureRoutineResponseSchema>;

export const routineDetailResponseSchema = z.object({
  routine,
  slots: z.array(routineSlot),
});
export type RoutineDetailResponse = z.infer<typeof routineDetailResponseSchema>;

export const sseChunkPayloadSchema = z.object({ type: z.string().min(1) }).catchall(jsonValue);

export const botResponseSchema = bot;
export const sessionResponseSchema = session;
export const runAdmissionResponseSchema = runAdmission;

export class OperatorApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    const validated = problemDetails.parse(problem);
    super(validated.detail);
    this.name = "OperatorApiError";
    this.code = validated.code;
    this.status = validated.status;
    this.problem = validated;
  }
}

export function isOperatorApiError(error: unknown): error is OperatorApiError {
  return error instanceof OperatorApiError;
}

export function toOperatorProblem(error: unknown, fallbackInstance: string): ProblemDetails {
  if (error instanceof OperatorApiError) {
    return error.problem;
  }
  const detail =
    error instanceof Error && error.message.length > 0 ? error.message : "Request failed.";
  return problemDetails.parse({
    type: "https://der.invalid/problems/client-error",
    title: "Request failed",
    status: 500,
    detail,
    instance: fallbackInstance,
    code: "web.request_failed",
  });
}

export async function parseProblemDetailsResponse(
  response: Response,
  fallbackInstance: string,
): Promise<OperatorApiError> {
  const status = response.status >= 400 && response.status <= 599 ? response.status : 500;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  let rawText = "";
  try {
    rawText = await response.text();
  } catch {
    rawText = "";
  }

  if (
    rawText.trim().length > 0 &&
    (contentType.includes(PROBLEM_DETAILS_MEDIA_TYPE) || contentType.includes("json"))
  ) {
    try {
      const decoded: unknown = JSON.parse(rawText);
      const parsed = problemDetails.safeParse(decoded);
      if (parsed.success) {
        return new OperatorApiError(parsed.data);
      }
    } catch {
      // Fall through to synthesized ProblemDetails below.
    }
  }

  const detail =
    rawText.trim().length > 0
      ? rawText.trim().slice(0, 500)
      : `HTTP ${status} ${response.statusText || "error"} from ${fallbackInstance}.`;

  return new OperatorApiError({
    type: "https://der.invalid/problems/http-error",
    title: response.statusText || `HTTP ${status}`,
    status,
    detail,
    instance: fallbackInstance,
    code: `http.status_${status}`,
  });
}
