import { DomainError, type BotId, type CapabilityContext } from "@der/domain";

export function callerBotId(ctx: CapabilityContext, capabilityId: string): BotId {
  if (ctx.botId === undefined) {
    throw new DomainError({
      type: "https://der.invalid/problems/capability-bot-scope-missing",
      title: "Capability called without a bot",
      status: 403,
      detail: `Capability "${capabilityId}" is scoped to a bot and the call carries none.`,
      instance: `/integrations/capabilities/${capabilityId}`,
      code: "capability.bot_scope_missing",
    });
  }
  return ctx.botId;
}

export function notFound(
  kind: string,
  code: string,
  detail: string,
  capabilityId: string,
): DomainError {
  return new DomainError({
    type: `https://der.invalid/problems/${kind}-not-found`,
    title: `${kind[0]?.toUpperCase()}${kind.slice(1)} not found`,
    status: 404,
    detail,
    instance: `/integrations/capabilities/${capabilityId}`,
    code,
  });
}
