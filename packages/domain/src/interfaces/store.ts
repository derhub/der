import type { Approval, ApprovalResolutionInput } from "../schemas/approval";
import type { RunId } from "../schemas/common";
import type { RunAdmission, RunEvent, RunRequest } from "../schemas/run";

export interface Store {
  admit(request: RunRequest): Promise<RunAdmission>;
  decide(decision: ApprovalResolutionInput): Promise<Approval>;
  replay(runId: RunId, after: number): AsyncIterable<RunEvent>;
}
