import * as restate from "@restatedev/restate-sdk/fetch";
import * as clients from "@restatedev/restate-sdk-clients";
import {
  DomainError,
  formatUtcTimestamp,
  type Approval,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type RunAdmission,
  type RunId,
  type RunRequest,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { fingerprintJson } from "@der/storage";
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
  type AwaitApprovalInput,
  type AwaitApprovalOutcome,
  type DurableWorkflow,
  type WorkflowDeps,
} from "./run-steps";

const PROBLEM_MARKER = "__derProblem";

function toRestateTerminalError(error: unknown): never {
  if (error instanceof DomainError) {
    throw new restate.TerminalError(
      JSON.stringify({ [PROBLEM_MARKER]: error.toProblemDetails() }),
      { errorCode: error.status },
    );
  }
  throw error;
}

function tryExtractProblem(raw: string): DomainError | undefined {
  const candidates: string[] = [raw];
  try {
    const outer = JSON.parse(raw) as { message?: unknown };
    if (typeof outer.message === "string") {
      candidates.push(outer.message);
    }
  } catch {
    // Raw text may already contain embedded JSON.
  }

  for (const candidate of candidates) {
    const markerIndex = candidate.indexOf(`"${PROBLEM_MARKER}"`);
    const slice =
      markerIndex !== -1 ? candidate.slice(candidate.lastIndexOf("{", markerIndex)) : candidate;
    try {
      const parsed = JSON.parse(slice) as Record<string, unknown>;
      const inner = parsed[PROBLEM_MARKER];
      const validated = compiledParsers.problemDetails.safeParse(inner);
      if (validated.success) {
        return new DomainError(validated.data);
      }
    } catch {
      // Try extracting balanced JSON object around marker.
      if (markerIndex !== -1) {
        const start = candidate.lastIndexOf("{", markerIndex);
        const end = candidate.lastIndexOf("}");
        if (start !== -1 && end > start) {
          try {
            const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
            const validated = compiledParsers.problemDetails.safeParse(parsed[PROBLEM_MARKER]);
            if (validated.success) {
              return new DomainError(validated.data);
            }
          } catch {
            // Fall through to generic handling.
          }
        }
      }
    }
  }

  return undefined;
}

function mapRestateIngressError(error: unknown, instance: string): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  if (error instanceof clients.HttpCallError) {
    const decoded = tryExtractProblem(error.responseText) ?? tryExtractProblem(error.message);
    if (decoded) {
      return decoded;
    }
    return new DomainError({
      type: "https://der.invalid/problems/restate-error",
      title: "Workflow command failed",
      status: error.status >= 400 && error.status <= 599 ? error.status : 502,
      detail: error.message || "Restate rejected the workflow command.",
      instance,
      code: "restate.command_failed",
    });
  }

  return new DomainError({
    type: "https://der.invalid/problems/restate-unavailable",
    title: "Restate ingress unavailable",
    status: 503,
    detail:
      error instanceof Error
        ? `Restate ingress is unavailable: ${error.message}`
        : "Restate ingress is unavailable.",
    instance,
    code: "restate.unavailable",
  });
}

export interface DecideCommandInput {
  readonly decision: ApprovalResolutionInput;
  readonly channelIntake?: ChannelIntakeMetadata;
}

export function createRunWorkflow(deps: WorkflowDeps) {
  return restate.workflow({
    name: "RunWorkflow",
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: { readonly runId: RunId }) => {
        const started = await ctx.run("load-and-start-run", () =>
          loadAndStartRunStep(deps, input.runId),
        );
        if (started.alreadyTerminal) {
          return { status: started.run.status };
        }

        const run = started.run;
        const stage = await ctx.run("engine-pre-approval", () =>
          executeEnginePreApprovalStage(deps, run),
        );

        if (stage.kind !== "approval_required") {
          const finished = await ctx.run("finish-direct-run", () =>
            finalizeDirectRunStep(deps, { run, outcome: stage }),
          );
          return { status: finished.status };
        }

        const awakeable = ctx.awakeable<ApprovalDecisionPayload>();
        const nowMs = await ctx.date.now();
        const deadlineMs = nowMs + deps.approvalTimeoutMs;
        const deadline = formatUtcTimestamp(new Date(deadlineMs));

        const persisted = await ctx.run("persist-approval", () =>
          persistPendingApprovalStep(deps, {
            run,
            effect: stage.effect,
            prompt: stage.prompt,
            awakeable: awakeable.id,
            deadline,
          }),
        );

        let decisionStatus: "approved" | "denied" | "expired";
        try {
          const currentMs = await ctx.date.now();
          const remainingMs = Math.max(1, Date.parse(persisted.deadline) - currentMs);
          const resolved = await awakeable.promise.orTimeout(remainingMs);
          decisionStatus = resolved.status;
        } catch (error) {
          if (error instanceof restate.TimeoutError) {
            decisionStatus = await ctx.run("reconcile-approval-expiry", () =>
              reconcileApprovalExpiryStep(deps, {
                run,
                approvalId: persisted.approvalId,
                deadline: persisted.deadline,
              }),
            );
          } else {
            throw error;
          }
        }

        if (decisionStatus !== "approved") {
          const finished = await ctx.run("finish-rejected-approval", () =>
            finalizeRejectedApprovalStep(deps, {
              run,
              approvalId: persisted.approvalId,
              status: decisionStatus,
            }),
          );
          return { status: finished.status };
        }

        const effectOutcome = await ctx.run("execute-approved-effect", () =>
          executeApprovedEffectStep(deps, {
            run,
            approvalId: persisted.approvalId,
            effect: stage.effect,
          }),
        );

        if (effectOutcome.kind === "uncertain") {
          const interrupted = await ctx.run("interrupt-uncertain-run", () =>
            finalizeInterruptedUncertainStep(deps, {
              run,
              effectId: effectOutcome.effectId,
              detail: effectOutcome.detail,
            }),
          );
          return { status: interrupted.status };
        }

        const completed = await ctx.run("finish-completed-run", () =>
          finalizeCompletedWithEffectStep(deps, {
            run,
            effect: stage.effect,
            toolResult: effectOutcome.toolResult,
          }),
        );
        return { status: completed.status };
      },
    },
  });
}

export type RunWorkflowDefinition = ReturnType<typeof createRunWorkflow>;

export function createCommandsService(deps: WorkflowDeps, runWorkflow: RunWorkflowDefinition) {
  return restate.service({
    name: "Commands",
    handlers: {
      admit: async (ctx: restate.Context, request: RunRequest): Promise<RunAdmission> => {
        const admission = await ctx.run("admit-run", async () => {
          try {
            return await deps.store.admit(request);
          } catch (error) {
            toRestateTerminalError(error);
          }
        });

        ctx.workflowSendClient(runWorkflow, admission.run.id).run({
          runId: admission.run.id,
        });

        return admission;
      },

      decide: async (ctx: restate.Context, input: DecideCommandInput): Promise<Approval> => {
        const approval = await ctx.run("decide-approval", async () => {
          try {
            return await deps.store.decide(input.decision, input.channelIntake);
          } catch (error) {
            toRestateTerminalError(error);
          }
        });

        if (approval.decision.status !== "pending") {
          ctx.resolveAwakeable<ApprovalDecisionPayload>(approval.awakeable, {
            approvalId: approval.id,
            status: approval.decision.status,
            ...(approval.decision.status === "approved" || approval.decision.status === "denied"
              ? { actor: approval.decision.actor }
              : {}),
            decidedAt: approval.decision.decidedAt,
          });
        }

        return approval;
      },

      awaitApproval: async (
        ctx: restate.Context,
        input: AwaitApprovalInput,
      ): Promise<AwaitApprovalOutcome> => {
        const awakeable = ctx.awakeable<ApprovalDecisionPayload>();
        const nowMs = await ctx.date.now();
        const deadlineMs = nowMs + deps.approvalTimeoutMs;
        const deadline = formatUtcTimestamp(new Date(deadlineMs));

        const persisted = await ctx.run("persist-engine-approval", async () => {
          try {
            return await persistPendingApprovalStep(deps, {
              run: input.run,
              effect: input.effect,
              prompt: input.prompt,
              awakeable: awakeable.id,
              deadline,
            });
          } catch (error) {
            toRestateTerminalError(error);
          }
        });

        let decisionStatus: "approved" | "denied" | "expired";
        try {
          const currentMs = await ctx.date.now();
          const remainingMs = Math.max(1, Date.parse(persisted.deadline) - currentMs);
          const resolved = await awakeable.promise.orTimeout(remainingMs);
          decisionStatus = resolved.status;
        } catch (error) {
          if (error instanceof restate.TimeoutError) {
            decisionStatus = await ctx.run("reconcile-engine-approval-expiry", () =>
              reconcileApprovalExpiryStep(deps, {
                run: input.run,
                approvalId: persisted.approvalId,
                deadline: persisted.deadline,
              }),
            );
          } else {
            throw error;
          }
        }

        return {
          status: decisionStatus,
          approvalId: persisted.approvalId,
          effect: input.effect,
        };
      },
    },
  });
}

export type CommandsServiceDefinition = ReturnType<typeof createCommandsService>;

export type AnyRestateService = restate.EndpointOptions["services"][number];

export function createRestateFetchHandler(
  deps: WorkflowDeps,
  extraServices: readonly AnyRestateService[] = [],
): (request: Request, ...extraArgs: unknown[]) => Promise<Response> {
  const runWorkflow = createRunWorkflow(deps);
  const commandsService = createCommandsService(deps, runWorkflow);
  return restate.createEndpointHandler({
    services: [commandsService, runWorkflow, ...extraServices],
    bidirectional: false,
  });
}

const CommandsApi: CommandsServiceDefinition = { name: "Commands" } as CommandsServiceDefinition;

export function createRestateWorkflowClient(ingressUrl: string): DurableWorkflow {
  const ingress = clients.connect({ url: ingressUrl });

  return {
    async admit(request: RunRequest): Promise<RunAdmission> {
      const instance = `/api/sessions/${request.sessionId}/runs`;
      try {
        const fingerprint = await fingerprintJson({
          botId: request.botId,
          sessionId: request.sessionId,
          origin: request.origin,
          engine: request.engine ?? null,
          input: request.input,
          routineId: request.routineId ?? null,
          routineSlot: request.routineSlot ?? null,
        });
        const restateKey = `admit:${request.sessionId}:${request.idempotencyKey}:${fingerprint}`;
        return await ingress
          .serviceClient(CommandsApi)
          .admit(request, clients.rpc.opts({ idempotencyKey: restateKey }));
      } catch (error) {
        throw mapRestateIngressError(error, instance);
      }
    },

    async decide(
      decision: ApprovalResolutionInput,
      channelIntake?: ChannelIntakeMetadata,
    ): Promise<Approval> {
      const instance = `/api/approvals/${decision.approvalId}/decision`;
      try {
        const actorKey = decision.status === "expired" ? "system" : decision.actor;
        const restateKey = `decide:${decision.approvalId}:${decision.botId}:${decision.sessionId}:${decision.runId}:${decision.status}:${actorKey}`;
        const payload: DecideCommandInput =
          channelIntake !== undefined ? { decision, channelIntake } : { decision };
        return await ingress
          .serviceClient(CommandsApi)
          .decide(payload, clients.rpc.opts({ idempotencyKey: restateKey }));
      } catch (error) {
        throw mapRestateIngressError(error, instance);
      }
    },

    async awaitApproval(
      input: AwaitApprovalInput,
      signal?: AbortSignal,
    ): Promise<AwaitApprovalOutcome> {
      const instance = `/api/runs/${input.run.id}`;
      try {
        const fingerprint = await fingerprintJson(input.effect);
        const restateKey = `await-approval:${input.run.id}:${input.effect.operationKind}:${input.effect.operationId}:${input.effect.attemptId}:${fingerprint}`;
        const callPromise = ingress
          .serviceClient(CommandsApi)
          .awaitApproval(input, clients.rpc.opts({ idempotencyKey: restateKey }));
        if (!signal) {
          return await callPromise;
        }
        if (signal.aborted) {
          throw new Error("Approval request aborted.");
        }
        return await new Promise<AwaitApprovalOutcome>((resolve, reject) => {
          const onAbort = () => reject(new Error("Approval request aborted."));
          signal.addEventListener("abort", onAbort, { once: true });
          callPromise.then(
            (value) => {
              signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
        });
      } catch (error) {
        throw mapRestateIngressError(error, instance);
      }
    },
  };
}
