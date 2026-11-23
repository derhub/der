import type { Capability, Sandbox, SessionStore } from "@der/domain";
import type { SkillCatalog } from "@der/runtime/context";
import type { HttpMemoryPort } from "../http/index";
import { memoryCapabilities } from "./memory";
import { routineCapabilities, type RoutineCapabilityDeps } from "./routines";
import { sandboxCapability } from "./sandbox";
import { sessionCapabilities } from "./sessions";
import { skillCapabilities } from "./skills";

export interface HostCapabilityDeps extends RoutineCapabilityDeps {
  readonly memory: HttpMemoryPort;
  readonly sessions: Pick<SessionStore, "listSessions" | "getSession" | "listMessages">;
  readonly skills: SkillCatalog;
  readonly sandboxes: { readonly docker?: Sandbox; readonly wasmer?: Sandbox };
}

export function createHostCapabilities(deps: HostCapabilityDeps): Capability[] {
  const capabilities = [
    ...memoryCapabilities(deps.memory),
    ...routineCapabilities(deps),
    ...sessionCapabilities(deps.sessions),
    ...skillCapabilities(deps.skills),
  ] as Capability[];
  for (const kind of ["docker", "wasmer"] as const) {
    const sandbox = deps.sandboxes[kind];
    if (sandbox) {
      capabilities.push(sandboxCapability(kind, sandbox) as Capability);
    }
  }
  return capabilities;
}
