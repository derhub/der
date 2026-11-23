import * as z from "zod";
import { engineKind, jsonValue } from "./common";
import { messagePart } from "./message";
import { runUsage } from "./run";

export const engineEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chunk"),
    chunkKey: z.string().min(1),
    chunk: jsonValue,
    isTerminal: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("completed"),
    finalMessage: z
      .object({
        parts: z.array(messagePart),
      })
      .optional(),
    usage: runUsage.optional(),
  }),
  z.object({
    type: z.literal("failed"),
    code: z.string().min(1),
    detail: z.string().min(1),
  }),
]);
export type EngineEvent = z.infer<typeof engineEvent>;

export const engineReadiness = z.object({
  engine: engineKind,
  interactive: z.enum(["ready", "login_required", "blocked"]),
  unattended: z.enum(["ready", "blocked", "unverified"]),
  isolationVerified: z.boolean(),
  reasons: z.array(z.string()),
  loginGuidance: z.string().min(1).optional(),
});
export type EngineReadiness = z.infer<typeof engineReadiness>;

export const sandboxRequest = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive(),
  writablePaths: z.array(z.string().min(1)).optional(),
  readonlyPaths: z.array(z.string().min(1)).optional(),
  network: z.enum(["none", "scoped_egress"]),
});
export type SandboxRequest = z.infer<typeof sandboxRequest>;

export const sandboxResult = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type SandboxResult = z.infer<typeof sandboxResult>;

export const capabilityDescriptor = z.object({
  id: z.string().min(1),
  description: z.string(),
  effect: z.enum(["read", "write"]),
  requiresApproval: z.boolean(),
  inputSchema: jsonValue,
  outputSchema: jsonValue,
  example: z.string().optional(),
});
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptor>;

export const capabilitySearchHit = z.object({
  id: z.string().min(1),
  summary: z.string(),
  declaration: z.string().min(1),
  example: z.string().optional(),
});
export type CapabilitySearchHit = z.infer<typeof capabilitySearchHit>;
