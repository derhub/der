import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { engineKind, id } from "./common";

export const session = z.object({
  id,
  botId: id,
  title: z.string().min(1),
  engine: engineKind.optional(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
});

export type Session = z.infer<typeof session>;

export const createSessionInput = z.object({
  botId: id,
  title: z.string().min(1),
  engine: engineKind.optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionInput>;
