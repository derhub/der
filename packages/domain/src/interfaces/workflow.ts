import type { Approval, ApprovalResolutionInput } from "../schemas/approval";
import type { RunAdmission, RunRequest } from "../schemas/run";

export interface Workflow {
  admit(request: RunRequest): Promise<RunAdmission>;
  decide(decision: ApprovalResolutionInput): Promise<Approval>;
}
