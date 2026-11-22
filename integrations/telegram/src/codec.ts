import {
  CLOUD_EVENT_TYPES,
  formatUtcTimestamp,
  type ChannelUpdate,
  type MessagePart,
  type OutboxEvent,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { redactTelegramSecret } from "./redaction";
import { TelegramConfigError, telegramParsers, type TelegramUpdate } from "./schemas";

export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const TRUNCATION_SUFFIX = "... [truncated]";
const CALLBACK_APPROVE_PREFIX = "der:a:";
const CALLBACK_DENY_PREFIX = "der:d:";
const encoder = new TextEncoder();

export interface TelegramOutboundMessage {
  readonly text: string;
  readonly replyMarkup?: {
    readonly inline_keyboard: readonly (readonly {
      readonly text: string;
      readonly callback_data: string;
    }[])[];
  };
}

export function encodeApprovalCallbackData(
  approvalId: string,
  decision: "approved" | "denied",
): string {
  const trimmed = approvalId.trim();
  if (trimmed.length === 0 || /[\s\p{Cc}]/u.test(trimmed)) {
    throw new TelegramConfigError(
      "telegram.invalid_callback_data",
      `Approval ID "${approvalId}" cannot be encoded into Telegram callback_data.`,
    );
  }
  const encoded = `${decision === "approved" ? CALLBACK_APPROVE_PREFIX : CALLBACK_DENY_PREFIX}${trimmed}`;
  const bytes = encoder.encode(encoded).byteLength;
  if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new TelegramConfigError(
      "telegram.callback_data_too_long",
      `Encoded callback_data for approval "${trimmed}" is ${bytes} bytes, exceeding Telegram's ${TELEGRAM_CALLBACK_DATA_MAX_BYTES}-byte limit.`,
    );
  }
  return encoded;
}

export function parseApprovalCallbackData(
  raw: string,
): { readonly approvalId: string; readonly decision: "approved" | "denied" } | undefined {
  if (raw.startsWith(CALLBACK_APPROVE_PREFIX)) {
    const approvalId = raw.slice(CALLBACK_APPROVE_PREFIX.length);
    if (approvalId.length > 0 && !/[\s\p{Cc}]/u.test(approvalId)) {
      return { approvalId, decision: "approved" };
    }
    return undefined;
  }
  if (raw.startsWith(CALLBACK_DENY_PREFIX)) {
    const approvalId = raw.slice(CALLBACK_DENY_PREFIX.length);
    if (approvalId.length > 0 && !/[\s\p{Cc}]/u.test(approvalId)) {
      return { approvalId, decision: "denied" };
    }
    return undefined;
  }
  return undefined;
}

function toUtcTimestamp(unixSeconds: number | undefined, now: () => Date): string {
  if (unixSeconds !== undefined && Number.isFinite(unixSeconds) && unixSeconds > 0) {
    const parsed = new Date(unixSeconds * 1000);
    if (!Number.isNaN(parsed.getTime())) {
      return formatUtcTimestamp(parsed);
    }
  }
  return formatUtcTimestamp(now());
}

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  now: () => Date = () => new Date(),
): ChannelUpdate | undefined {
  const validated = telegramParsers.update.parse(update);

  if (validated.callback_query !== undefined) {
    const callback = validated.callback_query;
    if (callback.from.is_bot === true) {
      return undefined;
    }
    if (callback.message === undefined || callback.data === undefined) {
      return undefined;
    }
    const parsedDecision = parseApprovalCallbackData(callback.data);
    if (parsedDecision === undefined) {
      return undefined;
    }
    return compiledParsers.channelUpdate.parse({
      integration: "telegram",
      externalUpdateId: String(validated.update_id),
      externalChatId: String(callback.message.chat.id),
      externalActorId: String(callback.from.id),
      receivedAt: toUtcTimestamp(callback.message.date, now),
      payload: {
        kind: "approval_decision",
        approvalId: parsedDecision.approvalId,
        decision: parsedDecision.decision,
        callbackQueryId: callback.id,
      },
    });
  }

  if (validated.message !== undefined) {
    const msg = validated.message;
    if (msg.from === undefined || msg.from.is_bot === true) {
      return undefined;
    }
    const text = msg.text?.trim() ?? "";
    if (text.length === 0) {
      return undefined;
    }
    return compiledParsers.channelUpdate.parse({
      integration: "telegram",
      externalUpdateId: String(validated.update_id),
      externalChatId: String(msg.chat.id),
      externalActorId: String(msg.from.id),
      receivedAt: toUtcTimestamp(msg.date, now),
      payload: {
        kind: "message",
        text,
      },
    });
  }

  return undefined;
}

function truncateTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_MAX_LENGTH) {
    return text;
  }
  const keepLength = TELEGRAM_MESSAGE_MAX_LENGTH - TRUNCATION_SUFFIX.length;
  return `${text.slice(0, keepLength)}${TRUNCATION_SUFFIX}`;
}

function renderMessageParts(parts: readonly MessagePart[]): string {
  const textSegments: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text.trim().length > 0) {
      textSegments.push(part.text);
    }
  }
  if (textSegments.length > 0) {
    return textSegments.join("\n");
  }

  const fallbackSegments: string[] = [];
  for (const part of parts) {
    if (part.type === "tool-result") {
      fallbackSegments.push(
        `[${part.toolName}] ${part.isError ? "error" : "ok"}: ${JSON.stringify(part.outcome)}`,
      );
    }
  }
  return fallbackSegments.length > 0 ? fallbackSegments.join("\n") : "(empty reply)";
}

export function formatOutboxMessage(
  event: OutboxEvent,
  options?: { readonly botToken?: string },
): TelegramOutboundMessage {
  const validated = compiledParsers.outboxEvent.parse(event);
  const envelope = validated.envelope;
  const sanitize = (raw: string) =>
    truncateTelegramText(redactTelegramSecret(raw, options?.botToken));

  if (envelope.type === CLOUD_EVENT_TYPES.chatReplied) {
    const text = renderMessageParts(envelope.data.message.parts);
    return {
      text: sanitize(text),
    };
  }

  if (envelope.type === CLOUD_EVENT_TYPES.approvalRequested) {
    const data = envelope.data;
    const lines = [
      "Approval required",
      `Operation: ${data.operationKind}:${data.operationId}`,
      data.prompt,
      `Deadline: ${data.deadline}`,
      `Approval ID: ${data.approvalId}`,
    ];
    return {
      text: sanitize(lines.join("\n")),
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "Approve",
              callback_data: encodeApprovalCallbackData(data.approvalId, "approved"),
            },
            {
              text: "Deny",
              callback_data: encodeApprovalCallbackData(data.approvalId, "denied"),
            },
          ],
        ],
      },
    };
  }

  const data = envelope.data;
  const lines = [
    `Routine finished: ${data.outcome}`,
    `Routine: ${data.routineId}`,
    `Run: ${data.runId}`,
    `Slot: ${data.slot}`,
    `Finished: ${data.finishedAt}`,
    ...(data.detail !== undefined ? [`Detail: ${data.detail}`] : []),
  ];
  return {
    text: sanitize(lines.join("\n")),
  };
}
