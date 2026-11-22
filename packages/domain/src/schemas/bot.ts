import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { engineKind, id } from "./common";

export const bot = z.object({
  id,
  name: z.string().min(1),
  persona: z.string(),
  defaultEngine: engineKind,
  allowedEngines: z.array(engineKind).min(1),
  workspacePath: z.string().min(1).optional(),
  createdAt: utcTimestamp,
  updatedAt: utcTimestamp,
});

export type Bot = z.infer<typeof bot>;

export const createBotInput = z.object({
  name: z.string().min(1),
  persona: z.string().default(""),
  defaultEngine: engineKind,
  allowedEngines: z.array(engineKind).min(1),
  workspacePath: z.string().min(1).optional(),
});

export type CreateBotInput = z.infer<typeof createBotInput>;

export const updateBotInput = z.object({
  name: z.string().min(1).optional(),
  persona: z.string().optional(),
  defaultEngine: engineKind.optional(),
  allowedEngines: z.array(engineKind).min(1).optional(),
  workspacePath: z.string().min(1).optional(),
});

export type UpdateBotInput = z.infer<typeof updateBotInput>;
