import {
  DomainError,
  runUsage,
  streamChunk,
  type Approval,
  type ApprovalEffectStore,
  type ApprovalId,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type EffectId,
  type EffectIdentity,
  type Engine,
  type EngineKind,
  type EngineSessionInput,
  type FinishRunInput,
  type FinishRunOutcome,
  type JsonValue,
  type MessagePart,
  type Run,
  type RunAdmission,
  type RunEnd,
  type RunEvent,
  type RunEventInput,
  type RunId,
  type RunRequest,
  type RunStore,
  type RunUsage,
  type UtcTimestamp,
  type Workflow,
} from "@der/domain";
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

export type WorkflowStore = RunStore & ApprovalEffectStore;

/**
 * The engine session a resumable engine's turn will leave, as planned by the context loader; the
 * engine step completes it with the vendor session the turn ended on.
 */
export type TurnRecord = Omit<EngineSessionInput, "vendorSessionId">;

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

type RunFinishDeps = Pick<WorkflowDeps, "onRunFinished"> & {
  readonly store: Pick<RunStore, "finishRun">;
};

/** Only the finish that ended the Run notifies; a later one returns the stored Run unchanged. */
async function finishRunAndNotify(
  deps: Pick<RunFinishDeps, "store" | "onRunFinished">,
  input: FinishRunInput,
): Promise<FinishRunOutcome> {
  const finished = await deps.store.finishRun(input);
  if (finished.won) {
    await deps.onRunFinished?.(finished.run);
  }
  return finished;
}

export type RunStageResult =
  | {
      readonly kind: "completed";
      readonly finalMessageParts?: readonly MessagePart[];
      readonly usage?: RunUsage;
      readonly engineSession?: EngineSessionInput;
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
const ENGINE_ATTEMPT_FINISHED_EVENT = "der.engine-attempt-finished";
const TRANSIENT_ATTEMPT_FAILURES = new Set([
  "engine.resume_unavailable",
  "engine.transport_lost",
  "engine.cancelled",
]);

function isToolCallEnd(chunk: JsonValue): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    !Array.isArray(chunk) &&
    chunk["type"] === "TOOL_CALL_END"
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
        chunk: streamChunk({ type: "CUSTOM", name: ATTEMPT_RESET_EVENT }),
      },
    ]);
  }

  try {
    const first = await runEngineAttempt(deps, run, engine, earlier.keySuffix);
    // The refused attempt's plan took the stored session, so planning again rebuilds.
    return first.kind === "failed" && first.code === "engine.resume_unavailable"
      ? await runEngineAttempt(deps, run, engine, earlier.keySuffix)
      : first;
  } finally {
    deps.turns?.delete(run.id);
  }
}

/**
 * What an earlier execution of this Run's engine step left in the run events. A persisted
 * `der.engine-attempt-finished` marker means the engine already finished an attempt: its outcome
 * is replayed instead of calling the engine again. Otherwise a non-empty log gets a key suffix so
 * the new attempt's chunks never dedupe against the abandoned attempt's.
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
  const finished = events.find(
    (event) =>
      isJsonRecord(event.chunk) &&
      event.chunk["type"] === "CUSTOM" &&
      event.chunk["name"] === ENGINE_ATTEMPT_FINISHED_EVENT,
  );
  if (finished === undefined) {
    return { keySuffix: `:replay-${last.sequence}` };
  }

  const chunk = isJsonRecord(finished.chunk) ? finished.chunk : {};
  const value = isJsonRecord(chunk["value"]) ? chunk["value"] : {};
  if (value["kind"] !== "completed") {
    return {
      keySuffix: "",
      outcome: {
        kind: "failed",
        code: typeof value["code"] === "string" ? value["code"] : "engine.run_error",
        detail: typeof value["detail"] === "string" ? value["detail"] : "Engine run failed.",
      },
    };
  }
  const suffix =
    typeof value["suffix"] === "string"
      ? value["suffix"]
      : chunkAttemptSuffix(run.id, finished.chunkKey);
  const text = events
    .filter((event) => chunkAttemptSuffix(run.id, event.chunkKey) === suffix)
    .flatMap((event) =>
      isJsonRecord(event.chunk) &&
      event.chunk["type"] === "TEXT_MESSAGE_CONTENT" &&
      typeof event.chunk["delta"] === "string"
        ? [event.chunk["delta"]]
        : [],
    )
    .join("");
  const parsedUsage = value["usage"] !== undefined ? runUsage.safeParse(value["usage"]) : undefined;
  const usage = parsedUsage?.success ? parsedUsage.data : undefined;
  return {
    keySuffix: "",
    outcome: {
      kind: "completed",
      ...(text.length > 0 ? { finalMessageParts: [{ type: "text", text }] } : {}),
      ...(usage !== undefined ? { usage } : {}),
    },
  };
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Engine chunk keys carry an optional `:replay-<seq>` suffix naming the attempt. */
function chunkAttemptSuffix(runId: RunId, chunkKey: string): string {
  const rest = chunkKey.startsWith(`${runId}:`) ? chunkKey.slice(runId.length + 1) : chunkKey;
  const at = rest.indexOf(":replay-");
  return at >= 0 ? rest.slice(at) : "";
}

async function runEngineAttempt(
  deps: WorkflowDeps,
  run: Run,
  engine: Engine,
  keySuffix: string,
): Promise<RunStageResult> {
  const batchSize = deps.eventBatchSize ?? DEFAULT_EVENT_BATCH_SIZE;
  const pendingChunks: RunEventInput[] = [];

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

  const appendAttemptFinished = async (
    outcome:
      | { readonly kind: "completed"; readonly usage?: RunUsage }
      | { readonly kind: "failed"; readonly code: string; readonly detail: string },
  ) => {
    const currentStatus = (await deps.store.getRun(run.id))?.status;
    if (
      currentStatus !== "queued" &&
      currentStatus !== "running" &&
      currentStatus !== "waiting_approval"
    ) {
      return;
    }
    const value: { [key: string]: JsonValue } = {
      kind: outcome.kind,
      suffix: keySuffix,
      ...(outcome.kind === "completed" && outcome.usage !== undefined
        ? {
            usage: {
              inputTokens: outcome.usage.inputTokens,
              cachedInputTokens: outcome.usage.cachedInputTokens,
              cacheWriteTokens: outcome.usage.cacheWriteTokens,
              outputTokens: outcome.usage.outputTokens,
              reportedCostUsd: outcome.usage.reportedCostUsd,
            },
          }
        : {}),
      ...(outcome.kind === "failed" ? { code: outcome.code, detail: outcome.detail } : {}),
    };
    await deps.store.appendRunEvents(run.id, [
      {
        chunkKey: `${run.id}:engine-attempt-finished${keySuffix}`,
        chunk: streamChunk({
          type: "CUSTOM",
          name: ENGINE_ATTEMPT_FINISHED_EVENT,
          value,
        }),
      },
    ]);
  };

  try {
    for await (const event of engine.run(run)) {
      const interrupted = await readInterruptedStage();
      if (interrupted) {
        return interrupted;
      }

      if (event.type === "chunk") {
        // finishRun writes the terminal chunk with the status that wins, so an interruption
        // committing after the engine's own RUN_FINISHED cannot leave a contradicting stream.
        const chunk = streamChunk(event.chunk);
        if (event.isTerminal || chunk === undefined) {
          continue;
        }
        pendingChunks.push({ chunkKey: `${event.chunkKey}${keySuffix}`, chunk });
        if (pendingChunks.length >= batchSize || isToolCallEnd(event.chunk)) {
          await flush();
        }
        continue;
      }

      await flush();

      if (event.type === "completed") {
        const postInterrupted = await readInterruptedStage();
        if (postInterrupted) {
          return postInterrupted;
        }
        await appendAttemptFinished({
          kind: "completed",
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
        });
        const turn = deps.turns?.get(run.id);
        return {
          kind: "completed",
          ...(event.finalMessage ? { finalMessageParts: event.finalMessage.parts } : {}),
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(turn !== undefined && event.vendorSessionId !== undefined
            ? { engineSession: { ...turn, vendorSessionId: event.vendorSessionId } }
            : {}),
        };
      }

      const failInterrupted = await readInterruptedStage(event.detail);
      if (failInterrupted) {
        return failInterrupted;
      }
      if (!TRANSIENT_ATTEMPT_FAILURES.has(event.code)) {
        await appendAttemptFinished({
          kind: "failed",
          code: event.code,
          detail: event.detail,
        });
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
  await appendAttemptFinished({ kind: "completed" });
  return { kind: "completed" };
}

export function approvalRequestedEvent(approval: Approval): RunEventInput {
  return {
    chunkKey: `${approval.runId}:approval:${approval.id}:requested`,
    chunk: streamChunk({
      type: "CUSTOM",
      name: "approval.requested",
      value: {
        approvalId: approval.id,
        operationKind: approval.effect.operationKind,
        operationId: approval.effect.operationId,
        prompt: approval.prompt,
        deadline: approval.deadline,
      },
    }),
  };
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

  await deps.store.appendRunEvents(input.run.id, [approvalRequestedEvent(result.approval)]);

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
  deps: RunFinishDeps,
  input: {
    readonly run: Run;
    readonly effectId: EffectId;
    readonly detail: string;
  },
): Promise<Run> {
  const finished = await finishRunAndNotify(deps, {
    runId: input.run.id,
    end: { kind: "interrupt", detail: input.detail, effectId: input.effectId },
  });
  return finished.run;
}

function runEnd(outcome: RunStageResult): RunEnd {
  switch (outcome.kind) {
    case "completed":
      return {
        kind: "complete",
        ...(outcome.finalMessageParts !== undefined
          ? { finalMessageParts: outcome.finalMessageParts }
          : {}),
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(outcome.engineSession !== undefined ? { engineSession: outcome.engineSession } : {}),
      };
    case "interrupted":
      return {
        kind: "interrupt",
        detail: outcome.detail,
        ...(outcome.effectId !== undefined ? { effectId: outcome.effectId } : {}),
      };
    case "failed":
      return { kind: "fail", code: outcome.code, detail: outcome.detail };
  }
}

export async function finalizeDirectRunStep(
  deps: WorkflowDeps,
  input: {
    readonly run: Run;
    readonly outcome: RunStageResult;
  },
): Promise<Run> {
  const finished = await finishRunAndNotify(deps, {
    runId: input.run.id,
    end: runEnd(input.outcome),
  });
  return finished.run;
}
