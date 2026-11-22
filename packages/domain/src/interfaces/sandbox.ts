import type { SandboxRequest, SandboxResult } from "../schemas/execution";

export interface Sandbox {
  execute(request: SandboxRequest): Promise<SandboxResult>;
}
