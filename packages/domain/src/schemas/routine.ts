import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { engineKind, id, type EngineKind } from "./common";

const routineFields = {
  id,
  botId: id,
  sessionId: id,
  name: z.string().min(1),
  cron: z.string().min(1),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
};

export const routine = z.discriminatedUnion("engine", [
  z.object({
    ...routineFields,
    engine: engineKind,
    prompt: z.string().min(1),
    script: z.null(),
  }),
  z.object({
    ...routineFields,
    engine: z.literal("script"),
    prompt: z.null(),
    script: z.string().min(1),
  }),
]);
export type Routine = z.infer<typeof routine>;

export type RoutineTarget =
  | { readonly engine: EngineKind; readonly prompt: string }
  | { readonly engine: "script"; readonly script: string };

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
