import {
  formatUtcTimestamp,
  type Approval,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type Run,
  type RunAdmission,
  type RunCoordinator as DomainRunCoordinator,
  type RunId,
  type RunRequest,
  type WorkflowDriver,
} from "@der/domain";
import type { ApprovalBroker } from "@der/runtime/engines";
import {
  executeEnginePreApprovalStage,
  finalizeDirectRunStep,
  loadAndStartRunStep,
  persistPendingApprovalStep,
  reconcileApprovalExpiryStep,
  type ApprovalDecisionPayload,
  type AwaitApprovalInput,
  type AwaitApprovalOutcome,
  type DurableWorkflow,
  type WorkflowDeps,
} from "./run-steps";

export interface AwakeableHandle {
  readonly id: string;
  wait(
    remainingMs: number,
    signal?: AbortSignal,
    overrideId?: string,
  ): Promise<ApprovalDecisionPayload | "timeout">;
}

export interface CoordinatorDriver extends WorkflowDriver {
  readonly admit?: (request: RunRequest) => Promise<RunAdmission>;
  readonly decide?: (
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ) => Promise<Approval>;
  readonly createAwakeable?: () => AwakeableHandle;
  readonly nowMs?: () => Promise<number>;
  readonly awaitApprovalCommand?: (
    input: AwaitApprovalInput,
    signal?: AbortSignal,
  ) => Promise<AwaitApprovalOutcome>;
}

export interface RunCoordinatorOptions extends WorkflowDeps {
  readonly driver: CoordinatorDriver;
}

export interface RunCoordinator extends Omit<DomainRunCoordinator, "decide">, DurableWorkflow {
  admitOnly(request: RunRequest): Promise<RunAdmission>;
  decideOnly(
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ): Promise<Approval>;
  executeRun(runId: RunId, driver: CoordinatorDriver): Promise<void>;
  awaitApproval(input: AwaitApprovalInput, signal?: AbortSignal): Promise<AwaitApprovalOutcome>;
  awaitApprovalWithDriver(
    driver: CoordinatorDriver,
    input: AwaitApprovalInput,
    signal?: AbortSignal,
  ): Promise<AwaitApprovalOutcome>;
  createApprovalBroker(run: Run): ApprovalBroker;
}

function decisionStatusFromApproval(approval: Approval): "approved" | "denied" | "expired" {
  if (approval.decision.status === "approved") {
    return "approved";
  }
  if (approval.decision.status === "denied") {
    return "denied";
  }
  return "expired";
}

export function createRunCoordinator(options: RunCoordinatorOptions): RunCoordinator {
  const nowFn = options.now ?? (() => new Date());

  async function currentNowMs(driver: CoordinatorDriver): Promise<number> {
    return driver.nowMs ? driver.nowMs() : nowFn().getTime();
  }

  async function awaitApprovalWithDriver(
    driver: CoordinatorDriver,
    input: AwaitApprovalInput,
    signal?: AbortSignal,
  ): Promise<AwaitApprovalOutcome> {
    if (signal?.aborted) {
      throw new Error("Approval request aborted.");
    }

    const awakeable = driver.createAwakeable?.();
    const awakeableId = awakeable?.id ?? `awk_${crypto.randomUUID()}`;
    const nowMs = await currentNowMs(driver);
    const deadline = formatUtcTimestamp(new Date(nowMs + options.approvalTimeoutMs));

    const persisted = await driver.runStep("persist-engine-approval", async () => {
      const result = await persistPendingApprovalStep(options, {
        run: input.run,
        effect: input.effect,
        prompt: input.prompt,
        awakeable: awakeableId,
        deadline,
      });
      const existing = await options.store.getApproval(result.approvalId);
      return {
        ...result,
        awakeableId: existing?.awakeable ?? awakeableId,
        existingStatus:
          existing && existing.decision.status !== "pending" ? existing.decision.status : undefined,
      };
    });

    if (persisted.existingStatus !== undefined) {
      return {
        status: persisted.existingStatus,
        approvalId: persisted.approvalId,
        effect: input.effect,
      };
    }

    const currentMs = await currentNowMs(driver);
    const remainingMs = Math.max(1, Date.parse(persisted.deadline) - currentMs);

    let decisionStatus: "approved" | "denied" | "expired";
    if (awakeable) {
      const outcome = await awakeable.wait(remainingMs, signal, persisted.awakeableId);
      if (outcome === "timeout") {
        decisionStatus = await driver.runStep("reconcile-engine-approval-expiry", () =>
          reconcileApprovalExpiryStep(options, {
            run: input.run,
            approvalId: persisted.approvalId,
            deadline: persisted.deadline,
          }),
        );
      } else {
        decisionStatus = outcome.status;
      }
    } else {
      const settled = await driver.awaitApproval(persisted.approvalId, remainingMs);
      decisionStatus = decisionStatusFromApproval(settled);
    }

    return {
      status: decisionStatus,
      approvalId: persisted.approvalId,
      effect: input.effect,
    };
  }

  async function executeRun(runId: RunId, driver: CoordinatorDriver): Promise<void> {
    const started = await driver.runStep("load-and-start-run", () =>
      loadAndStartRunStep(options, runId),
    );
    if (started.alreadyTerminal) {
      return;
    }

    const run = started.run;
    const stage = await driver.runStep("engine-pre-approval", () =>
      executeEnginePreApprovalStage(options, run),
    );

    await driver.runStep("finish-direct-run", () =>
      finalizeDirectRunStep(options, { run, outcome: stage }),
    );
  }

  const coordinator: RunCoordinator = {
    admitOnly(request: RunRequest): Promise<RunAdmission> {
      return options.store.admit(request);
    },

    decideOnly(
      decision: ApprovalResolutionInput,
      channelIntake?: ChannelIntakeMetadata,
    ): Promise<Approval> {
      return options.store.decide(decision, channelIntake);
    },

    async admit(request: RunRequest): Promise<RunAdmission> {
      if (options.driver.admit) {
        return options.driver.admit(request);
      }
      const admission = await options.store.admit(request);
      await options.driver.start?.(admission.run.id);
      return admission;
    },

    async decide(
      decision: ApprovalResolutionInput,
      channelIntake?: ChannelIntakeMetadata,
    ): Promise<Approval> {
      if (options.driver.decide) {
        return options.driver.decide(decision, channelIntake);
      }
      const settled = await options.store.decide(decision, channelIntake);
      if (settled.decision.status !== "pending") {
        await options.driver.resolveApproval(settled.id, settled);
      }
      return settled;
    },

    executeRun,

    awaitApproval(input: AwaitApprovalInput, signal?: AbortSignal): Promise<AwaitApprovalOutcome> {
      if (options.driver.awaitApprovalCommand) {
        return options.driver.awaitApprovalCommand(input, signal);
      }
      return awaitApprovalWithDriver(options.driver, input, signal);
    },

    awaitApprovalWithDriver(
      driver: CoordinatorDriver,
      input: AwaitApprovalInput,
      signal?: AbortSignal,
    ): Promise<AwaitApprovalOutcome> {
      return awaitApprovalWithDriver(driver, input, signal);
    },

    createApprovalBroker(run: Run): ApprovalBroker {
      return {
        requestApproval(req) {
          return coordinator.awaitApproval(
            {
              run,
              effect: req.effect,
              prompt: req.prompt,
            },
            req.signal,
          );
        },
      };
    },
  };

  return coordinator;
}
