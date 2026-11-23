import * as restate from "@restatedev/restate-sdk/fetch";
import * as clients from "@restatedev/restate-sdk-clients";
import {
  DomainError,
  type Approval,
  type ApprovalId,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type RunAdmission,
  type RunId,
  type RunRequest,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { fingerprintJson } from "@der/storage";
import type { AwakeableHandle, CoordinatorDriver, RunCoordinator } from "./coordinator";
import type {
  ApprovalDecisionPayload,
  AwaitApprovalInput,
  AwaitApprovalOutcome,
  DurableWorkflow,
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

// The SDK forwards `err.stack` to the engine as a string, but once the server modules are
// loaded Bun can hand back a structured stack, which the engine rejects and breaks the retry.
function withStringStack(error: unknown): unknown {
  if (error instanceof restate.RestateError) {
    return error;
  }
  const plain = new Error(error instanceof Error ? error.message : String(error));
  Object.defineProperty(plain, "stack", { value: `Error: ${plain.message}` });
  return plain;
}

export function createRestateStepDriver(
  ctx: restate.Context | restate.WorkflowContext,
  options?: {
    readonly wrapTerminalErrors?: boolean;
    readonly retry?: Omit<restate.RunOptions<unknown>, "serde">;
  },
): CoordinatorDriver {
  const wrapErrors = options?.wrapTerminalErrors ?? false;
  const retry = options?.retry;

  return {
    runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const action = async (): Promise<T> => {
        try {
          return await fn();
        } catch (error) {
          if (wrapErrors && error instanceof DomainError) {
            toRestateTerminalError(error);
          }
          throw retry === undefined ? error : withStringStack(error);
        }
      };
      return retry === undefined ? ctx.run(name, action) : ctx.run(name, action, retry);
    },

    nowMs(): Promise<number> {
      return ctx.date.now();
    },

    createAwakeable(): AwakeableHandle {
      const awakeable = ctx.awakeable<ApprovalDecisionPayload>();
      return {
        id: awakeable.id,
        async wait(remainingMs: number): Promise<ApprovalDecisionPayload | "timeout"> {
          try {
            return await awakeable.promise.orTimeout(Math.max(1, remainingMs));
          } catch (error) {
            if (error instanceof restate.TimeoutError) {
              return "timeout";
            }
            throw error;
          }
        },
      };
    },

    async awaitApproval(_approvalId: ApprovalId, _timeoutMs: number): Promise<Approval> {
      throw new Error("Restate step driver uses createAwakeable() via RunCoordinator.");
    },

    async resolveApproval(_approvalId: ApprovalId, approval: Approval): Promise<void> {
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
    },
  };
}

export function createRunWorkflow(coordinator: RunCoordinator) {
  return restate.workflow({
    name: "RunWorkflow",
    handlers: {
      run: async (ctx: restate.WorkflowContext, input: { readonly runId: RunId }) => {
        const driver = createRestateStepDriver(ctx);
        await coordinator.executeRun(input.runId, driver);
        return { ok: true };
      },
    },
  });
}

export type RunWorkflowDefinition = ReturnType<typeof createRunWorkflow>;

export function createCommandsService(
  coordinator: RunCoordinator,
  runWorkflow: RunWorkflowDefinition,
) {
  return restate.service({
    name: "Commands",
    handlers: {
      admit: async (ctx: restate.Context, request: RunRequest): Promise<RunAdmission> => {
        const admission = await ctx.run("admit-run", async () => {
          try {
            return await coordinator.admitOnly(request);
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
            return await coordinator.decideOnly(input.decision, input.channelIntake);
          } catch (error) {
            toRestateTerminalError(error);
          }
        });

        if (approval.decision.status !== "pending") {
          await createRestateStepDriver(ctx).resolveApproval(approval.id, approval);
        }

        return approval;
      },

      awaitApproval: async (
        ctx: restate.Context,
        input: AwaitApprovalInput,
      ): Promise<AwaitApprovalOutcome> => {
        const driver = createRestateStepDriver(ctx, { wrapTerminalErrors: true });
        return coordinator.awaitApprovalWithDriver(driver, input);
      },
    },
  });
}

export type CommandsServiceDefinition = ReturnType<typeof createCommandsService>;

export type AnyRestateService = restate.EndpointOptions["services"][number];

export function createRestateFetchHandler(
  coordinator: RunCoordinator,
  extraServices: readonly AnyRestateService[] = [],
): (request: Request, ...extraArgs: unknown[]) => Promise<Response> {
  const runWorkflow = createRunWorkflow(coordinator);
  const commandsService = createCommandsService(coordinator, runWorkflow);
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

export function createRestateWorkflowDriver(ingressUrl: string): CoordinatorDriver {
  const client = createRestateWorkflowClient(ingressUrl);
  return {
    admit: (request) => client.admit(request),
    decide: (decision, channelIntake) => client.decide(decision, channelIntake),
    awaitApprovalCommand: (input, signal) => client.awaitApproval!(input, signal),
    runStep<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async awaitApproval(_approvalId: ApprovalId, _timeoutMs: number): Promise<Approval> {
      throw new Error("Restate ingress driver routes approvals through awaitApprovalCommand().");
    },
    async resolveApproval(): Promise<void> {
      // Restate resolves awakeables inside Commands.decide.
    },
  };
}
