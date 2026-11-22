import type { Approval, ApprovalId, RunId } from "@der/domain";
import {
  createRunCoordinator,
  type AwakeableHandle,
  type CoordinatorDriver,
  type RunCoordinator,
} from "./coordinator";
import type { ApprovalDecisionPayload, WorkflowDeps } from "./run-steps";

interface PendingAwakeable {
  readonly resolve: (payload: ApprovalDecisionPayload) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface DirectWorkflowDriver extends CoordinatorDriver {
  setRunner(runner: (runId: RunId) => Promise<void>): void;
  close(): void;
}

export interface DirectWorkflowDriverOptions {
  readonly now?: () => Date;
}

export function createDirectWorkflowDriver(
  options: DirectWorkflowDriverOptions = {},
): DirectWorkflowDriver {
  const nowFn = options.now ?? (() => new Date());
  const awakeables = new Map<string, PendingAwakeable>();
  const activeRuns = new Map<RunId, Promise<void>>();
  let runner: ((runId: RunId) => Promise<void>) | undefined;

  return {
    setRunner(nextRunner: (runId: RunId) => Promise<void>): void {
      runner = nextRunner;
    },

    async start(runId: RunId): Promise<void> {
      if (!runner || activeRuns.has(runId)) {
        return;
      }
      const task = runner(runId).finally(() => {
        activeRuns.delete(runId);
      });
      activeRuns.set(runId, task);
    },

    runStep<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },

    nowMs(): Promise<number> {
      return Promise.resolve(nowFn().getTime());
    },

    createAwakeable(): AwakeableHandle {
      const id = `direct_awk_${crypto.randomUUID()}`;
      return {
        id,
        wait(
          remainingMs: number,
          signal?: AbortSignal,
          overrideId?: string,
        ): Promise<ApprovalDecisionPayload | "timeout"> {
          if (signal?.aborted) {
            return Promise.reject(new Error("Approval request aborted."));
          }
          const targetId = overrideId ?? id;
          return new Promise<ApprovalDecisionPayload | "timeout">((resolveWait, rejectWait) => {
            const cleanupAbort = () => {
              signal?.removeEventListener("abort", onAbort);
            };
            const timer = setTimeout(
              () => {
                awakeables.delete(targetId);
                cleanupAbort();
                resolveWait("timeout");
              },
              Math.max(1, remainingMs),
            );

            const onAbort = () => {
              clearTimeout(timer);
              awakeables.delete(targetId);
              rejectWait(new Error("Approval request aborted."));
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            awakeables.set(targetId, {
              timer,
              resolve: (payload) => {
                clearTimeout(timer);
                awakeables.delete(targetId);
                cleanupAbort();
                resolveWait(payload);
              },
            });
          });
        },
      };
    },

    async awaitApproval(_approvalId: ApprovalId, _timeoutMs: number): Promise<Approval> {
      throw new Error("DirectWorkflowDriver uses createAwakeable() via RunCoordinator.");
    },

    async resolveApproval(_approvalId: ApprovalId, settled: Approval): Promise<void> {
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
    },

    close(): void {
      for (const entry of awakeables.values()) {
        clearTimeout(entry.timer);
      }
      awakeables.clear();
    },
  };
}

export function createDirectWorkflow(
  deps: WorkflowDeps,
): RunCoordinator & { readonly close: () => void } {
  const driver = createDirectWorkflowDriver(deps.now ? { now: deps.now } : {});
  const coordinator = createRunCoordinator({
    ...deps,
    driver,
  });
  driver.setRunner((runId) => coordinator.executeRun(runId, driver));

  return {
    ...coordinator,
    close: () => driver.close(),
  };
}
