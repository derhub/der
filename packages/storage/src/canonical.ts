import type { JsonValue } from "@der/domain";

const encoder = new TextEncoder();

export function canonicalizeJson(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("canonical JSON numbers must be finite");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const member = value[key];
    if (member !== undefined) {
      entries.push(`${JSON.stringify(key)}:${canonicalizeJson(member)}`);
    }
  }
  return `{${entries.join(",")}}`;
}

export async function fingerprintJson(value: JsonValue): Promise<string> {
  const canonical = canonicalizeJson(value);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `sha256:${hex}`;
}
