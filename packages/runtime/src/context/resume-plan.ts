import type { EngineSession, Message } from "@der/domain";

export type TurnPlan =
  | {
      readonly mode: "resume";
      readonly vendorSessionId: string;
      readonly contextNote: string | null;
    }
  | { readonly mode: "rebuild" };

export interface PlanTurnInput {
  /** The engine session this Run took; null when there was none or the engine cannot resume. */
  readonly stored: EngineSession | null;
  readonly baseHash: string;
  readonly contextHash: string;
  /** Capped memory and skill catalog text; "" when both are empty. */
  readonly contextBlock: string;
  readonly messagesAfterLastOrdinal: readonly Message[];
}

function isUserText(message: Message): boolean {
  return (
    message.role === "user" &&
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === "text")
  );
}

function contextNoteFor(contextBlock: string): string {
  return contextBlock.length > 0
    ? `[Context update: memory and skills changed since your last turn]\n${contextBlock}`
    : "[Context update: memory and skills are now empty]";
}

export function planTurn(input: PlanTurnInput): TurnPlan {
  const stored = input.stored;
  const newMessages = input.messagesAfterLastOrdinal;
  if (
    stored === null ||
    stored.baseHash !== input.baseHash ||
    newMessages.length === 0 ||
    !newMessages.every(isUserText)
  ) {
    return { mode: "rebuild" };
  }
  return {
    mode: "resume",
    vendorSessionId: stored.vendorSessionId,
    contextNote:
      stored.contextHash === input.contextHash ? null : contextNoteFor(input.contextBlock),
  };
}

/** The single user message a resumed turn sends: the context note, then the new user text in order. */
export function composeResumeText(
  contextNote: string | null,
  newMessages: readonly Message[],
): string {
  const texts = newMessages.map((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  );
  return [...(contextNote !== null ? [contextNote] : []), ...texts].join("\n\n");
}
