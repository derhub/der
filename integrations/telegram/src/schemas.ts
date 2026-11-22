import * as z from "zod";
import { compileSchema } from "@der/domain/compiled";

export class TelegramConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TelegramConfigError";
    this.code = code;
  }
}

export class TelegramApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(
    code: string,
    status: number,
    message: string,
    options?: { readonly retryAfterMs?: number },
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.code = code;
    this.status = status;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

const telegramOpaqueId = z.union([z.number().int(), z.string().min(1)]);

const telegramUserSchema = z.object({
  id: telegramOpaqueId,
  is_bot: z.boolean().optional(),
  username: z.string().optional(),
});

const telegramChatSchema = z.object({
  id: telegramOpaqueId,
  type: z.string().optional(),
});

export const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().optional(),
  chat: telegramChatSchema,
  from: telegramUserSchema.optional(),
  text: z.string().optional(),
});
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

const telegramCallbackMessageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int().optional(),
  chat: telegramChatSchema,
});

export const telegramCallbackQuerySchema = z.object({
  id: z.string().min(1),
  from: telegramUserSchema,
  message: telegramCallbackMessageSchema.optional(),
  data: z.string().optional(),
});
export type TelegramCallbackQuery = z.infer<typeof telegramCallbackQuerySchema>;

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export const telegramBotApiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().int().optional(),
  description: z.string().optional(),
  parameters: z
    .object({
      retry_after: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type TelegramBotApiResponse = z.infer<typeof telegramBotApiResponseSchema>;

export const telegramSendMessageResultSchema = z.object({
  message_id: telegramOpaqueId,
});

export const telegramParsers = {
  apiResponse: compileSchema(telegramBotApiResponseSchema),
  updates: compileSchema(z.array(telegramUpdateSchema)),
  update: compileSchema(telegramUpdateSchema),
  sendMessageResult: compileSchema(telegramSendMessageResultSchema),
} as const;
