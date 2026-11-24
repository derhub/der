import { createHash } from "node:crypto";
import type { EngineSession, Message } from "@der/domain";

export type TurnPlan =
  | {
      readonly mode: "resume";
      readonly vendorSessionId: string;
      readonly contextNote: string | null;
    }
  | {
      readonly mode: "rebuild";
      readonly reason: "none" | "pending" | "base-changed" | "gap" | "not-resumable";
    };

export interface PlanTurnInput {
  readonly engineResumable: boolean;
  readonly stored: EngineSession | null;
  readonly baseHash: string;
  readonly contextHash: string;
  /** Capped memory and skill catalog text; "" when both are empty. */
  readonly contextBlock: string;
  readonly messagesAfterLastOrdinal: readonly Message[];
  /** The session's most recent earlier Run used a different engine than this Run. */
  readonly previousRunOnOtherEngine: boolean;
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
  if (!input.engineResumable) {
    return { mode: "rebuild", reason: "not-resumable" };
  }
  const stored = input.stored;
  if (stored === null) {
    return { mode: "rebuild", reason: "none" };
  }
  // A pending mark means some Run's delivery to this vendor session is uncertain, whether this
  // Run replayed or an earlier one failed after the vendor may have accepted its prompt.
  if (stored.pendingRunId !== null) {
    return { mode: "rebuild", reason: "pending" };
  }
  if (stored.baseHash !== input.baseHash) {
    return { mode: "rebuild", reason: "base-changed" };
  }
  const newMessages = input.messagesAfterLastOrdinal;
  if (
    input.previousRunOnOtherEngine ||
    newMessages.length === 0 ||
    !newMessages.every(isUserText)
  ) {
    return { mode: "rebuild", reason: "gap" };
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

/** `buildRunContext`'s base hash does not cover the engine model; a model change must rebuild. */
export function baseHashWithModel(baseHash: string, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify([baseHash, model]))
    .digest("hex");
}
