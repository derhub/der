import {
  DomainError,
  executeResult,
  type CapabilityDescriptor,
  type Catalog,
  type EffectId,
  type EffectIdentity,
  type ExecuteResult,
  type JsonValue,
  type Run,
  type TerminalScriptRunStatus,
} from "@der/domain";
import {
  runScript,
  type ScriptCallHalt,
  type ScriptCallReply,
  type ScriptLimits,
  type ScriptResult,
} from "@der/runtime";
import { fingerprintJson, isTerminalScriptRunStatus, type SqliteScriptRuns } from "@der/storage";
import type { CoordinatorDriver, RunCoordinator } from "../workflows/coordinator";
import { finalizeInterruptedUncertainStep, type WorkflowStore } from "../workflows/run-steps";

export interface ScriptExecutionDeps {
  readonly store: WorkflowStore;
  readonly scriptRuns: SqliteScriptRuns;
  readonly catalog: Catalog;
  readonly approvals: Pick<RunCoordinator, "awaitApprovalWithDriver">;
  readonly limits: ScriptLimits;
  readonly now?: () => Date;
}

export interface ScriptExecutionSignals {
  readonly cancel?: AbortSignal;
  readonly attemptEnded?: AbortSignal;
  readonly boundedDriver?: CoordinatorDriver;
}

interface ScriptStart {
  readonly terminal: ExecuteResult | null;
  readonly source: string;
  readonly run: Run | null;
  readonly seed: number;
  readonly now: number;
}

type CallStepResult =
  | { readonly kind: "reply"; readonly reply: ScriptCallReply }
  | { readonly kind: "interrupted"; readonly effectId: EffectId; readonly detail: string };

interface Halt {
  readonly kind: "denied" | "expired" | "cancelled";
  readonly message: string;
  readonly call: string;
}

const HALT_SCRIPT: ScriptCallHalt = { halt: true };
const PROMPT_INPUT_CHARS = 400;
const INPUT_DIGEST_CHARS = 8;

function failure(
  kind: Extract<ExecuteResult, { ok: false }>["error"]["kind"],
  message: string,
  logs: string[] = [],
  call?: string,
): ExecuteResult {
  return { ok: false, error: { kind, message, ...(call === undefined ? {} : { call }) }, logs };
}

export function cancelledResult(): ExecuteResult {
  return failure("cancelled", "script cancelled");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptFor(id: string, input: JsonValue): string {
  const text = JSON.stringify(input) ?? "null";
  const shown = text.length > PROMPT_INPUT_CHARS ? `${text.slice(0, PROMPT_INPUT_CHARS)}...` : text;
  return `Script wants to call ${id} with ${shown}`;
}

function terminalStatusOf(result: ExecuteResult): TerminalScriptRunStatus {
  if (result.ok) {
    return "completed";
  }
  return result.error.kind === "cancelled" ? "cancelled" : "failed";
}

function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length === 0 ? undefined : AbortSignal.any(present);
}

export async function executeScriptRun(
  deps: ScriptExecutionDeps,
  driver: CoordinatorDriver,
  scriptRunId: string,
  signals: ScriptExecutionSignals = {},
): Promise<ExecuteResult | undefined> {
  const nowMs = (): number => (deps.now ? deps.now() : new Date()).getTime();
  const isCancelled = (): boolean => deps.scriptRuns.get(scriptRunId)?.status === "cancelled";
  let ordinal = 0;
  let halt: Halt | undefined;
  let interrupted: { readonly effectId: EffectId; readonly detail: string } | undefined;
  let hostFailure:
    | { readonly error: unknown; readonly effect: EffectIdentity | undefined }
    | undefined;
  let writeInFlight: EffectIdentity | undefined;
  const bounded = signals.boundedDriver ?? driver;

  const start = await bounded.runStep("script-start", async (): Promise<ScriptStart> => {
    const scriptRun = deps.scriptRuns.get(scriptRunId);
    if (!scriptRun) {
      throw new DomainError({
        type: "https://der.invalid/problems/script-run-not-found",
        title: "ScriptRun not found",
        status: 404,
        detail: `ScriptRun ${scriptRunId} does not exist.`,
        instance: `/api/script-runs/${scriptRunId}`,
        code: "script_run.not_found",
      });
    }
    const run = (await deps.store.getRun(scriptRun.runId)) ?? null;
    return {
      terminal: isTerminalScriptRunStatus(scriptRun.status) ? scriptRun.result : null,
      source: scriptRun.source,
      run,
      seed: crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
      now: nowMs(),
    };
  });
  if (start.terminal !== null) {
    return start.terminal;
  }
  if (start.run === null) {
    return finish(failure("capability", "owning Run no longer exists"));
  }
  const run: Run = start.run;
  if (run.status === "interrupted" || run.status === "failed" || run.status === "cancelled") {
    return finish(failure("capability", `owning Run ${run.id} has ended as ${run.status}`));
  }

  const descriptors = new Map<string, CapabilityDescriptor>(
    deps.catalog.list().map((descriptor) => [descriptor.id, descriptor]),
  );
  const callSignal = anySignal([signals.cancel, signals.attemptEnded]);

  const invoke = async (
    id: string,
    input: JsonValue,
    effect: EffectIdentity | undefined,
  ): Promise<JsonValue> =>
    deps.catalog.invoke(id, input, {
      botId: run.botId,
      ...(effect === undefined ? {} : { effect }),
      ...(callSignal === undefined ? {} : { signal: callSignal }),
    });

  const readStep = (name: string, id: string, input: JsonValue): Promise<CallStepResult> =>
    bounded.runStep(name, async (): Promise<CallStepResult> => {
      if (isCancelled()) {
        return {
          kind: "reply",
          reply: {
            ok: false,
            error: { kind: "cancelled", message: "script cancelled" },
            now: nowMs(),
          },
        };
      }
      try {
        return {
          kind: "reply",
          reply: { ok: true, value: await invoke(id, input, undefined), now: nowMs() },
        };
      } catch (error) {
        return {
          kind: "reply",
          reply: {
            ok: false,
            error: { kind: "capability", message: errorMessage(error) },
            now: nowMs(),
          },
        };
      }
    });

  const writeStep = (
    name: string,
    id: string,
    input: JsonValue,
    effect: EffectIdentity,
    approvalId: string | undefined,
  ): Promise<CallStepResult> =>
    driver.runStep(name, async (): Promise<CallStepResult> => {
      if (isCancelled()) {
        return {
          kind: "reply",
          reply: {
            ok: false,
            error: { kind: "cancelled", message: "script cancelled" },
            now: nowMs(),
          },
        };
      }
      await deps.scriptRuns.setStatus(scriptRunId, "running");
      const begin = await deps.store.beginEffect(effect, approvalId ? { approvalId } : undefined);
      if (begin.kind === "completed") {
        return {
          kind: "reply",
          reply: { ...replyFromOutcome(begin.effect.outcome), now: nowMs() },
        };
      }
      if (begin.kind === "ambiguous") {
        await deps.store.markEffectUnknown(begin.effect.id);
        return {
          kind: "interrupted",
          effectId: begin.effect.id,
          detail: `Effect capability:${id} (${effect.attemptId}) had a prior started marker with uncertain outcome.`,
        };
      }
      try {
        const value = await invoke(id, input, effect);
        await deps.store.completeEffect(begin.effect.id, { ok: true, value });
        return { kind: "reply", reply: { ok: true, value, now: nowMs() } };
      } catch (error) {
        if (error instanceof DomainError) {
          await deps.store.completeEffect(begin.effect.id, { ok: false, message: error.message });
          return {
            kind: "reply",
            reply: {
              ok: false,
              error: { kind: "capability", message: error.message },
              now: nowMs(),
            },
          };
        }
        await deps.store.markEffectUnknown(begin.effect.id);
        return { kind: "interrupted", effectId: begin.effect.id, detail: errorMessage(error) };
      }
    });

  const askApproval = async (
    name: string,
    id: string,
    input: JsonValue,
    effect: EffectIdentity,
  ): Promise<{ readonly approvalId: string } | { readonly reply: ScriptCallReply }> => {
    await driver.runStep(`${name}:ask`, () =>
      deps.scriptRuns.setStatus(scriptRunId, "waiting_approval").then(() => null),
    );
    const outcome = await deps.approvals.awaitApprovalWithDriver(
      driver,
      { run, effect, prompt: promptFor(id, input) },
      signals.cancel,
    );
    if (outcome.status === "approved") {
      return { approvalId: outcome.approvalId };
    }
    const cancelled = await driver.runStep(`${name}:settle`, async () => {
      await deps.store.markRunRunning(run.id);
      await deps.scriptRuns.setStatus(scriptRunId, "running");
      return isCancelled();
    });
    const kind = cancelled ? "cancelled" : outcome.status;
    const message = cancelled
      ? "script cancelled"
      : outcome.status === "denied"
        ? `Approval for ${id} was denied`
        : `Approval for ${id} expired`;
    halt = { kind, message, call: id };
    return { reply: { ok: false, error: { kind, message }, now: nowMs() } };
  };

  const serveCall = async (
    id: string,
    input: JsonValue,
  ): Promise<ScriptCallReply | ScriptCallHalt> => {
    ordinal += 1;
    if (halt !== undefined) {
      return { ok: false, error: { kind: "cancelled", message: halt.message } };
    }
    const name = `call-${ordinal}:${id}:${(await fingerprintJson(input)).slice(0, INPUT_DIGEST_CHARS)}`;
    const descriptor = descriptors.get(id);
    let step: CallStepResult;
    if (descriptor?.effect === "write") {
      const effect: EffectIdentity = {
        runId: run.id,
        operationKind: "capability",
        operationId: id,
        canonicalArguments: input,
        attemptId: `${scriptRunId}:${ordinal}`,
      };
      let approvalId: string | undefined;
      const rule = await bounded.runStep(
        `${name}:needs-approval`,
        async (): Promise<
          { readonly needsApproval: boolean } | { readonly failure: string; readonly now: number }
        > => {
          try {
            return { needsApproval: deps.catalog.requiresApproval(id, input) };
          } catch (error) {
            return { failure: errorMessage(error), now: nowMs() };
          }
        },
      );
      if ("failure" in rule) {
        return {
          ok: false,
          error: { kind: "capability", message: rule.failure },
          now: rule.now,
        };
      }
      if (rule.needsApproval) {
        const asked = await askApproval(name, id, input, effect);
        if ("reply" in asked) {
          return asked.reply;
        }
        approvalId = asked.approvalId;
      }
      writeInFlight = effect;
      step = await writeStep(name, id, input, effect, approvalId);
      writeInFlight = undefined;
    } else {
      step = await readStep(name, id, input);
    }
    if (step.kind === "interrupted") {
      interrupted = { effectId: step.effectId, detail: step.detail };
      halt = { kind: "cancelled", message: step.detail, call: id };
      return HALT_SCRIPT;
    }
    return step.reply;
  };

  const call = async (id: string, input: JsonValue): Promise<ScriptCallReply | ScriptCallHalt> => {
    try {
      return await serveCall(id, input);
    } catch (error) {
      hostFailure ??= { error, effect: writeInFlight };
      return HALT_SCRIPT;
    }
  };

  const result = await runScript({
    script: start.source,
    call,
    limits: deps.limits,
    seed: start.seed,
    now: start.now,
    ...(callSignal === undefined ? {} : { signal: callSignal }),
  });
  if (signals.attemptEnded?.aborted) {
    return undefined;
  }
  if (hostFailure !== undefined) {
    await recordInDoubtWrite(hostFailure.effect);
    if (interrupted === undefined) {
      throw hostFailure.error;
    }
  }

  return finish(await settle(result));

  async function recordInDoubtWrite(effect: EffectIdentity | undefined): Promise<void> {
    const recorded = effect === undefined ? undefined : await deps.store.getEffect(effect);
    if (
      recorded !== undefined &&
      (recorded.status === "started" || recorded.status === "unknown")
    ) {
      interrupted = {
        effectId: recorded.id,
        detail: `Effect capability:${recorded.identity.operationId} (${recorded.identity.attemptId}) could not be recorded after the host failed: ${errorMessage(hostFailure?.error)}`,
      };
    }
  }

  async function settle(scripted: ScriptResult): Promise<ExecuteResult> {
    if (interrupted !== undefined) {
      const detail = interrupted;
      await driver.runStep("script-interrupt-run", async () => {
        await deps.store.markEffectUnknown(detail.effectId);
        await finalizeInterruptedUncertainStep(
          deps.now ? { store: deps.store, now: deps.now } : { store: deps.store },
          { run, effectId: detail.effectId, detail: detail.detail },
        );
        return null;
      });
      return failure("capability", detail.detail, scripted.logs);
    }
    if (halt !== undefined && halt.kind !== "cancelled") {
      return failure(halt.kind, halt.message, scripted.logs, halt.call);
    }
    if (halt?.kind === "cancelled" || isCancelled() || signals.cancel?.aborted) {
      return failure("cancelled", "script cancelled", scripted.logs);
    }
    return scripted;
  }

  async function finish(computed: ExecuteResult): Promise<ExecuteResult> {
    const outcome = executeResult.safeParse(computed).success
      ? computed
      : failure("script", "script produced a result the host cannot store");
    const settled = await bounded.runStep("script-finish", async () => {
      const row = await deps.scriptRuns.finish(
        scriptRunId,
        interrupted !== undefined ? "interrupted" : terminalStatusOf(outcome),
        outcome,
      );
      return row.result ?? outcome;
    });
    return settled;
  }
}

function replyFromOutcome(outcome: JsonValue | null): ScriptCallReply {
  if (outcome !== null && typeof outcome === "object" && !Array.isArray(outcome)) {
    if (outcome["ok"] === true) {
      return { ok: true, value: outcome["value"] ?? null };
    }
    if (outcome["ok"] === false && typeof outcome["message"] === "string") {
      return { ok: false, error: { kind: "capability", message: outcome["message"] } };
    }
  }
  return { ok: true, value: null };
}
