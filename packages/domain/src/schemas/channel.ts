import * as z from "zod";
import { cloudEvent } from "../protocol/cloud-events";
import { utcTimestamp } from "../protocol/timestamp";
import { id } from "./common";

export const channelIntegration = z.enum(["telegram", "fixture"]);
export type ChannelIntegration = z.infer<typeof channelIntegration>;

export const channelBinding = z.object({
  id,
  integration: channelIntegration,
  externalChatId: z.string().min(1),
  externalActorId: z.string().min(1),
  botId: id,
  sessionId: id,
  enabled: z.boolean(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
});
export type ChannelBinding = z.infer<typeof channelBinding>;

export const channelReceiptDisposition = z.enum([
  "admitted",
  "decided",
  "ignored",
  "rejected",
  "duplicate",
]);
export type ChannelReceiptDisposition = z.infer<typeof channelReceiptDisposition>;

export const channelReceipt = z.object({
  integration: channelIntegration,
  consumer: z.string().min(1),
  externalUpdateId: z.string().min(1),
  disposition: channelReceiptDisposition,
  referenceId: id.nullable(),
  recordedAt: utcTimestamp,
});
export type ChannelReceipt = z.infer<typeof channelReceipt>;

export const channelCursor = z.object({
  integration: channelIntegration,
  consumer: z.string().min(1),
  position: z.string(),
  updatedAt: utcTimestamp,
});
export type ChannelCursor = z.infer<typeof channelCursor>;

export const channelUpdatePayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("approval_decision"),
    approvalId: id,
    decision: z.enum(["approved", "denied"]),
    callbackQueryId: z.string().min(1).optional(),
  }),
]);
export type ChannelUpdatePayload = z.infer<typeof channelUpdatePayload>;

export const channelUpdate = z.object({
  integration: channelIntegration,
  externalUpdateId: z.string().min(1),
  externalChatId: z.string().min(1),
  externalActorId: z.string().min(1),
  receivedAt: utcTimestamp,
  payload: channelUpdatePayload,
});
export type ChannelUpdate = z.infer<typeof channelUpdate>;

export const outboxDeliveryState = z.enum(["pending", "delivered", "retrying", "failed"]);
export type OutboxDeliveryState = z.infer<typeof outboxDeliveryState>;

export const outboxEvent = z.object({
  id,
  bindingId: id,
  eventId: z.string().min(1),
  envelope: cloudEvent,
  state: outboxDeliveryState,
  attempts: z.number().int().nonnegative(),
  nextRetryAt: utcTimestamp.nullable(),
  deliveredAt: utcTimestamp.nullable(),
  lastError: z.string().nullable(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
});
export type OutboxEvent = z.infer<typeof outboxEvent>;

export const deliveryResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("delivered"),
    externalMessageId: z.string().min(1).optional(),
    deliveredAt: utcTimestamp,
  }),
  z.object({
    status: z.literal("retryable"),
    retryAfterMs: z.number().int().nonnegative().optional(),
    detail: z.string().min(1),
  }),
  z.object({
    status: z.literal("terminal_failure"),
    code: z.string().min(1),
    detail: z.string().min(1),
  }),
]);
export type DeliveryResult = z.infer<typeof deliveryResult>;
