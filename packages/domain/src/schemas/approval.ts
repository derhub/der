import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { id, jsonValue } from "./common";

export const effectOperationKind = z.enum([
  "mcp",
  "wasmer",
  "docker",
  "engine-permission",
  "fixture",
  "capability",
]);
export type EffectOperationKind = z.infer<typeof effectOperationKind>;

export const persistedEffectOperationKind = z.enum([
  "mcp",
  "wasmer",
  "docker",
  "engine-permission",
  "fixture",
  "capability",
  "legacy",
]);
export type PersistedEffectOperationKind = z.infer<typeof persistedEffectOperationKind>;

export const effectIdentity = z.object({
  runId: id,
  operationKind: effectOperationKind,
  operationId: z.string().min(1),
  canonicalArguments: jsonValue,
  attemptId: id,
});
export type EffectIdentity = z.infer<typeof effectIdentity>;

export const persistedEffectIdentity = z.object({
  runId: id,
  operationKind: persistedEffectOperationKind,
  operationId: z.string().min(1),
  canonicalArguments: jsonValue,
  attemptId: id,
});
export type PersistedEffectIdentity = z.infer<typeof persistedEffectIdentity>;

export const approvalDecision = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    awakeable: z.string().min(1),
    deadline: utcTimestamp,
  }),
  z.object({
    status: z.literal("approved"),
    actor: z.string().min(1),
    decidedAt: utcTimestamp,
  }),
  z.object({
    status: z.literal("denied"),
    actor: z.string().min(1),
    decidedAt: utcTimestamp,
  }),
  z.object({
    status: z.literal("expired"),
    decidedAt: utcTimestamp,
  }),
]);
export type ApprovalDecision = z.infer<typeof approvalDecision>;

export const approvalResolutionInput = z.discriminatedUnion("status", [
  z.object({
    approvalId: id,
    botId: id,
    sessionId: id,
    runId: id,
    status: z.literal("approved"),
    actor: z.string().min(1),
    decidedAt: utcTimestamp,
  }),
  z.object({
    approvalId: id,
    botId: id,
    sessionId: id,
    runId: id,
    status: z.literal("denied"),
    actor: z.string().min(1),
    decidedAt: utcTimestamp,
  }),
  z.object({
    approvalId: id,
    botId: id,
    sessionId: id,
    runId: id,
    status: z.literal("expired"),
    decidedAt: utcTimestamp,
  }),
]);
export type ApprovalResolutionInput = z.infer<typeof approvalResolutionInput>;

export const approval = z.object({
  id,
  botId: id,
  sessionId: id,
  runId: id,
  effect: persistedEffectIdentity,
  prompt: z.string().min(1),
  awakeable: z.string().min(1),
  deadline: utcTimestamp,
  decision: approvalDecision,
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
});
export type Approval = z.infer<typeof approval>;

export const effectStatus = z.enum(["started", "completed", "unknown"]);
export type EffectStatus = z.infer<typeof effectStatus>;

export const effectRecord = z.object({
  id,
  identity: persistedEffectIdentity,
  status: effectStatus,
  outcome: jsonValue.nullable(),
  startedAt: utcTimestamp,
  updatedAt: utcTimestamp,
});
export type EffectRecord = z.infer<typeof effectRecord>;
