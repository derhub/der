const TELEGRAM_BOT_URL_TOKEN_PATTERN = /\bbot\d{5,}:[A-Za-z0-9_-]{20,}\b/g;
const TELEGRAM_RAW_TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;

export function redactTelegramSecret(input: string, token?: string): string {
  let sanitized = input;
  const trimmed = token?.trim();
  if (trimmed && trimmed.length > 0) {
    sanitized = sanitized.replaceAll(`bot${trimmed}`, "bot[REDACTED]");
    sanitized = sanitized.replaceAll(trimmed, "[REDACTED]");
  }
  sanitized = sanitized.replace(TELEGRAM_BOT_URL_TOKEN_PATTERN, "bot[REDACTED]");
  sanitized = sanitized.replace(TELEGRAM_RAW_TOKEN_PATTERN, "[REDACTED]");
  return sanitized;
}
