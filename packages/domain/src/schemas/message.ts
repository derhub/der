import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { id, jsonValue } from "./common";

export const messageRole = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof messageRole>;

export const messagePart = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolCallId: id,
    toolName: z.string().min(1),
    arguments: jsonValue,
  }),
  z.object({
    type: z.literal("tool-result"),
    toolCallId: id,
    toolName: z.string().min(1),
    outcome: jsonValue,
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("data"),
    mimeType: z.string().min(1),
    data: jsonValue,
  }),
]);

export type MessagePart = z.infer<typeof messagePart>;

export const message = z.object({
  id,
  botId: id,
  sessionId: id,
  ordinal: z.number().int().positive(),
  role: messageRole,
  parts: z.array(messagePart),
  runId: id.nullable(),
  createdAt: utcTimestamp,
});

export type Message = z.infer<typeof message>;
