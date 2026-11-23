import * as z from "zod";
import {
  defineCapability,
  engineKind,
  id,
  routine,
  utcTimestamp,
  type BotStore,
  type RoutineTarget,
  type SessionStore,
} from "@der/domain";
import type { HttpRoutinePort } from "../http/index";
import type { RoutineScheduleClient } from "../workflows/index";
import { callerBotId, notFound } from "./scope";

export interface RoutineCapabilityDeps {
  readonly bots: Pick<BotStore, "getBot">;
  readonly sessions: Pick<SessionStore, "getSession">;
  readonly routines: HttpRoutinePort;
  readonly routineSchedule: Pick<RoutineScheduleClient, "configure">;
}

const configured = z.object({ routine, nextSlot: utcTimestamp.nullable() });

const routineFields = {
  id: id.optional(),
  sessionId: id,
  name: z.string().min(1),
  cron: z.string().min(1),
  enabled: z.boolean().default(true),
};

export function routineCapabilities(deps: RoutineCapabilityDeps) {
  return [
    defineCapability({
      id: "routines.list",
      description: "List this bot's routines.",
      input: z.strictObject({}),
      output: z.object({ routines: z.array(routine) }),
      effect: "read",
      approval: "none",
      example: "await der.routines.list({})",
      async execute(_input, ctx) {
        const botId = callerBotId(ctx, "routines.list");
        return { routines: [...(await deps.routines.listRoutines(botId))] };
      },
    }),
    defineCapability({
      id: "routines.create",
      description:
        "Create a scheduled routine for one of this bot's sessions. The cron is evaluated in UTC. Pass `prompt` to run a model turn, or `script` to run a Script with no model; a script routine asks for Approval on every gated write on every firing.",
      input: z.union([
        z.strictObject({
          ...routineFields,
          engine: engineKind.optional(),
          prompt: z.string().min(1),
        }),
        z.strictObject({ ...routineFields, script: z.string().min(1) }),
      ]),
      output: configured,
      effect: "write",
      approval: "always",
      example:
        'await der.routines.create({ sessionId: "sess-1", name: "Daily", cron: "0 9 * * *", script: "return await der.routines.list({})" })',
      async execute(input, ctx) {
        const botId = callerBotId(ctx, "routines.create");
        const bot = await deps.bots.getBot(botId);
        if (!bot) {
          throw notFound("bot", "bot.not_found", `Bot ${botId} does not exist.`, "routines.create");
        }
        const session = await deps.sessions.getSession(input.sessionId);
        if (!session || session.botId !== botId) {
          throw notFound(
            "session",
            "session.not_found",
            `Session ${input.sessionId} does not belong to bot ${botId}.`,
            "routines.create",
          );
        }
        const target: RoutineTarget =
          "script" in input
            ? { engine: "script", script: input.script }
            : {
                engine: input.engine ?? session.engine ?? bot.defaultEngine,
                prompt: input.prompt,
              };
        return deps.routineSchedule.configure(input.id ?? `rt_${crypto.randomUUID()}`, {
          kind: "create",
          botId,
          sessionId: input.sessionId,
          name: input.name,
          cron: input.cron,
          enabled: input.enabled,
          ...target,
        });
      },
    }),
    defineCapability({
      id: "routines.update",
      description:
        "Update one of this bot's routines. Pass expectedRevision to guard against concurrent edits.",
      input: z.strictObject({
        routineId: id,
        name: z.string().min(1).optional(),
        cron: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        engine: engineKind.optional(),
        prompt: z.string().min(1).optional(),
        script: z.string().min(1).optional(),
        expectedRevision: z.number().int().positive().optional(),
      }),
      output: configured,
      effect: "write",
      approval: "always",
      example: 'await der.routines.update({ routineId: "rt-1", enabled: false })',
      async execute(input, ctx) {
        const { routineId } = input;
        const botId = callerBotId(ctx, "routines.update");
        const existing = await deps.routines.getRoutine(routineId);
        if (!existing || existing.botId !== botId) {
          throw notFound(
            "routine",
            "routine.not_found",
            `Routine ${routineId} does not belong to bot ${botId}.`,
            "routines.update",
          );
        }
        return deps.routineSchedule.configure(routineId, {
          kind: "update",
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.cron !== undefined ? { cron: input.cron } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.script !== undefined ? { script: input.script } : {}),
          ...(input.expectedRevision !== undefined
            ? { expectedRevision: input.expectedRevision }
            : {}),
        });
      },
    }),
  ];
}
