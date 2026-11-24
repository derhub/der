import {
  DomainError,
  formatUtcTimestamp,
  type Approval,
  type ApprovalEffectStore,
  type BotStore,
  type CapabilityPolicy,
  type Catalog,
  type EffectIdentity,
  type EffectRecord,
  type ExecuteErrorKind,
  type JsonValue,
  type NewStep,
  type Run,
  type RunStore,
  type ScriptExecution,
  type ScriptStore,
  type StepOutcome,
  type StoredStep,
  type TerminalScriptRunStatus,
  resolvePolicy,
} from "@der/domain";
import {
  startScript,
  type ScriptDrain,
  type ScriptSession,
  type SessionLimits,
  type StepRequest,
  type StepResult,
} from "@der/runtime";
import { fingerprintJson } from "@der/storage";
import { approvalRequestedEvent } from "../workflows/run-steps";

export interface ScriptExecutionDeps {
  readonly store: ApprovalEffectStore & Pick<RunStore, "getRun" | "appendRunEvents" | "finishRun">;
  readonly scripts: ScriptStore;
  readonly bots: Pick<BotStore, "getBot">;
  readonly catalog: Catalog;
  readonly limits: SessionLimits & {
    readonly maxSteps: number;
    readonly maxInFlight: number;
    readonly outputBytes: number;
  };
  readonly approvalTimeoutMs: number;
  readonly now: () => Date;
  /** How long cancellation waits for a write already in flight; defaults to 10 seconds. */
  readonly writeCancelGraceMs?: number;
}

export const RUN_ENDED = new Set<Run["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const WRITE_CANCEL_GRACE_MS = 10_000;
const RESULT_DEPTH = 256;

export function routineScriptId(run: Run): string | undefined {
  const { checkpoint } = run;
  if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return undefined;
  }
  const id = checkpoint["scriptRunId"];
  return typeof id === "string" ? id : undefined;
}

export function scriptApprovalOwner(awakeable: string): string | undefined {
  return awakeable.startsWith("script:") ? awakeable.slice("script:".length) : undefined;
}

export function approvalId(id: string, position: number): string {
  return `appr_${id}_${position}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function effectOf(head: ScriptExecution, step: StoredStep): EffectIdentity {
  return {
    runId: head.runId,
    operationKind: "capability",
    operationId: step.capability,
    canonicalArguments: step.input,
    attemptId: `${head.id}:${step.position}`,
  };
}

function stepFailure(
  step: StoredStep,
  kind: "failed" | "denied" | "expired" | "refused",
  message: string,
  status: "failed" | "unknown" | "skipped" = "failed",
): StepOutcome {
  return {
    status,
    error: { kind, message, step: step.position, capability: step.capability, input: step.input },
  };
}

function replyOf(step: StoredStep): StepResult {
  if (step.status === "done") {
    return { position: step.position, ok: true, value: step.result };
  }
  const error = step.error as { kind: string; message: string };
  return { position: step.position, ok: false, error };
}

function errorKind(kind: string): ExecuteErrorKind {
  switch (kind) {
    case "limit":
    case "denied":
    case "expired":
    case "script":
      return kind;
    case "failed":
    case "refused":
      return "capability";
    default:
      return "script";
  }
}

function storable(value: JsonValue, depth = 0): boolean {
  if (depth > RESULT_DEPTH) return false;
  return (
    value === null ||
    typeof value !== "object" ||
    Object.values(value).every((child) => storable(child, depth + 1))
  );
}

function deliveryBatches(steps: readonly StoredStep[]): StoredStep[][] {
  const batches: StoredStep[][] = [];
  const delivered = steps
    .filter((step) => step.seq !== null)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const step of delivered) {
    const last = batches.at(-1);
    if (last?.[0]?.batch === step.batch && last !== undefined) {
      last.push(step);
    } else {
      batches.push([step]);
    }
  }
  return batches;
}

class ScriptRefused extends Error {
  constructor(
    readonly kind: ExecuteErrorKind,
    message: string,
    readonly call?: string,
    readonly line?: number,
    /** The end of the execution adds what its writes did to the message. */
    readonly reportsWrites = false,
  ) {
    super(message);
  }
}

class ScriptPass {
  readonly #rows: Map<number, StoredStep>;
  readonly #requested = new Set<number>();
  readonly #announced = new Set<string>();
  readonly #ready: StoredStep[] = [];
  #wake = Promise.withResolvers<void>();
  readonly #notify = () => this.#wake.resolve();
  #acceptWork = true;
  readonly #work = new Map<number, Promise<void>>();
  readonly #descriptors: Map<string, "read" | "write">;
  readonly #logs: string[] = [];
  #inFlight = 0;
  #round: number;
  #writing = false;
  #failure: { error: unknown } | undefined;

  constructor(
    readonly deps: ScriptExecutionDeps,
    readonly head: ScriptExecution,
    steps: readonly StoredStep[],
    readonly guard: () => void,
    readonly signal: AbortSignal,
    readonly changes: EventTarget,
  ) {
    this.#rows = new Map(steps.map((step) => [step.position, step]));
    this.#round = Math.max(0, ...steps.map((step) => step.round ?? 0)) + 1;
    this.#descriptors = new Map(deps.catalog.list().map(({ id, effect }) => [id, effect]));
  }

  async run(steps: readonly StoredStep[]): Promise<void> {
    const run = await this.#owningRun();
    if (run === undefined) {
      await this.#cancel();
      return;
    }
    if (run.engine === "script" && routineScriptId(run) !== this.head.id) {
      return;
    }
    const session = startScript(this.head.source, {
      seed: this.head.seed,
      now: Date.parse(this.head.createdAt),
      limits: this.deps.limits,
    });

    this.signal.addEventListener("abort", this.#notify, { once: true });
    this.changes.addEventListener("change", this.#notify);
    try {
      this.guard();
      let drain = await session.started;
      const batches = deliveryBatches(steps);
      for (const batch of batches) {
        await this.#absorb(drain, true);
        for (const step of batch) {
          if (!this.#requested.has(step.position)) {
            throw this.#mismatch(
              `step ${step.position} was not requested before its recorded delivery`,
            );
          }
        }
        this.#inFlight -= batch.length;
        drain = await session.deliver(batch.map(replyOf));
      }
      await this.#absorb(drain, false);
      for (const step of steps) {
        if (!this.#requested.has(step.position)) {
          throw this.#mismatch(
            `stored step ${step.position} (${step.capability}) was not requested`,
          );
        }
        if (step.seq === null && (step.status === "done" || step.status === "failed")) {
          this.#ready.push(step);
        }
      }

      if (this.#ready.length > 0) {
        drain = await this.#deliverReady(session);
        await this.#absorb(drain, false);
      }

      for (;;) {
        this.#wake = Promise.withResolvers<void>();
        this.guard();
        this.#throwHostFailure();
        if ((await this.#owningRun()) === undefined) {
          await this.#cancel();
          return;
        }
        this.#startReads();
        const { ask, writes, waiting } = await this.#planWrites();
        this.#throwHostFailure();
        this.#startWrite(writes[0]);
        if (this.#ready.length > 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          this.guard();
          this.#throwHostFailure();
          drain = await this.#deliverReady(session);
          await this.#absorb(drain, false);
          continue;
        }
        if (ask.length > 0) {
          await this.#ask(run, ask);
          continue;
        }
        if (this.#work.size > 0) {
          await this.#wake.promise;
          continue;
        }
        if (waiting) {
          return;
        }
        await this.#settle(drain);
        return;
      }
    } catch (error) {
      if (!(error instanceof ScriptRefused)) {
        throw error;
      }
      await this.#drainWork();
      await this.#end(
        "failed",
        error.kind,
        error.message,
        error.call,
        error.line,
        error.reportsWrites,
      );
    } finally {
      this.#acceptWork = false;
      this.signal.removeEventListener("abort", this.#notify);
      this.changes.removeEventListener("change", this.#notify);
      session.dispose();
    }
  }

  #deliverReady(session: ScriptSession): Promise<ScriptDrain> {
    this.guard();
    const ready = this.#ready.splice(0);
    this.deps.scripts.markDelivered(
      this.head.id,
      ready.map(({ position }) => position),
    );
    this.#inFlight -= ready.length;
    return session.deliver(ready.map(replyOf));
  }

  async #owningRun(): Promise<Run | undefined> {
    const run = await this.deps.store.getRun(this.head.runId);
    this.guard();
    if (run === undefined) {
      return undefined;
    }
    return RUN_ENDED.has(run.status) && !this.#isDetached() ? undefined : run;
  }

  #isDetached(): boolean {
    return this.deps.scripts.load(this.head.id).execution.detachedAt !== null;
  }

  #mismatch(detail: string): ScriptRefused {
    return new ScriptRefused(
      "nondeterministic",
      `the Script did not repeat itself: ${detail}`,
      undefined,
      undefined,
      true,
    );
  }

  #applied(): string {
    const writes = (status: StoredStep["status"]) =>
      [...this.#rows.values()]
        .filter((step) => step.effect === "write" && step.status === status)
        .map((step) => `#${step.position} ${step.capability}`)
        .join(", ");
    const applied = writes("done");
    const unknown = writes("unknown");
    if (unknown === "") {
      return `Already applied: ${applied || "nothing"}.`;
    }
    return `Already applied: ${applied || "none confirmed"}. Unknown outcome: ${unknown}.`;
  }

  async #absorb(drain: ScriptDrain, replaying: boolean): Promise<void> {
    for (const line of drain.logs) this.#logs.push(line);
    if (drain.fatal && drain.error !== undefined) {
      const { kind, message, line } = drain.error;
      throw new ScriptRefused(errorKind(kind), message, undefined, line, kind === "limit");
    }
    if (drain.orphans?.length) {
      throw this.#mismatch(`no pending call for recorded step ${drain.orphans[0]}`);
    }

    const { maxSteps, maxInFlight } = this.deps.limits;
    const fresh = drain.requests.filter(({ position }) => !this.#rows.has(position)).length;
    if (replaying && fresh > 0) {
      throw this.#mismatch("a new step was requested before the recorded deliveries were replayed");
    }
    if (
      this.#rows.size + fresh > maxSteps ||
      this.#inFlight + drain.requests.length > maxInFlight
    ) {
      const limit =
        this.#rows.size + fresh > maxSteps
          ? `step limit of ${maxSteps}`
          : `in-flight step limit of ${maxInFlight}`;
      throw new ScriptRefused("limit", `${limit} exceeded`, undefined, undefined, true);
    }
    if (drain.requests.length === 0) {
      return;
    }
    const policy = (await this.deps.bots.getBot(this.head.botId))?.capabilityPolicy ?? {};
    this.guard();
    const requested = await Promise.all(
      drain.requests.map((request) => this.#prepare(request, policy)),
    );
    this.guard();
    const stored = this.deps.scripts.registerSteps(this.head.id, requested);
    for (const [index, row] of stored.entries()) {
      this.#compare(row, requested[index]!);
      this.#rows.set(row.position, row);
      this.#requested.add(row.position);
    }
    this.#inFlight += drain.requests.length;
  }

  async #prepare(request: StepRequest, policy: CapabilityPolicy): Promise<NewStep> {
    const { position, id, input } = request;
    const inputHash = await fingerprintJson(input);
    const stored = this.#rows.get(position);
    if (stored !== undefined) {
      this.#compare(stored, { position, capability: id, inputHash });
      const declared = this.#descriptors.get(id);
      if (declared === undefined) {
        throw this.#mismatch(
          `step ${position} (${id}) was recorded but the capability no longer exists`,
        );
      }
      if (declared !== stored.effect) {
        throw this.#mismatch(
          `step ${position} (${id}) was recorded as a ${stored.effect} and is now declared ${declared}`,
        );
      }
      const { round, ...request } = stored;
      return { ...request, ...(round === null ? {} : { round }) };
    }
    const effect = this.#descriptors.get(id);
    if (effect === undefined) {
      throw new ScriptRefused("capability", `Unknown capability "${id}" at step ${position}.`, id);
    }
    try {
      this.deps.catalog.validateInput(id, input);
      const declaredAsks = effect === "write" && this.deps.catalog.requiresApproval(id, input);
      const decision = resolvePolicy(policy, id, effect, declaredAsks);
      return {
        position,
        capability: id,
        inputHash,
        input,
        effect,
        decision,
        ...(decision === "ask" ? { round: this.#round } : {}),
      };
    } catch (error) {
      throw new ScriptRefused("capability", `Step ${position}: ${messageOf(error)}`, id);
    }
  }

  #compare(row: StoredStep, request: Pick<NewStep, "position" | "capability" | "inputHash">): void {
    if (
      row.position !== request.position ||
      row.capability !== request.capability ||
      row.inputHash !== request.inputHash
    ) {
      throw this.#mismatch(
        `step ${request.position} requested ${request.capability} with different capability or input than the stored ${row.capability}`,
      );
    }
  }

  #throwHostFailure(): void {
    if (this.#failure !== undefined) {
      throw this.#failure.error;
    }
  }

  #guardWork(): void {
    this.guard();
    if (!this.#acceptWork) {
      throw new Error(`The pass for Script execution ${this.head.id} has ended`);
    }
  }

  #start(step: StoredStep, work: () => Promise<void>): void {
    const pending = work()
      .catch((error: unknown) => {
        this.#failure ??= { error };
      })
      .finally(() => {
        this.#work.delete(step.position);
        this.#notify();
      });
    this.#work.set(step.position, pending);
  }

  #startReads(): void {
    for (const step of this.#rows.values()) {
      if (step.effect === "read" && step.status === "pending" && !this.#work.has(step.position)) {
        if (step.decision === "deny") {
          this.#complete(step, stepFailure(step, "refused", "Capability denied by policy"));
          continue;
        }
        this.#start(step, async () => {
          let outcome: StepOutcome;
          try {
            const result = await this.deps.catalog.invoke(step.capability, step.input, {
              botId: this.head.botId,
              signal: this.signal,
            });
            outcome = { status: "done", result };
          } catch (error) {
            outcome = stepFailure(step, "failed", messageOf(error));
          }
          this.#complete(step, outcome);
        });
      }
    }
  }

  async #planWrites(): Promise<{ ask: StoredStep[]; writes: StoredStep[]; waiting: boolean }> {
    const ask: StoredStep[] = [];
    const writes: StoredStep[] = [];
    let waiting = false;
    for (const step of this.#rows.values()) {
      if (step.effect !== "write" || step.status !== "pending" || this.#work.has(step.position)) {
        continue;
      }
      if (step.decision === "deny") {
        this.#complete(step, stepFailure(step, "refused", "Capability denied by policy"));
        continue;
      }
      const approval =
        step.decision === "ask"
          ? await this.deps.store.getApproval(approvalId(this.head.id, step.position))
          : undefined;
      this.guard();
      if (approval !== undefined) {
        await this.#announce(approval);
      }
      switch (approval?.decision.status) {
        case "pending":
          waiting = true;
          break;
        case "denied":
        case "expired": {
          const kind = approval.decision.status;
          this.#complete(
            step,
            stepFailure(
              step,
              kind,
              `approval for write ${step.position} (${step.capability}) was ${kind}`,
            ),
          );
          break;
        }
        case "approved":
          writes.push(step);
          break;
        default:
          (step.decision === "ask" ? ask : writes).push(step);
      }
    }
    writes.sort((a, b) => a.position - b.position);
    return { ask, writes, waiting };
  }

  async #ask(run: Run, steps: readonly StoredStep[]): Promise<void> {
    const deadline = formatUtcTimestamp(
      new Date(this.deps.now().getTime() + this.deps.approvalTimeoutMs),
    );
    for (const step of steps) {
      this.guard();
      const { approval } = await this.deps.store.requestApproval({
        id: approvalId(this.head.id, step.position),
        botId: this.head.botId,
        sessionId: run.sessionId,
        runId: run.id,
        effect: effectOf(this.head, step),
        awakeable: `script:${this.head.id}`,
        prompt: `Script wants to call ${step.capability} with ${JSON.stringify(step.input).slice(0, 400)}`,
        deadline,
      });
      await this.#announce(approval);
    }
    this.#round += 1;
  }

  async #announce(approval: Approval): Promise<void> {
    if (!this.#announced.has(approval.id)) {
      this.guard();
      try {
        await this.deps.store.appendRunEvents(approval.runId, [approvalRequestedEvent(approval)]);
      } catch (error) {
        const endedRun = error instanceof DomainError && error.code === "run.already_terminal";
        if (!endedRun || !this.#isDetached()) {
          throw error;
        }
      }
      this.#announced.add(approval.id);
    }
  }

  #startWrite(step: StoredStep | undefined): void {
    if (this.#writing || step === undefined) {
      return;
    }
    this.#writing = true;
    this.#start(step, async () => {
      try {
        await this.#write(step);
      } finally {
        this.#writing = false;
      }
    });
  }

  async #write(step: StoredStep): Promise<void> {
    const { store, catalog } = this.deps;
    const effect = effectOf(this.head, step);
    this.#guardWork();
    let begin: Awaited<ReturnType<ApprovalEffectStore["beginEffect"]>>;
    try {
      begin = await store.beginEffect(effect, {
        scriptExecutionId: this.head.id,
        ...(step.decision === "ask" ? { approvalId: approvalId(this.head.id, step.position) } : {}),
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === "effect.prior_write_in_doubt") {
        this.#complete(step, stepFailure(step, "failed", error.message));
        return;
      }
      if (error instanceof DomainError && error.code === "effect.run_ended") {
        return;
      }
      throw new ScriptRefused(
        "capability",
        `Could not begin write ${step.position}: ${messageOf(error)}`,
        step.capability,
      );
    }
    this.#guardWork();
    if (begin.kind === "ambiguous") {
      const effect = await store.markEffectUnknown(begin.effect.id);
      this.#complete(
        step,
        this.#effectOutcome(
          step,
          effect,
          "a previous attempt started this write and its outcome was not recorded",
        ),
      );
      return;
    }
    if (begin.kind === "completed") {
      this.#complete(step, this.#effectOutcome(step, begin.effect));
      return;
    }

    let outcome: { ok: true; value: JsonValue } | { ok: false; message: string };
    try {
      const value = await catalog.invoke(step.capability, step.input, {
        botId: this.head.botId,
        effect,
        signal: this.signal,
      });
      outcome = { ok: true, value };
    } catch (error) {
      this.#guardWork();
      if (!(error instanceof DomainError)) {
        const effect = await store.markEffectUnknown(begin.effect.id);
        this.#complete(step, this.#effectOutcome(step, effect, messageOf(error)));
        return;
      }
      outcome = { ok: false, message: error.message };
    }
    this.#guardWork();
    const recorded = await store.completeEffect(begin.effect.id, outcome);
    this.#complete(step, this.#effectOutcome(step, recorded));
  }

  #effectOutcome(
    step: StoredStep,
    effect: EffectRecord,
    reason = "the write outcome was not recorded",
  ): StepOutcome {
    if (effect.status === "unknown") {
      return stepFailure(step, "failed", reason, "unknown");
    }
    const outcome = effect.outcome as { ok: boolean; value?: JsonValue; message?: string } | null;
    return outcome?.ok
      ? { status: "done", result: outcome.value ?? null }
      : stepFailure(step, "failed", outcome?.message ?? "the write failed");
  }

  #complete(step: StoredStep, outcome: StepOutcome): void {
    this.#guardWork();
    this.#storeOutcome(step, outcome);
  }

  #storeOutcome(step: StoredStep, outcome: StepOutcome): void {
    this.guard();
    this.deps.scripts.completeStep(this.head.id, step.position, outcome);
    const completed = {
      ...step,
      status: outcome.status,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
    };
    this.#rows.set(step.position, completed);
    if (completed.status === "done" || completed.status === "failed") {
      this.#ready.push(completed);
    }
  }

  async #settle(drain: ScriptDrain): Promise<void> {
    const doubtful = [...this.#rows.values()].find((step) => step.status === "unknown");
    if (doubtful !== undefined) {
      const detail = doubtful.error as { message: string };
      await this.#end(
        "in_doubt",
        "capability",
        `Write ${doubtful.position} (${doubtful.capability}) has an unknown outcome: ${detail.message}`,
      );
    } else if (drain.error !== undefined) {
      await this.#end(
        "failed",
        errorKind(drain.error.kind),
        drain.error.message,
        drain.error.capability,
      );
    } else if (drain.unobserved[0] !== undefined) {
      const rejected = drain.unobserved[0];
      await this.#end(
        "failed",
        errorKind(rejected.kind),
        `Step ${rejected.position} was started and never awaited, and it was rejected: ${rejected.message}`,
      );
    } else if ("returned" in drain) {
      const result = drain.returned ?? null;
      if (!storable(result)) {
        await this.#end("failed", "script", "script produced a result the host cannot store");
        return;
      }
      this.guard();
      try {
        this.deps.scripts.finish(this.head.id, {
          status: "completed",
          result: { ok: true, result, logs: this.#logs, truncated: false },
        });
      } catch (error) {
        await this.#end("failed", "capability", `Could not finish Script: ${messageOf(error)}`);
      }
    } else {
      await this.#end(
        "failed",
        "script",
        "The Script is waiting for something that is not a step.",
      );
    }
  }

  async #drainWork(): Promise<void> {
    if (this.#work.size === 0) return;
    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    this.signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.guard();
      await Promise.race([
        Promise.all(this.#work.values()),
        stopped.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.deps.writeCancelGraceMs ?? WRITE_CANCEL_GRACE_MS);
        }),
      ]);
      this.guard();
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", stop);
    }
  }

  async #cancel(): Promise<void> {
    await this.#drainWork();
    await this.#end("cancelled", "cancelled", "script cancelled");
  }

  async #withdrawApprovals(): Promise<void> {
    const { store } = this.deps;
    const pending = (await store.listPendingApprovalsForRun?.(this.head.runId)) ?? [];
    for (const approval of pending) {
      if (!approval.effect.attemptId.startsWith(`${this.head.id}:`)) {
        continue;
      }
      this.guard();
      try {
        await store.decide({
          approvalId: approval.id,
          botId: approval.botId,
          sessionId: approval.sessionId,
          runId: approval.runId,
          status: "expired",
          decidedAt: formatUtcTimestamp(this.deps.now()),
        });
      } catch (error) {
        this.guard();
        if ((await store.getApproval(approval.id))?.decision.status === "pending") {
          throw error;
        }
      }
    }
  }

  /**
   * Ends the execution with an error. A write whose outcome is unknown makes the end `in_doubt`
   * whatever the reason for stopping, and the message then says what the writes did.
   */
  async #end(
    reason: TerminalScriptRunStatus,
    kind: ExecuteErrorKind,
    cause: string,
    call?: string,
    line?: number,
    reportsWrites = false,
  ): Promise<void> {
    this.#acceptWork = false;
    await this.#withdrawApprovals();
    for (const step of this.#rows.values()) {
      if (step.effect !== "write" || step.status !== "pending") {
        continue;
      }
      const effect = await this.deps.store.getEffect(effectOf(this.head, step));
      this.guard();
      if (effect === undefined) {
        this.#storeOutcome(step, stepFailure(step, "failed", cause, "skipped"));
        continue;
      }
      const recorded =
        effect.status === "started" ? await this.deps.store.markEffectUnknown(effect.id) : effect;
      this.#storeOutcome(step, this.#effectOutcome(step, recorded, cause));
    }
    const inDoubt = [...this.#rows.values()].some((step) => step.status === "unknown");
    const status = inDoubt ? "in_doubt" : reason;
    const message =
      reportsWrites || (inDoubt && reason !== "in_doubt")
        ? `${cause.replace(/\.$/, "")}. ${this.#applied()}`
        : cause;
    this.guard();
    this.deps.scripts.finish(this.head.id, {
      status,
      result: {
        ok: false,
        error: {
          kind,
          message,
          ...(call === undefined ? {} : { call }),
          ...(line === undefined ? {} : { line }),
        },
        logs: this.#logs,
      },
    });
  }
}

export async function executeScriptRun(
  deps: ScriptExecutionDeps,
  id: string,
  guard: () => void,
  signal: AbortSignal,
  changes: EventTarget,
): Promise<void> {
  const { execution, steps } = deps.scripts.load(id);
  if (execution.result === null) {
    await new ScriptPass(deps, execution, steps, guard, signal, changes).run(steps);
  }
}
