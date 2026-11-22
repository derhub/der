import {
  formatUtcTimestamp,
  type ChannelBinding,
  type ChannelUpdate,
  type DeliveryResult,
  type Messaging,
  type OutboxEvent,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { formatOutboxMessage, normalizeTelegramUpdate } from "./codec";
import { redactTelegramSecret } from "./redaction";
import {
  TelegramApiError,
  TelegramConfigError,
  telegramParsers,
  type TelegramBotApiResponse,
} from "./schemas";

const DEFAULT_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_POLL_LIMIT = 100;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export type TelegramFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramMessagingOptions {
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly pollTimeoutSeconds?: number;
  readonly pollLimit?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: TelegramFetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface TelegramMessaging extends Messaging {
  acknowledgeCallback(
    callbackQueryId: string,
    options?: { readonly text?: string; readonly showAlert?: boolean },
  ): Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseInitialOffset(cursor: string | undefined): number | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(cursor)) {
    throw new TelegramConfigError(
      "telegram.invalid_cursor",
      `Telegram cursor "${cursor}" must be a non-negative integer update ID.`,
    );
  }
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed >= Number.MAX_SAFE_INTEGER) {
    throw new TelegramConfigError(
      "telegram.invalid_cursor",
      `Telegram cursor "${cursor}" exceeds safe integer bounds.`,
    );
  }
  return parsed + 1;
}

function buildRequestSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (externalSignal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([externalSignal, timeoutSignal]);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

interface ParsedApiCall {
  readonly status: number;
  readonly payload?: TelegramBotApiResponse;
  readonly parseError?: string;
}

export function createTelegramMessaging(options: TelegramMessagingOptions): TelegramMessaging {
  const botToken = options.botToken.trim();
  if (botToken.length === 0) {
    throw new TelegramConfigError("telegram.missing_token", "Telegram botToken must be non-empty.");
  }

  const rawBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    throw new TelegramConfigError(
      "telegram.invalid_base_url",
      `Telegram apiBaseUrl "${rawBaseUrl}" is not a valid URL.`,
    );
  }
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new TelegramConfigError(
      "telegram.invalid_base_url",
      `Telegram apiBaseUrl "${rawBaseUrl}" must use http or https.`,
    );
  }

  const pollTimeoutSeconds = options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
  if (!Number.isInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 0 || pollTimeoutSeconds > 50) {
    throw new TelegramConfigError(
      "telegram.invalid_poll_timeout",
      `Telegram pollTimeoutSeconds must be an integer between 0 and 50, received ${pollTimeoutSeconds}.`,
    );
  }

  const pollLimit = options.pollLimit ?? DEFAULT_POLL_LIMIT;
  if (!Number.isInteger(pollLimit) || pollLimit < 1 || pollLimit > 100) {
    throw new TelegramConfigError(
      "telegram.invalid_poll_limit",
      `Telegram pollLimit must be an integer between 1 and 100, received ${pollLimit}.`,
    );
  }

  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sendTimeoutMs = options.requestTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const pollRequestTimeoutMs = Math.max(sendTimeoutMs, (pollTimeoutSeconds + 10) * 1_000);
  const fetchFn: TelegramFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleepFn = options.sleep ?? abortableSleep;
  const nowFn = options.now ?? (() => new Date());
  const externalSignal = options.signal;

  const redact = (text: string) => redactTelegramSecret(text, botToken);

  async function callBotApi(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ParsedApiCall> {
    const endpoint = `${rawBaseUrl}/bot${botToken}/${method}`;
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: buildRequestSignal(timeoutMs, signal),
    });

    const rawText = await response.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawText);
    } catch {
      return {
        status: response.status,
        parseError: redact(
          `Telegram ${method} returned non-JSON body (HTTP ${response.status}): ${rawText.slice(0, 200)}`,
        ),
      };
    }

    const validated = telegramParsers.apiResponse.safeParse(decoded);
    if (!validated.success) {
      return {
        status: response.status,
        parseError: redact(
          `Telegram ${method} returned invalid envelope (HTTP ${response.status}): ${validated.error.message}`,
        ),
      };
    }

    return {
      status: response.status,
      payload: validated.data,
    };
  }

  function computeBackoff(consecutiveFailures: number, retryAfterMs?: number): number {
    const exponent = Math.max(0, consecutiveFailures - 1);
    const exponential = Math.min(maxBackoffMs, initialBackoffMs * 2 ** exponent);
    if (retryAfterMs !== undefined) {
      return Math.max(retryAfterMs, exponential);
    }
    return exponential;
  }

  return {
    async *poll(cursor: string | undefined): AsyncIterable<ChannelUpdate> {
      let nextOffset = parseInitialOffset(cursor);
      let consecutiveFailures = 0;

      while (!externalSignal?.aborted) {
        let callResult: ParsedApiCall;
        try {
          const requestBody: Record<string, unknown> = {
            timeout: pollTimeoutSeconds,
            limit: pollLimit,
            allowed_updates: ["message", "callback_query"],
          };
          if (nextOffset !== undefined) {
            requestBody["offset"] = nextOffset;
          }

          callResult = await callBotApi(
            "getUpdates",
            requestBody,
            pollRequestTimeoutMs,
            externalSignal,
          );
        } catch {
          if (externalSignal?.aborted) {
            break;
          }
          consecutiveFailures += 1;
          await sleepFn(computeBackoff(consecutiveFailures), externalSignal);
          continue;
        }

        if (callResult.parseError !== undefined || callResult.payload === undefined) {
          consecutiveFailures += 1;
          await sleepFn(computeBackoff(consecutiveFailures), externalSignal);
          continue;
        }

        const { payload, status } = callResult;
        if (!payload.ok) {
          const errorStatus = payload.error_code ?? status;
          const retryAfterSeconds = payload.parameters?.retry_after;
          const retryAfterMs =
            retryAfterSeconds !== undefined ? retryAfterSeconds * 1_000 : undefined;
          const description = redact(
            payload.description ?? `Telegram getUpdates failed with HTTP ${errorStatus}.`,
          );

          if (errorStatus === 401 || errorStatus === 403) {
            throw new TelegramApiError("telegram.unauthorized", errorStatus, description);
          }

          consecutiveFailures += 1;
          await sleepFn(computeBackoff(consecutiveFailures, retryAfterMs), externalSignal);
          continue;
        }

        const parsedUpdates = telegramParsers.updates.safeParse(payload.result);
        if (!parsedUpdates.success) {
          consecutiveFailures += 1;
          await sleepFn(computeBackoff(consecutiveFailures), externalSignal);
          continue;
        }

        consecutiveFailures = 0;
        const ordered = [...parsedUpdates.data].sort(
          (left, right) => left.update_id - right.update_id,
        );

        for (const rawUpdate of ordered) {
          if (externalSignal?.aborted) {
            return;
          }
          if (nextOffset !== undefined && rawUpdate.update_id < nextOffset) {
            continue;
          }

          const normalized = normalizeTelegramUpdate(rawUpdate, nowFn);
          if (normalized !== undefined) {
            yield normalized;
          }
          nextOffset = rawUpdate.update_id + 1;
        }
      }
    },

    async deliver(binding: ChannelBinding, event: OutboxEvent): Promise<DeliveryResult> {
      const validBinding = compiledParsers.channelBinding.parse(binding);
      const validEvent = compiledParsers.outboxEvent.parse(event);

      if (validBinding.integration !== "telegram") {
        return compiledParsers.deliveryResult.parse({
          status: "terminal_failure",
          code: "telegram.binding_mismatch",
          detail: `Binding ${validBinding.id} targets "${validBinding.integration}", not "telegram".`,
        });
      }

      let formatted;
      try {
        formatted = formatOutboxMessage(validEvent, { botToken });
      } catch (error) {
        return compiledParsers.deliveryResult.parse({
          status: "terminal_failure",
          code: error instanceof TelegramConfigError ? error.code : "telegram.invalid_outbox_event",
          detail: redact(error instanceof Error ? error.message : String(error)),
        });
      }

      const requestBody: Record<string, unknown> = {
        chat_id: validBinding.externalChatId,
        text: formatted.text,
      };
      if (formatted.replyMarkup !== undefined) {
        requestBody["reply_markup"] = formatted.replyMarkup;
      }

      // A lost response after Telegram accepts sendMessage yields a retryable result and can
      // produce a duplicate Telegram message on retry while preserving the stable outbox eventId.
      let callResult: ParsedApiCall;
      try {
        callResult = await callBotApi("sendMessage", requestBody, sendTimeoutMs);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        return compiledParsers.deliveryResult.parse({
          status: "retryable",
          detail: `Telegram sendMessage network or timeout failure (delivery outcome ambiguous): ${message}`,
        });
      }

      if (callResult.parseError !== undefined || callResult.payload === undefined) {
        return compiledParsers.deliveryResult.parse({
          status: "retryable",
          detail: callResult.parseError ?? "Telegram sendMessage returned an unreadable response.",
        });
      }

      const { payload, status } = callResult;
      if (payload.ok) {
        const parsedResult = telegramParsers.sendMessageResult.safeParse(payload.result);
        if (!parsedResult.success) {
          return compiledParsers.deliveryResult.parse({
            status: "retryable",
            detail: redact(
              `Telegram sendMessage returned unexpected result payload: ${parsedResult.error.message}`,
            ),
          });
        }
        return compiledParsers.deliveryResult.parse({
          status: "delivered",
          externalMessageId: String(parsedResult.data.message_id),
          deliveredAt: formatUtcTimestamp(nowFn()),
        });
      }

      const errorStatus = payload.error_code ?? status;
      const detail = redact(
        payload.description ?? `Telegram sendMessage failed with HTTP ${errorStatus}.`,
      );
      if (isRetryableHttpStatus(errorStatus)) {
        const retryAfterSeconds = payload.parameters?.retry_after;
        return compiledParsers.deliveryResult.parse({
          status: "retryable",
          ...(retryAfterSeconds !== undefined ? { retryAfterMs: retryAfterSeconds * 1_000 } : {}),
          detail,
        });
      }

      return compiledParsers.deliveryResult.parse({
        status: "terminal_failure",
        code: `telegram.http_${errorStatus}`,
        detail,
      });
    },

    async acknowledgeCallback(
      callbackQueryId: string,
      ackOptions?: { readonly text?: string; readonly showAlert?: boolean },
    ): Promise<void> {
      const requestBody: Record<string, unknown> = {
        callback_query_id: callbackQueryId,
      };
      if (ackOptions?.text !== undefined) {
        requestBody["text"] = redact(ackOptions.text).slice(0, 200);
      }
      if (ackOptions?.showAlert !== undefined) {
        requestBody["show_alert"] = ackOptions.showAlert;
      }

      let callResult: ParsedApiCall;
      try {
        callResult = await callBotApi("answerCallbackQuery", requestBody, sendTimeoutMs);
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        throw new TelegramApiError(
          "telegram.network_error",
          0,
          `Telegram answerCallbackQuery failed: ${message}`,
        );
      }

      if (callResult.parseError !== undefined || callResult.payload === undefined) {
        throw new TelegramApiError(
          "telegram.invalid_response",
          callResult.status,
          callResult.parseError ?? "Telegram answerCallbackQuery returned invalid payload.",
        );
      }

      if (!callResult.payload.ok) {
        const errorStatus = callResult.payload.error_code ?? callResult.status;
        const retryAfterSeconds = callResult.payload.parameters?.retry_after;
        throw new TelegramApiError(
          `telegram.http_${errorStatus}`,
          errorStatus,
          redact(
            callResult.payload.description ??
              `Telegram answerCallbackQuery failed with HTTP ${errorStatus}.`,
          ),
          ...(retryAfterSeconds !== undefined ? [{ retryAfterMs: retryAfterSeconds * 1_000 }] : []),
        );
      }
    },
  };
}
