import {
  DomainError,
  formatUtcTimestamp,
  type Approval,
  type ApprovalEffectStore,
  type ApprovalId,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type EffectId,
  type EffectIdentity,
  type Engine,
  type EngineKind,
  type FinishRunInput,
  type FinishRunOutcome,
  type JsonValue,
  type MessagePart,
  type Run,
  type RunAdmission,
  type RunId,
  type RunRequest,
  type RunStore,
  type ToolResult,
  type Tools,
  type UtcTimestamp,
  type Workflow,
} from "@der/domain";
import { UncertainEffectError } from "./fixture-engine";

export interface AwaitApprovalInput {
  readonly run: Run;
  readonly effect: EffectIdentity;
  readonly prompt: string;
}

export interface AwaitApprovalOutcome {
  readonly status: "approved" | "denied" | "expired";
  readonly approvalId: ApprovalId;
  readonly effect: EffectIdentity;
}

export interface DurableWorkflow extends Workflow {
  admit(request: RunRequest): Promise<RunAdmission>;
  decide(
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ): Promise<Approval>;
  awaitApproval?(input: AwaitApprovalInput, signal?: AbortSignal): Promise<AwaitApprovalOutcome>;
}

export type WorkflowStore = RunStore & ApprovalEffectStore;

export interface WorkflowDeps {
  readonly store: WorkflowStore;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly tools: Tools;
  readonly approvalTimeoutMs: number;
  readonly eventBatchSize?: number;
  readonly now?: () => Date;
  readonly reconcileEffect?: (effect: EffectIdentity) => Promise<ToolResult | undefined>;
  readonly onRunFinished?: (run: Run) => Promise<void>;
}

async function finishRunAndNotify(
  deps: Pick<WorkflowDeps, "store" | "onRunFinished">,
  input: FinishRunInput,
): Promise<FinishRunOutcome> {
  const finished = await deps.store.finishRun(input);
  await deps.onRunFinished?.(finished.run);
  return finished;
}

export type PreApprovalStageResult =
  | {
      readonly kind: "approval_required";
      readonly effect: EffectIdentity;
      readonly prompt: string;
    }
  | {
      readonly kind: "completed";
      readonly finalMessageParts?: readonly MessagePart[];
    }
  | {
      readonly kind: "interrupted";
      readonly effectId?: EffectId;
      readonly detail: string;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly detail: string;
    };

export type ApprovedEffectStepResult =
  | {
      readonly kind: "executed";
      readonly toolResult: ToolResult;
      readonly reused: boolean;
    }
  | {
      readonly kind: "uncertain";
      readonly effectId: EffectId;
      readonly detail: string;
    };

export interface ApprovalDecisionPayload {
  readonly approvalId: ApprovalId;
  readonly status: "approved" | "denied" | "expired";
  readonly actor?: string;
  readonly decidedAt: UtcTimestamp;
}

const DEFAULT_EVENT_BATCH_SIZE = 8;

export async function loadAndStartRunStep(
  deps: WorkflowDeps,
  runId: RunId,
): Promise<{ readonly run: Run; readonly alreadyTerminal: boolean }> {
  const existing = await deps.store.getRun(runId);
  if (!existing) {
    throw new DomainError({
      type: "https://der.invalid/problems/run-not-found",
      title: "Run not found",
      status: 404,
      detail: `Run ${runId} does not exist.`,
      instance: `/api/runs/${runId}`,
      code: "run.not_found",
    });
  }

  if (
    existing.status === "completed" ||
    existing.status === "failed" ||
    existing.status === "interrupted" ||
    existing.status === "cancelled"
  ) {
    return { run: existing, alreadyTerminal: true };
  }

  const started = await deps.store.markRunRunning(runId);
  return { run: started, alreadyTerminal: false };
}

export async function executeEnginePreApprovalStage(
  deps: WorkflowDeps,
  run: Run,
): Promise<PreApprovalStageResult> {
  const engine = deps.engines.get(run.engine);
  if (!engine) {
    return {
      kind: "failed",
      code: "engine.not_configured",
      detail: `Engine "${run.engine}" is not registered on this server.`,
    };
  }

  const batchSize = deps.eventBatchSize ?? DEFAULT_EVENT_BATCH_SIZE;
  const pendingChunks: {
    readonly chunkKey: string;
    readonly chunk: JsonValue;
    readonly isTerminal?: boolean;
  }[] = [];

  const readInterruptedStage = async (
    fallbackDetail?: string,
  ): Promise<PreApprovalStageResult | undefined> => {
    const currentRun = await deps.store.getRun(run.id);
    if (currentRun?.status !== "interrupted") {
      return undefined;
    }
    const checkpoint =
      currentRun.checkpoint !== null &&
      typeof currentRun.checkpoint === "object" &&
      !Array.isArray(currentRun.checkpoint)
        ? (currentRun.checkpoint as Record<string, unknown>)
        : undefined;
    const effectId =
      typeof checkpoint?.["interruptedEffectId"] === "string"
        ? checkpoint["interruptedEffectId"]
        : undefined;
    return {
      kind: "interrupted",
      ...(effectId !== undefined ? { effectId } : {}),
      detail: fallbackDetail ?? "Run interrupted due to uncertain host-tool effect outcome.",
    };
  };

  const flush = async () => {
    if (pendingChunks.length === 0) {
      return;
    }
    if ((await deps.store.getRun(run.id))?.status === "interrupted") {
      pendingChunks.length = 0;
      return;
    }
    const batch = pendingChunks.splice(0, pendingChunks.length);
    await deps.store.appendRunEvents(run.id, batch);
  };

  try {
    for await (const event of engine.run(run)) {
      const interrupted = await readInterruptedStage();
      if (interrupted) {
        return interrupted;
      }

      if (event.type === "chunk") {
        pendingChunks.push({
          chunkKey: event.chunkKey,
          chunk: event.chunk,
          ...(event.isTerminal !== undefined ? { isTerminal: event.isTerminal } : {}),
        });
        if (pendingChunks.length >= batchSize) {
          await flush();
        }
        continue;
      }

      await flush();

      if (event.type === "approval_required") {
        return {
          kind: "approval_required",
          effect: event.effect,
          prompt: event.prompt,
        };
      }

      if (event.type === "completed") {
        const postInterrupted = await readInterruptedStage();
        if (postInterrupted) {
          return postInterrupted;
        }
        return {
          kind: "completed",
          ...(event.finalMessage ? { finalMessageParts: event.finalMessage.parts } : {}),
        };
      }

      const failInterrupted = await readInterruptedStage(event.detail);
      if (failInterrupted) {
        return failInterrupted;
      }
      return {
        kind: "failed",
        code: event.code,
        detail: event.detail,
      };
    }
  } catch (error) {
    const interrupted = await readInterruptedStage(
      error instanceof Error ? error.message : undefined,
    );
    if (interrupted) {
      return interrupted;
    }
    if (error instanceof UncertainEffectError) {
      return {
        kind: "interrupted",
        detail: error.message,
      };
    }
    throw error;
  }

  const endInterrupted = await readInterruptedStage();
  if (endInterrupted) {
    return endInterrupted;
  }

  await flush();
  return { kind: "completed" };
}

export async function persistPendingApprovalStep(
  deps: WorkflowDeps,
  input: {
    readonly run: Run;
    readonly effect: EffectIdentity;
    readonly prompt: string;
    readonly awakeable: string;
    readonly deadline: UtcTimestamp;
  },
): Promise<{ readonly approvalId: ApprovalId; readonly deadline: UtcTimestamp }> {
  const result = await deps.store.requestApproval({
    botId: input.run.botId,
    sessionId: input.run.sessionId,
    runId: input.run.id,
    effect: input.effect,
    prompt: input.prompt,
    awakeable: input.awakeable,
    deadline: input.deadline,
  });

  await deps.store.appendRunEvents(input.run.id, [
    {
      chunkKey: `${input.run.id}:approval:${result.approval.id}:requested`,
      chunk: {
        type: "CUSTOM",
        name: "approval.requested",
        value: {
          approvalId: result.approval.id,
          operationKind: input.effect.operationKind,
          operationId: input.effect.operationId,
          prompt: input.prompt,
          deadline: result.approval.deadline,
        },
      },
    },
  ]);

  return {
    approvalId: result.approval.id,
    deadline: result.approval.deadline,
  };
}

export async function reconcileApprovalExpiryStep(
  deps: WorkflowDeps,
  input: {
    readonly run: Run;
    readonly approvalId: ApprovalId;
    readonly deadline: UtcTimestamp;
  },
): Promise<"approved" | "denied" | "expired"> {
  try {
    const settled = await deps.store.decide({
      approvalId: input.approvalId,
      botId: input.run.botId,
      sessionId: input.run.sessionId,
      runId: input.run.id,
      status: "expired",
      decidedAt: input.deadline,
    });
    return settled.decision.status === "approved"
      ? "approved"
      : settled.decision.status === "denied"
        ? "denied"
        : "expired";
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.code === "approval.expired" || error.code === "approval.decision_conflict")
    ) {
      const current = await deps.store.getApproval(input.approvalId);
      if (current) {
        return current.decision.status === "approved"
          ? "approved"
          : current.decision.status === "denied"
            ? "denied"
            : "expired";
      }
    }
    throw error;
  }
}

function toolResultToJson(result: ToolResult): JsonValue {
  return {
    ok: result.ok,
    outcome: result.outcome,
    isError: result.isError,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  };
}

export async function executeApprovedEffectStep(
  deps: Pick<WorkflowDeps, "store" | "tools" | "reconcileEffect">,
  input: {
    readonly run: Run;
    readonly approvalId: ApprovalId;
    readonly effect: EffectIdentity;
  },
): Promise<ApprovedEffectStepResult> {
  const begin = await deps.store.beginEffect(input.effect, { approvalId: input.approvalId });

  if (begin.kind === "completed") {
    const outcome = begin.effect.outcome as ToolResult | null;
    return {
      kind: "executed",
      toolResult: outcome ?? { ok: true, outcome: null, isError: false },
      reused: true,
    };
  }

  if (begin.kind === "ambiguous") {
    if (deps.reconcileEffect) {
      const reconciled = await deps.reconcileEffect(input.effect);
      if (reconciled !== undefined) {
        await deps.store.completeEffect(begin.effect.id, toolResultToJson(reconciled));
        return {
          kind: "executed",
          toolResult: reconciled,
          reused: true,
        };
      }
    }
    await deps.store.markEffectUnknown(begin.effect.id);
    return {
      kind: "uncertain",
      effectId: begin.effect.id,
      detail: `Effect ${input.effect.operationKind}:${input.effect.operationId} (${input.effect.attemptId}) had a prior started marker with uncertain outcome.`,
    };
  }

  try {
    const toolResult = await deps.tools.invoke({ effect: input.effect });
    await deps.store.completeEffect(begin.effect.id, toolResultToJson(toolResult));
    return {
      kind: "executed",
      toolResult,
      reused: false,
    };
  } catch (error) {
    if (error instanceof UncertainEffectError) {
      await deps.store.markEffectUnknown(begin.effect.id);
      return {
        kind: "uncertain",
        effectId: begin.effect.id,
        detail: error.message,
      };
    }
    await deps.store.markEffectUnknown(begin.effect.id);
    return {
      kind: "uncertain",
      effectId: begin.effect.id,
      detail: error instanceof Error ? error.message : "Unknown error during effect execution.",
    };
  }
}

export async function finalizeCompletedWithEffectStep(
  deps: WorkflowDeps,
  input: {
    readonly run: Run;
    readonly effect: EffectIdentity;
    readonly toolResult: ToolResult;
  },
): Promise<Run> {
  const messageId = `msg_stream_${input.run.id}`;
  const summaryText = input.toolResult.ok
    ? `Applied ${input.effect.operationId}: ${JSON.stringify(input.toolResult.outcome)}`
    : `Operation ${input.effect.operationId} failed: ${input.toolResult.detail ?? "error"}`;

  await deps.store.appendRunEvents(input.run.id, [
    {
      chunkKey: `${input.run.id}:effect:${input.effect.attemptId}:result`,
      chunk: {
        type: "TOOL_CALL_RESULT",
        messageId,
        toolCallId: input.effect.attemptId,
        content: JSON.stringify(input.toolResult),
      },
    },
    {
      chunkKey: `${input.run.id}:delta:post-approval`,
      chunk: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: summaryText,
      },
    },
    {
      chunkKey: `${input.run.id}:msg-end`,
      chunk: {
        type: "TEXT_MESSAGE_END",
        messageId,
      },
    },
  ]);

  const finished = await finishRunAndNotify(deps, {
    runId: input.run.id,
    status: "completed",
    terminalEvent: {
      chunkKey: `${input.run.id}:terminal`,
      chunk: {
        type: "RUN_FINISHED",
        threadId: input.run.sessionId,
        runId: input.run.id,
      },
    },
    finalMessageParts: [{ type: "text", text: summaryText }],
  });

  return finished.run;
}

export async function finalizeRejectedApprovalStep(
  deps: WorkflowDeps,
  input: {
    readonly run: Run;
    readonly approvalId: ApprovalId;
    readonly status: "denied" | "expired";
  },
): Promise<Run> {
  const messageId = `msg_stream_${input.run.id}`;
  const replyText =
    input.status === "denied"
      ? "Effect execution was denied by operator."
      : "Approval expired before a decision was recorded.";

  await deps.store.appendRunEvents(input.run.id, [
    {
      chunkKey: `${input.run.id}:approval:${input.approvalId}:${input.status}`,
      chunk: {
        type: "CUSTOM",
        name: "approval.settled",
        value: {
          approvalId: input.approvalId,
          status: input.status,
        },
      },
    },
    {
      chunkKey: `${input.run.id}:delta:rejected`,
      chunk: {
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta: replyText,
      },
    },
    {
      chunkKey: `${input.run.id}:msg-end`,
      chunk: {
        type: "TEXT_MESSAGE_END",
        messageId,
      },
    },
  ]);

  const finished = await finishRunAndNotify(deps, {
    runId: input.run.id,
    status: input.status === "denied" ? "completed" : "cancelled",
    terminalEvent: {
      chunkKey: `${input.run.id}:terminal`,
      chunk: {
        type: "RUN_FINISHED",
        threadId: input.run.sessionId,
        runId: input.run.id,
      },
    },
    finalMessageParts: [{ type: "text", text: replyText }],
    detail: replyText,
  });

  return finished.run;
}

export async function finalizeInterruptedUncertainStep(
  deps: Pick<WorkflowDeps, "store" | "now" | "onRunFinished">,
  input: {
    readonly run: Run;
    readonly effectId: EffectId;
    readonly detail: string;
  },
): Promise<Run> {
  const now = deps.now ? deps.now() : new Date();
  const finished = await finishRunAndNotify(deps, {
    runId: input.run.id,
    status: "interrupted",
    terminalEvent: {
      chunkKey: `${input.run.id}:terminal`,
      chunk: {
        type: "RUN_ERROR",
        message: input.detail,
        code: "effect.outcome_uncertain",
        runId: input.run.id,
        threadId: input.run.sessionId,
      },
    },
    detail: input.detail,
    checkpoint: {
      interruptedEffectId: input.effectId,
      recordedAt: formatUtcTimestamp(now),
    },
  });

  return finished.run;
}

export async function finalizeDirectRunStep(
  deps: WorkflowDeps,
  input: {
    readonly run: Run;
    readonly outcome: Exclude<PreApprovalStageResult, { readonly kind: "approval_required" }>;
  },
): Promise<Run> {
  const current = await deps.store.getRun(input.run.id);
  if (current?.status === "interrupted") {
    return current;
  }

  if (input.outcome.kind === "interrupted") {
    const now = deps.now ? deps.now() : new Date();
    const finished = await finishRunAndNotify(deps, {
      runId: input.run.id,
      status: "interrupted",
      terminalEvent: {
        chunkKey: `${input.run.id}:terminal`,
        chunk: {
          type: "RUN_ERROR",
          message: input.outcome.detail,
          code: "effect.outcome_uncertain",
          runId: input.run.id,
          threadId: input.run.sessionId,
        },
      },
      detail: input.outcome.detail,
      ...(input.outcome.effectId !== undefined
        ? {
            checkpoint: {
              interruptedEffectId: input.outcome.effectId,
              recordedAt: formatUtcTimestamp(now),
            },
          }
        : {}),
    });
    return finished.run;
  }

  if (input.outcome.kind === "completed") {
    const finished = await finishRunAndNotify(deps, {
      runId: input.run.id,
      status: "completed",
      terminalEvent: {
        chunkKey: `${input.run.id}:terminal`,
        chunk: {
          type: "RUN_FINISHED",
          threadId: input.run.sessionId,
          runId: input.run.id,
        },
      },
      ...(input.outcome.finalMessageParts !== undefined
        ? { finalMessageParts: input.outcome.finalMessageParts }
        : {}),
    });
    return finished.run;
  }

  const finished = await finishRunAndNotify(deps, {
    runId: input.run.id,
    status: "failed",
    terminalEvent: {
      chunkKey: `${input.run.id}:terminal`,
      chunk: {
        type: "RUN_ERROR",
        message: input.outcome.detail,
        code: input.outcome.code,
        runId: input.run.id,
        threadId: input.run.sessionId,
      },
    },
    detail: input.outcome.detail,
  });
  return finished.run;
}
