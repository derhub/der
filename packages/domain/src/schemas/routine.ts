import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { engineKind, id } from "./common";

export const routine = z.object({
  id,
  botId: id,
  sessionId: id,
  name: z.string().min(1),
  cron: z.string().min(1),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  engine: engineKind,
  prompt: z.string().min(1),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
});
export type Routine = z.infer<typeof routine>;

export const routineSlotDisposition = z.enum([
  "admitted",
  "skipped_active_run",
  "blocked_ineligible",
  "skipped_obsolete_revision",
  "completed",
  "failed",
  "interrupted",
]);
export type RoutineSlotDisposition = z.infer<typeof routineSlotDisposition>;

export const routineSlot = z.object({
  routineId: id,
  slot: utcTimestamp,
  revision: z.number().int().positive(),
  disposition: routineSlotDisposition,
  runId: id.nullable(),
  recordedAt: utcTimestamp,
});
export type RoutineSlot = z.infer<typeof routineSlot>;
