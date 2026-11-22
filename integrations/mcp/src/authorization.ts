import type { EffectIdentity, JsonValue, ToolResult } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";

export type ApprovalVerifier = (effect: EffectIdentity) => Promise<boolean> | boolean;

function canonicalizeValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const member = value[key];
    if (member !== undefined) {
      entries.push(`${JSON.stringify(key)}:${canonicalizeValue(member)}`);
    }
  }
  return `{${entries.join(",")}}`;
}

export function effectIdentityMatches(a: EffectIdentity, b: EffectIdentity): boolean {
  return (
    a.runId === b.runId &&
    a.operationKind === b.operationKind &&
    a.operationId === b.operationId &&
    a.attemptId === b.attemptId &&
    canonicalizeValue(a.canonicalArguments) === canonicalizeValue(b.canonicalArguments)
  );
}

export function createExactApprovalVerifier(
  approvedEffects: readonly EffectIdentity[],
): ApprovalVerifier {
  return (effect) => approvedEffects.some((candidate) => effectIdentityMatches(candidate, effect));
}

export function deniedToolResult(
  code: "tool.unrecognized_operation" | "tool.approval_required" | "tool.invalid_arguments",
  detail: string,
): ToolResult {
  return compiledParsers.toolResult.parse({
    ok: false,
    isError: true,
    outcome: {
      denied: true,
      code,
    },
    detail,
  });
}
