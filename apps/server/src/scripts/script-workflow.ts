import * as restate from "@restatedev/restate-sdk/fetch";
import * as clients from "@restatedev/restate-sdk-clients";
import {
  formatUtcTimestamp,
  type ApprovalResolutionInput,
  type Approval,
  type ExecuteResult,
} from "@der/domain";
import { isTerminalScriptRunStatus, type SqliteScriptRuns } from "@der/storage";
import type { CoordinatorDriver } from "../workflows/coordinator";
import { createRestateStepDriver } from "../workflows/restate-workflows";
import { cancelledResult, executeScriptRun, type ScriptExecutionDeps } from "./script-execution";

export interface ScriptRuns {
  submit(scriptRunId: string): Promise<void>;
  attach(scriptRunId: string, signal: AbortSignal): Promise<ExecuteResult>;
  cancel(scriptRunId: string): Promise<void>;
}

export interface ScriptCancelDeps {
  readonly scriptRuns: SqliteScriptRuns;
  readonly decide: (decision: ApprovalResolutionInput) => Promise<Approval>;
  readonly now?: () => Date;
}

const NONDETERMINISTIC_STATUS = 570;
const CANCELLED_STATUS = 409;

function failedResult(
  kind: "script" | "capability" | "nondeterministic",
  message: string,
): ExecuteResult {
  return { ok: false, error: { kind, message }, logs: [] };
}

async function cancelScriptRun(deps: ScriptCancelDeps, scriptRunId: string): Promise<void> {
  const scriptRun = deps.scriptRuns.get(scriptRunId);
  if (!scriptRun || isTerminalScriptRunStatus(scriptRun.status)) {
    return;
  }
  await deps.scriptRuns.finish(scriptRunId, "cancelled", cancelledResult());
  const decidedAt = formatUtcTimestamp(deps.now ? deps.now() : new Date());
  for (const approval of deps.scriptRuns.listPendingApprovals(scriptRunId)) {
    await deps.decide({
      approvalId: approval.id,
      botId: approval.botId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      status: "expired",
      decidedAt,
    });
  }
}

function storedResult(
  scriptRuns: SqliteScriptRuns,
  scriptRunId: string,
): ExecuteResult | undefined {
  const scriptRun = scriptRuns.get(scriptRunId);
  return scriptRun && isTerminalScriptRunStatus(scriptRun.status) && scriptRun.result !== null
    ? scriptRun.result
    : undefined;
}

export interface DirectScriptRuns extends ScriptRuns {
  close(): Promise<void>;
}

export function createDirectScriptRuns(
  deps: ScriptExecutionDeps &
    ScriptCancelDeps & {
      readonly driver: CoordinatorDriver;
    },
): DirectScriptRuns {
  const active = new Map<
    string,
    { readonly controller: AbortController; readonly task: Promise<void> }
  >();

  return {
    async submit(scriptRunId: string): Promise<void> {
      if (active.has(scriptRunId) || storedResult(deps.scriptRuns, scriptRunId) !== undefined) {
        return;
      }
      const controller = new AbortController();
      const task = executeScriptRun(deps, deps.driver, scriptRunId, { cancel: controller.signal })
        .then(() => undefined)
        .catch(async (error: unknown) => {
          await deps.scriptRuns.finish(
            scriptRunId,
            "failed",
            failedResult("script", error instanceof Error ? error.message : String(error)),
          );
        })
        .finally(() => {
          active.delete(scriptRunId);
        });
      active.set(scriptRunId, { controller, task });
    },

    async attach(scriptRunId: string, signal: AbortSignal): Promise<ExecuteResult> {
      signal.throwIfAborted();
      const running = active.get(scriptRunId);
      if (running) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          running.task.then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", onAbort);
          });
        });
      }
      const result = storedResult(deps.scriptRuns, scriptRunId);
      if (result !== undefined) {
        return result;
      }
      const orphan = await deps.scriptRuns.finish(
        scriptRunId,
        "interrupted",
        failedResult("capability", "script was interrupted by a server restart"),
      );
      return orphan.result ?? failedResult("capability", "script was interrupted");
    },

    async cancel(scriptRunId: string): Promise<void> {
      active.get(scriptRunId)?.controller.abort();
      await cancelScriptRun(deps, scriptRunId);
    },

    async close(): Promise<void> {
      for (const { controller } of active.values()) {
        controller.abort();
      }
      await Promise.allSettled([...active.values()].map((entry) => entry.task));
    },
  };
}

export function createScriptWorkflow(deps: ScriptExecutionDeps) {
  return restate.workflow({
    name: "ScriptWorkflow",
    handlers: {
      run: restate.handlers.workflow.workflow(
        { onJournalMismatchErrors: "fail" },
        async (
          ctx: restate.WorkflowContext,
          input: { readonly scriptRunId: string },
        ): Promise<ExecuteResult> => {
          const driver = createRestateStepDriver(ctx, { wrapTerminalErrors: true });
          const attemptEnded = ctx.request().attemptCompletedSignal;
          try {
            const result = await executeScriptRun(deps, driver, input.scriptRunId, {
              attemptEnded,
            });
            return result ?? cancelledResult();
          } catch (error) {
            if (!(error instanceof restate.TerminalError) || attemptEnded.aborted) {
              throw error;
            }
            return ctx.run("script-fail", async () => {
              const row = await deps.scriptRuns.finish(
                input.scriptRunId,
                "failed",
                failedResult("capability", error.message),
              );
              return row.result ?? failedResult("capability", error.message);
            });
          }
        },
      ),
    },
  });
}

export type ScriptWorkflowDefinition = ReturnType<typeof createScriptWorkflow>;

const ScriptWorkflowApi: ScriptWorkflowDefinition = {
  name: "ScriptWorkflow",
} as ScriptWorkflowDefinition;

export function createRestateScriptRuns(ingressUrl: string, deps: ScriptCancelDeps): ScriptRuns {
  const ingress = clients.connect({ url: ingressUrl });
  const workflow = (scriptRunId: string) => ingress.workflowClient(ScriptWorkflowApi, scriptRunId);

  return {
    async submit(scriptRunId: string): Promise<void> {
      await workflow(scriptRunId).workflowSubmit({ scriptRunId });
    },

    async attach(scriptRunId: string, signal: AbortSignal): Promise<ExecuteResult> {
      try {
        return await workflow(scriptRunId).workflowAttach(clients.rpc.opts({ signal }));
      } catch (error) {
        if (signal.aborted || !(error instanceof clients.HttpCallError)) {
          throw error;
        }
        if (error.status === NONDETERMINISTIC_STATUS) {
          const row = await deps.scriptRuns.finish(
            scriptRunId,
            "failed",
            failedResult("nondeterministic", error.message),
          );
          return row.result ?? failedResult("nondeterministic", error.message);
        }
        const stored = storedResult(deps.scriptRuns, scriptRunId);
        if (error.status === CANCELLED_STATUS && stored !== undefined) {
          return stored;
        }
        throw error;
      }
    },

    cancel: (scriptRunId: string) => cancelScriptRun(deps, scriptRunId),
  };
}
