import * as z from "zod";
import { utcTimestamp } from "../protocol/timestamp";
import { id, jsonValue } from "./common";

export const scriptRunStatus = z.enum([
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "in_doubt",
]);
export type ScriptRunStatus = z.infer<typeof scriptRunStatus>;

export const terminalScriptRunStatus = z.enum([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "in_doubt",
]);
export type TerminalScriptRunStatus = z.infer<typeof terminalScriptRunStatus>;

export const executeErrorKind = z.enum([
  "script",
  "denied",
  "expired",
  "limit",
  "capability",
  "cancelled",
  "nondeterministic",
]);
export type ExecuteErrorKind = z.infer<typeof executeErrorKind>;

export const executeResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: jsonValue,
    logs: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      kind: executeErrorKind,
      message: z.string(),
      call: z.string().optional(),
      line: z.number().int().optional(),
    }),
    logs: z.array(z.string()),
  }),
]);
export type ExecuteResult = z.infer<typeof executeResult>;

export const scriptRun = z.object({
  id,
  runId: id,
  botId: id,
  digest: z.string().min(1),
  occurrence: z.number().int().positive(),
  source: z.string(),
  status: scriptRunStatus,
  result: executeResult.nullable(),
  deliveredAt: utcTimestamp.nullable(),
});
export type ScriptRun = z.infer<typeof scriptRun>;
