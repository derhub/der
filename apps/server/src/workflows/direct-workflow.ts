import {
  formatUtcTimestamp,
  type Approval,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type RunAdmission,
  type RunId,
  type RunRequest,
} from "@der/domain";
import {
  executeApprovedEffectStep,
  executeEnginePreApprovalStage,
  finalizeCompletedWithEffectStep,
  finalizeDirectRunStep,
  finalizeInterruptedUncertainStep,
  finalizeRejectedApprovalStep,
  loadAndStartRunStep,
  persistPendingApprovalStep,
  reconcileApprovalExpiryStep,
  type ApprovalDecisionPayload,
  type DurableWorkflow,
  type WorkflowDeps,
} from "./run-steps";

interface PendingAwakeable {
  readonly resolve: (payload: ApprovalDecisionPayload) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createDirectWorkflow(deps: WorkflowDeps): DurableWorkflow & {
  readonly close: () => void;
} {
  const awakeables = new Map<string, PendingAwakeable>();
  const activeRuns = new Map<RunId, Promise<void>>();

  async function executeRun(runId: RunId): Promise<void> {
    const started = await loadAndStartRunStep(deps, runId);
    if (started.alreadyTerminal) {
      return;
    }

    const run = started.run;
    const stage = await executeEnginePreApprovalStage(deps, run);

    if (stage.kind !== "approval_required") {
      await finalizeDirectRunStep(deps, { run, outcome: stage });
      return;
    }

    const awakeableId = `direct_awk_${crypto.randomUUID()}`;
    const deadlineMs = deps.store.database.now().getTime() + deps.approvalTimeoutMs;
    const deadline = formatUtcTimestamp(new Date(deadlineMs));

    const { approvalId } = await persistPendingApprovalStep(deps, {
      run,
      effect: stage.effect,
      prompt: stage.prompt,
      awakeable: awakeableId,
      deadline,
    });

    const decisionStatus = await new Promise<"approved" | "denied" | "expired">((resolveWait) => {
      const remainingMs = Math.max(1, deadlineMs - deps.store.database.now().getTime());
      const timer = setTimeout(() => {
        awakeables.delete(awakeableId);
        void reconcileApprovalExpiryStep(deps, { run, approvalId, deadline })
          .then(resolveWait)
          .catch(() => resolveWait("expired"));
      }, remainingMs);

      awakeables.set(awakeableId, {
        timer,
        resolve: (payload) => {
          clearTimeout(timer);
          awakeables.delete(awakeableId);
          resolveWait(payload.status);
        },
      });
    });

    if (decisionStatus !== "approved") {
      await finalizeRejectedApprovalStep(deps, {
        run,
        approvalId,
        status: decisionStatus,
      });
      return;
    }

    const effectOutcome = await executeApprovedEffectStep(deps, {
      run,
      approvalId,
      effect: stage.effect,
    });

    if (effectOutcome.kind === "uncertain") {
      await finalizeInterruptedUncertainStep(deps, {
        run,
        effectId: effectOutcome.effectId,
        detail: effectOutcome.detail,
      });
      return;
    }

    await finalizeCompletedWithEffectStep(deps, {
      run,
      effect: stage.effect,
      toolResult: effectOutcome.toolResult,
    });
  }

  return {
    async admit(request: RunRequest): Promise<RunAdmission> {
      const admission = await deps.store.admit(request);
      if (!activeRuns.has(admission.run.id)) {
        const task = executeRun(admission.run.id).finally(() => {
          activeRuns.delete(admission.run.id);
        });
        activeRuns.set(admission.run.id, task);
      }
      return admission;
    },

    async decide(
      decision: ApprovalResolutionInput,
      channelIntake?: ChannelIntakeMetadata,
    ): Promise<Approval> {
      const settled = await deps.store.decide(decision, channelIntake);
      const pending = awakeables.get(settled.awakeable);
      if (pending && settled.decision.status !== "pending") {
        pending.resolve({
          approvalId: settled.id,
          status: settled.decision.status,
          ...(settled.decision.status === "approved" || settled.decision.status === "denied"
            ? { actor: settled.decision.actor }
            : {}),
          decidedAt: settled.decision.decidedAt,
        });
      }
      return settled;
    },

    close(): void {
      for (const entry of awakeables.values()) {
        clearTimeout(entry.timer);
      }
      awakeables.clear();
    },
  };
}
