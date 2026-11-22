import type { JsonValue } from "@der/domain";

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]"],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [
    /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|password|cookie|authorization)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  ],
  [/\/(?:home\/(?!engine(?:\/|$|[\s:'"]))|Users\/)[^/\s:'"]+/g, "<host-home>"],
  [/(^|[\s:'"])\/root(?=\/|$|[\s:'"])/g, "$1<host-home>"],
];

export function redactDiagnostics(input: string): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function normalizeToJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeToJsonValue(item));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const sorted: Record<string, JsonValue> = {};
    for (const [key, member] of entries) {
      sorted[key] = normalizeToJsonValue(member);
    }
    return sorted;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.description ?? "symbol";
  }
  return "[function]";
}

const encoder = new TextEncoder();

export async function digestJson(value: JsonValue): Promise<string> {
  const canonical = JSON.stringify(normalizeToJsonValue(value));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16);
}
