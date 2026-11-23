import * as z from "zod";
import { defineCapability, id, message, session, type SessionStore } from "@der/domain";
import { callerBotId, notFound } from "./scope";

export function sessionCapabilities(
  sessions: Pick<SessionStore, "listSessions" | "getSession" | "listMessages">,
) {
  return [
    defineCapability({
      id: "sessions.list",
      description: "List this bot's sessions.",
      input: z.strictObject({}),
      output: z.object({ sessions: z.array(session) }),
      effect: "read",
      approval: "none",
      example: "await der.sessions.list({})",
      async execute(_input, ctx) {
        const botId = callerBotId(ctx, "sessions.list");
        return { sessions: [...(await sessions.listSessions(botId))] };
      },
    }),
    defineCapability({
      id: "sessions.messages",
      description: "List messages of one of this bot's sessions, optionally after an ordinal.",
      input: z.strictObject({
        sessionId: id,
        limit: z.number().int().min(1).max(200).optional(),
        afterOrdinal: z.number().int().nonnegative().optional(),
      }),
      output: z.object({ messages: z.array(message) }),
      effect: "read",
      approval: "none",
      example: 'await der.sessions.messages({ sessionId: "sess-1", limit: 20 })',
      async execute(input, ctx) {
        const botId = callerBotId(ctx, "sessions.messages");
        const found = await sessions.getSession(input.sessionId);
        if (!found || found.botId !== botId) {
          throw notFound(
            "session",
            "session.not_found",
            `Session ${input.sessionId} does not belong to bot ${botId}.`,
            "sessions.messages",
          );
        }
        const messages = await sessions.listMessages(input.sessionId, {
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.afterOrdinal !== undefined ? { afterOrdinal: input.afterOrdinal } : {}),
        });
        return { messages: [...messages] };
      },
    }),
  ];
}
