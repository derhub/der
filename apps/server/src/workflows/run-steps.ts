import {
  DomainError,
  formatUtcTimestamp,
  type Approval,
  type ApprovalEffectStore,
  type ApprovalId,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type ContextMode,
  type EffectId,
  type EffectIdentity,
  type Engine,
  type EngineKind,
  type EngineSession,
  type EngineSessionStore,
  type FinishRunInput,
  type FinishRunOutcome,
  type JsonValue,
  type MessagePart,
  type Run,
  type RunAdmission,
  type RunEvent,
  type RunId,
  type RunRequest,
  type RunStore,
  type RunUsage,
  type UtcTimestamp,
  type Workflow,
} from "@der/domain";
import { readRunUsage, readSessionIdChunk } from "@der/runtime/engines";
import type { ScriptRoutineDeps } from "./script-routine-stage";

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

export type WorkflowStore = RunStore & ApprovalEffectStore & EngineSessionStore;

/** How the context loader delivered one Run's context, handed to the engine step that consumes it. */
export interface TurnRecord {
  readonly contextMode: ContextMode;
  /** Vendor session id the engine is asked to resume; absent on a rebuild. */
  readonly resumedFrom?: string;
  /** The engine can resume, so a finished turn leaves a vendor session to store. */
  readonly saveable: boolean;
  readonly baseHash: string;
  readonly contextHash: string;
  readonly lastOrdinal: number;
}

export type EngineSessionRow = Omit<EngineSession, "pendingRunId" | "updatedAt">;

export interface TurnOutcome {
  readonly contextMode: ContextMode;
  readonly save?: EngineSessionRow;
}

export interface WorkflowDeps {
  readonly store: WorkflowStore;
  /** Written by the context loader inside the engine step, read and cleared by it. */
  readonly turns?: Map<RunId, TurnRecord>;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly approvalTimeoutMs: number;
  readonly eventBatchSize?: number;
  readonly now?: () => Date;
  readonly onRunFinished?: (run: Run) => Promise<void>;
  readonly scriptRoutines?: () => ScriptRoutineDeps;
}

async function finishRunAndNotify(
  deps: Pick<WorkflowDeps, "store" | "onRunFinished">,
  input: FinishRunInput,
): Promise<FinishRunOutcome> {
  const finished = await deps.store.finishRun(input);
  await deps.onRunFinished?.(finished.run);
  return finished;
}

export type RunStageResult =
  | {
      readonly kind: "completed";
      readonly finalMessageParts?: readonly MessagePart[];
      readonly usage?: RunUsage;
      readonly turn?: TurnOutcome;
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

export interface ApprovalDecisionPayload {
  readonly approvalId: ApprovalId;
  readonly status: "approved" | "denied" | "expired";
  readonly actor?: string;
  readonly decidedAt: UtcTimestamp;
}

const DEFAULT_EVENT_BATCH_SIZE = 8;
const ATTEMPT_RESET_EVENT = "der.attempt-reset";

function isToolCallEnd(chunk: JsonValue): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    !Array.isArray(chunk) &&
    chunk["type"] === "TOOL_CALL_END"
  );
}

function isAssistantContent(chunk: JsonValue): boolean {
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
    return false;
  }
  const type = chunk["type"];
  return (
    typeof type === "string" &&
    ["TEXT_MESSAGE_", "TOOL_CALL_", "REASONING_", "THINKING_"].some((prefix) =>
      type.startsWith(prefix),
    )
  );
}

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

type EngineAttempt =
  | RunStageResult
  | { readonly kind: "resume-rejected"; readonly code: string; readonly detail: string };

export async function executeEngineStage(deps: WorkflowDeps, run: Run): Promise<RunStageResult> {
  const kind = run.engine === "script" ? undefined : run.engine;
  const engine = kind === undefined ? undefined : deps.engines.get(kind);
  if (kind === undefined || !engine) {
    return {
      kind: "failed",
      code: "engine.not_configured",
      detail: `Engine "${run.engine}" is not registered on this server.`,
    };
  }

  const earlier = await readEarlierExecution(deps, run);
  if (earlier.outcome !== undefined) {
    return earlier.outcome;
  }
  if (earlier.keySuffix !== "") {
    // Tells stream readers to drop the abandoned attempt's output before the new attempt's.
    await deps.store.appendRunEvents(run.id, [
      {
        chunkKey: `${run.id}:attempt-reset${earlier.keySuffix}`,
        chunk: { type: "CUSTOM", name: ATTEMPT_RESET_EVENT },
      },
    ]);
  }

  try {
    const first = await runEngineAttempt(deps, run, engine, kind, earlier.keySuffix);
    if (first.kind !== "resume-rejected") {
      return first;
    }
    deps.store.dropEngineSession(run.sessionId, kind);
    const rebuilt = await runEngineAttempt(deps, run, engine, kind, earlier.keySuffix);
    return rebuilt.kind === "resume-rejected"
      ? { kind: "failed", code: rebuilt.code, detail: rebuilt.detail }
      : rebuilt;
  } finally {
    deps.turns?.delete(run.id);
  }
}

/**
 * What an earlier execution of this Run's engine step left in the run events. A persisted
 * terminal chunk means the engine already answered: its outcome is replayed instead of calling
 * the engine again. Otherwise a non-empty log gets a key suffix so the new attempt's chunks never
 * dedupe against the abandoned attempt's.
 */
async function readEarlierExecution(
  deps: WorkflowDeps,
  run: Run,
): Promise<{ readonly outcome?: RunStageResult; readonly keySuffix: string }> {
  const events: RunEvent[] = [];
  for await (const event of deps.store.replay(run.id, 0)) {
    events.push(event);
  }
  const last = events.at(-1);
  if (last === undefined) {
    return { keySuffix: "" };
  }
  const terminal = events.find((event) => event.isTerminal === true);
  if (terminal === undefined) {
    return { keySuffix: `:replay-${last.sequence}` };
  }

  const chunk = isJsonRecord(terminal.chunk) ? terminal.chunk : {};
  if (chunk["type"] !== "RUN_FINISHED") {
    return {
      keySuffix: "",
      outcome: {
        kind: "failed",
        code: typeof chunk["code"] === "string" ? chunk["code"] : "engine.run_error",
        detail: typeof chunk["message"] === "string" ? chunk["message"] : "Engine run failed.",
      },
    };
  }
  const suffix = attemptKeySuffix(run.id, terminal.chunkKey);
  const text = events
    .filter((event) => attemptKeySuffix(run.id, event.chunkKey) === suffix)
    .flatMap((event) =>
      isJsonRecord(event.chunk) &&
      event.chunk["type"] === "TEXT_MESSAGE_CONTENT" &&
      typeof event.chunk["delta"] === "string"
        ? [event.chunk["delta"]]
        : [],
    )
    .join("");
  const usage = readRunUsage(chunk);
  return {
    keySuffix: "",
    outcome: {
      kind: "completed",
      ...(text.length > 0 ? { finalMessageParts: [{ type: "text", text }] } : {}),
      ...(usage !== undefined ? { usage } : {}),
    },
  };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Engine chunk keys are `<runId>:<seq>:<TYPE><suffix>`; the suffix names the attempt. */
function attemptKeySuffix(runId: RunId, chunkKey: string): string | undefined {
  const match = /^\d+:[A-Z_]+(.*)$/.exec(chunkKey.slice(runId.length + 1));
  return match?.[1];
}

async function runEngineAttempt(
  deps: WorkflowDeps,
  run: Run,
  engine: Engine,
  kind: EngineKind,
  keySuffix: string,
): Promise<EngineAttempt> {
  const batchSize = deps.eventBatchSize ?? DEFAULT_EVENT_BATCH_SIZE;
  const pendingChunks: {
    readonly chunkKey: string;
    readonly chunk: JsonValue;
    readonly isTerminal?: boolean;
  }[] = [];
  let observedSessionId: string | undefined;
  let sawContent = false;

  const turnOutcome = (): TurnOutcome | undefined => {
    const turn = deps.turns?.get(run.id);
    if (turn === undefined) {
      return undefined;
    }
    return {
      contextMode: turn.contextMode,
      ...(turn.saveable && observedSessionId !== undefined
        ? {
            save: {
              sessionId: run.sessionId,
              engine: kind,
              vendorSessionId: observedSessionId,
              baseHash: turn.baseHash,
              contextHash: turn.contextHash,
              lastOrdinal: turn.lastOrdinal,
            },
          }
        : {}),
    };
  };

  // A resumed attempt buffers its chunks until the vendor confirms the session and the first
  // assistant content arrives: Antigravity echoes an unknown id and rejects only the prompt. A
  // rejected resume leaves nothing in the run events and the rebuild's chunks do not collide.
  const isAwaitingResumeConfirmation = (): boolean => {
    const resumedFrom = deps.turns?.get(run.id)?.resumedFrom;
    return resumedFrom !== undefined && (observedSessionId !== resumedFrom || !sawContent);
  };

  const readInterruptedStage = async (
    fallbackDetail?: string,
  ): Promise<RunStageResult | undefined> => {
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
        observedSessionId = readSessionIdChunk(event.chunk) ?? observedSessionId;
        sawContent ||= isAssistantContent(event.chunk);
        pendingChunks.push({
          chunkKey: `${event.chunkKey}${keySuffix}`,
          chunk: event.chunk,
          ...(event.isTerminal !== undefined ? { isTerminal: event.isTerminal } : {}),
        });
        if (
          !isAwaitingResumeConfirmation() &&
          (pendingChunks.length >= batchSize || isToolCallEnd(event.chunk))
        ) {
          await flush();
        }
        continue;
      }

      if (
        event.type === "failed" &&
        event.code === "engine.resume_unavailable" &&
        isAwaitingResumeConfirmation()
      ) {
        return { kind: "resume-rejected", code: event.code, detail: event.detail };
      }

      await flush();

      if (event.type === "completed") {
        const postInterrupted = await readInterruptedStage();
        if (postInterrupted) {
          return postInterrupted;
        }
        const turn = turnOutcome();
        return {
          kind: "completed",
          ...(event.finalMessage ? { finalMessageParts: event.finalMessage.parts } : {}),
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(turn !== undefined ? { turn } : {}),
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
    readonly outcome: RunStageResult;
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
      ...(input.outcome.usage !== undefined ? { usage: input.outcome.usage } : {}),
      ...(input.outcome.turn !== undefined ? { contextMode: input.outcome.turn.contextMode } : {}),
      ...(input.outcome.turn?.save !== undefined ? { engineSession: input.outcome.turn.save } : {}),
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
