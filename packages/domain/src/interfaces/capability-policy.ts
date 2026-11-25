import type { CapabilityPolicy, PolicyDecision } from "../schemas/bot";

function matchingRule(policy: CapabilityPolicy, id: string): PolicyDecision | undefined {
  if (Object.hasOwn(policy, id)) {
    return policy[id];
  }
  const segments = id.split(".");
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const namespace = segments.slice(0, length).join(".");
    if (Object.hasOwn(policy, namespace)) {
      return policy[namespace];
    }
  }
  return undefined;
}

/**
 * The most specific policy key wins: the exact id, then the longest namespace on a dot
 * boundary, then the capability's own declaration. A read is never asked about.
 */
export function resolvePolicy(
  policy: CapabilityPolicy,
  id: string,
  effect: "read" | "write",
  declaredAsks: boolean,
): PolicyDecision {
  const decision = matchingRule(policy, id) ?? (declaredAsks ? "ask" : "allow");
  return effect === "read" && decision === "ask" ? "allow" : decision;
}
