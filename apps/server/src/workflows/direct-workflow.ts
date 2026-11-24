import type { Approval, ApprovalId, RunId } from "@der/domain";
import {
  createRunCoordinator,
  type AwakeableHandle,
  type CoordinatorDriver,
  type RunCoordinator,
} from "./coordinator";
import { finishRunAndNotify, type ApprovalDecisionPayload, type WorkflowDeps } from "./run-steps";

export const ENGINE_EXECUTION_FAILED_CODE = "engine.execution_failed";

function failureDetail(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Engine execution failed.";
}

export async function runDirectRun(
  deps: Pick<WorkflowDeps, "store" | "onRunFinished">,
  coordinator: Pick<RunCoordinator, "executeRun">,
  driver: CoordinatorDriver,
  runId: RunId,
  options?: {
    readonly signal?: AbortSignal;
    readonly logError?: (runId: RunId, error: unknown) => void;
  },
): Promise<void> {
  try {
    await coordinator.executeRun(runId, driver);
  } catch (error) {
    if (options?.signal?.aborted) {
      return;
    }
    options?.logError?.(runId, error);
    try {
      await finishRunAndNotify(deps, {
        runId,
        end: {
          kind: "fail",
          code: ENGINE_EXECUTION_FAILED_CODE,
          detail: failureDetail(error),
        },
      });
    } catch (finishError) {
      if (!options?.signal?.aborted) {
        options?.logError?.(runId, finishError);
      }
    }
  }
}

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
  driver.setRunner((runId) => runDirectRun(deps, coordinator, driver, runId));

  return {
    ...coordinator,
    close: () => driver.close(),
  };
}
