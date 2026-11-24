import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { engineKind, id } from "./common";

const SELECTOR = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

export const policyDecision = z.enum(["allow", "ask", "deny"]);
export type PolicyDecision = z.infer<typeof policyDecision>;

export const capabilityPolicy = z.record(
  z.string().regex(SELECTOR, "policy key must be a capability id or a dotted namespace"),
  policyDecision,
);
export type CapabilityPolicy = Readonly<z.infer<typeof capabilityPolicy>>;

export const DEFAULT_EVENT_CHAIN_LIMIT = 3;
const eventChainLimit = z.number().int().min(0);

export const bot = z.object({
  id,
  name: z.string().min(1),
  persona: z.string(),
  defaultEngine: engineKind,
  allowedEngines: z.array(engineKind).min(1),
  workspacePath: z.string().min(1).optional(),
  capabilityPolicy,
  eventChainLimit,
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
  capabilityPolicy: capabilityPolicy.default({}),
  eventChainLimit: eventChainLimit.default(DEFAULT_EVENT_CHAIN_LIMIT),
});

export type CreateBotInput = z.input<typeof createBotInput>;

export const updateBotInput = z.object({
  name: z.string().min(1).optional(),
  persona: z.string().optional(),
  defaultEngine: engineKind.optional(),
  allowedEngines: z.array(engineKind).min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  capabilityPolicy: capabilityPolicy.optional(),
  eventChainLimit: eventChainLimit.optional(),
});

export type UpdateBotInput = z.infer<typeof updateBotInput>;
