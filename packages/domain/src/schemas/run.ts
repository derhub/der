import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { id, jsonValue, runEngineKind } from "./common";
import { message, messagePart } from "./message";

export const runOrigin = z.enum(["http", "web", "routine"]);
export type RunOrigin = z.infer<typeof runOrigin>;

export const persistedRunOrigin = z.enum(["http", "web", "telegram", "routine"]);
export type PersistedRunOrigin = z.infer<typeof persistedRunOrigin>;

export const runStatus = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatus>;

export const terminalRunStatus = z.enum(["completed", "failed", "interrupted", "cancelled"]);
export type TerminalRunStatus = z.infer<typeof terminalRunStatus>;

export const channelIntakeMetadata = z.object({
  integration: z.enum(["telegram", "fixture"]),
  consumer: z.string().min(1),
  externalUpdateId: z.string().min(1),
  nextCursor: z.string().optional(),
});
export type ChannelIntakeMetadata = z.infer<typeof channelIntakeMetadata>;

export const runUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative(),
  reportedCostUsd: z.number().nonnegative().nullable(),
});
export type RunUsage = z.infer<typeof runUsage>;

export const contextMode = z.enum(["resumed", "rebuilt"]);
export type ContextMode = z.infer<typeof contextMode>;

export const run = z.object({
  id,
  botId: id,
  sessionId: id,
  origin: persistedRunOrigin,
  engine: runEngineKind,
  status: runStatus,
  routineId: id.nullable(),
  checkpoint: jsonValue.nullable(),
  usage: runUsage.nullable().default(null),
  contextMode: contextMode.nullable().default(null),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
  finishedAt: utcTimestamp.nullable(),
});
export type Run = z.infer<typeof run>;

export const runRequest = z
  .strictObject({
    botId: id,
    sessionId: id,
    origin: runOrigin,
    idempotencyKey: z.string().min(1),
    engine: runEngineKind.optional(),
    input: z.object({
      parts: z.array(messagePart).min(1),
    }),
    routineId: id.optional(),
    routineSlot: utcTimestamp.optional(),
  })
  .refine(
    (request) =>
      request.engine !== "script" ||
      (request.origin === "routine" && request.routineId !== undefined),
    { message: 'engine "script" is only admitted for a routine firing', path: ["engine"] },
  );
export type RunRequest = z.infer<typeof runRequest>;

export const runAdmission = z.object({
  run,
  initialMessage: message,
  isDuplicate: z.boolean(),
  payloadFingerprint: z.string().min(1),
});
export type RunAdmission = z.infer<typeof runAdmission>;

export const runEvent = z.object({
  runId: id,
  sequence: z.number().int().positive(),
  chunkKey: z.string().min(1),
  chunk: jsonValue,
  isTerminal: z.boolean().optional(),
  createdAt: utcTimestamp.optional(),
});
export type RunEvent = z.infer<typeof runEvent>;
