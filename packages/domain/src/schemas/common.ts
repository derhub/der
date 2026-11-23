import * as z from "zod";

export const id = z.string().min(1);

export type BotId = string;
export type SessionId = string;
export type MessageId = string;
export type RunId = string;
export type ApprovalId = string;
export type RoutineId = string;
export type MemoryId = string;
export type SkillId = string;
export type ChannelBindingId = string;
export type OutboxEventId = string;
export type EffectId = string;

export const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;

export const engineKind = z.enum(["codex", "claude-code", "antigravity", "fixture"]);
export type EngineKind = z.infer<typeof engineKind>;

export const runEngineKind = z.enum([...engineKind.options, "script"]);
export type RunEngineKind = z.infer<typeof runEngineKind>;
