import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { id, jsonValue } from "./common";

export const sessionEventKind = z.enum(["script.finished"]);
export type SessionEventKind = z.infer<typeof sessionEventKind>;

export const sessionEvent = z.object({
  id,
  botId: id,
  sessionId: id,
  kind: sessionEventKind,
  payload: jsonValue,
  state: z.enum(["pending", "delivered"]),
  runId: id.nullable(),
  createdAt: utcTimestamp,
});
export type SessionEvent = z.infer<typeof sessionEvent>;

export const newSessionEvent = z.object({
  id: id.optional(),
  botId: id,
  sessionId: id,
  kind: sessionEventKind,
  payload: jsonValue,
});
export type NewSessionEvent = z.infer<typeof newSessionEvent>;
