import type { Approval, ApprovalResolutionInput } from "../schemas/approval";
import type { ApprovalId, RunId } from "../schemas/common";
import type { RunAdmission, RunRequest } from "../schemas/run";

export interface Workflow {
  admit(request: RunRequest): Promise<RunAdmission>;
  decide(decision: ApprovalResolutionInput): Promise<Approval>;
}

export interface WorkflowDriver {
  start?(runId: RunId): Promise<void>;
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  awaitApproval(approvalId: ApprovalId, timeoutMs: number): Promise<Approval>;
  resolveApproval(approvalId: ApprovalId, decision: Approval): Promise<void>;
}

export interface RunCoordinator extends Workflow {
  executeRun(runId: RunId, driver: WorkflowDriver): Promise<void>;
}
