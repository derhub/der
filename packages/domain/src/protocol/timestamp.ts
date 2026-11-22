import * as z from "zod";

const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const utcTimestamp = z.iso
  .datetime()
  .regex(RFC3339_UTC_PATTERN, "timestamp must be RFC 3339 UTC with Z designator");

export type UtcTimestamp = z.infer<typeof utcTimestamp>;

export function formatUtcTimestamp(date: Date): UtcTimestamp {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("timestamp must be a valid Date");
  }
  return utcTimestamp.parse(date.toISOString());
}
