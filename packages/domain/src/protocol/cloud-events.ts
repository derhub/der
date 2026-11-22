import * as z from "zod";
import { effectOperationKind } from "../schemas/approval";
import { id } from "../schemas/common";
import { message } from "../schemas/message";
import { terminalRunStatus } from "../schemas/run";
import { utcTimestamp } from "./timestamp";

export const CLOUD_EVENT_SPEC_VERSION = "1.0" as const;

export const CLOUD_EVENT_TYPES = {
  chatReplied: "der.chat.replied",
  approvalRequested: "der.approval.requested",
  routineFinished: "der.routine.finished",
} as const;

const URI_REFERENCE_PATTERN = /^[^\s\p{Cc}]+$/u;

const cloudEventSource = z
  .string()
  .min(1)
  .regex(URI_REFERENCE_PATTERN, "source must be a valid URI reference");

const envelopeBase = {
  specversion: z.literal(CLOUD_EVENT_SPEC_VERSION),
  id: z.string().min(1),
  source: cloudEventSource,
  time: utcTimestamp,
  subject: z.string().min(1),
  datacontenttype: z.literal("application/json").optional(),
};

export const chatRepliedData = z.strictObject({
  botId: id,
  sessionId: id,
  runId: id,
  message,
});
export type ChatRepliedData = z.infer<typeof chatRepliedData>;

export const approvalRequestedData = z.strictObject({
  botId: id,
  sessionId: id,
  runId: id,
  approvalId: id,
  operationKind: effectOperationKind,
  operationId: z.string().min(1),
  prompt: z.string().min(1),
  deadline: utcTimestamp,
});
export type ApprovalRequestedData = z.infer<typeof approvalRequestedData>;

export const routineFinishedData = z.strictObject({
  botId: id,
  routineId: id,
  runId: id,
  sessionId: id,
  slot: utcTimestamp,
  outcome: terminalRunStatus,
  finishedAt: utcTimestamp,
  detail: z.string().min(1).optional(),
});
export type RoutineFinishedData = z.infer<typeof routineFinishedData>;

export const chatRepliedEvent = z.strictObject({
  ...envelopeBase,
  type: z.literal(CLOUD_EVENT_TYPES.chatReplied),
  data: chatRepliedData,
});
export type ChatRepliedEvent = z.infer<typeof chatRepliedEvent>;

export const approvalRequestedEvent = z.strictObject({
  ...envelopeBase,
  type: z.literal(CLOUD_EVENT_TYPES.approvalRequested),
  data: approvalRequestedData,
});
export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEvent>;

export const routineFinishedEvent = z.strictObject({
  ...envelopeBase,
  type: z.literal(CLOUD_EVENT_TYPES.routineFinished),
  data: routineFinishedData,
});
export type RoutineFinishedEvent = z.infer<typeof routineFinishedEvent>;

export const cloudEvent = z.discriminatedUnion("type", [
  chatRepliedEvent,
  approvalRequestedEvent,
  routineFinishedEvent,
]);
export type CloudEvent = z.infer<typeof cloudEvent>;
