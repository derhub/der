import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { id } from "./common";

export const memoryRecord = z.object({
  id,
  botId: id,
  version: z.number().int().positive(),
  markdown: z.string(),
  updatedAt: utcTimestamp,
});
export type MemoryRecord = z.infer<typeof memoryRecord>;

export const memoryWriteInput = z.object({
  botId: id,
  expectedVersion: z.number().int().nonnegative().optional(),
  markdown: z.string(),
});
export type MemoryWriteInput = z.infer<typeof memoryWriteInput>;
