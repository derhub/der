import {
  formatUtcTimestamp,
  type Approval,
  type MaybePromise,
  type UtcTimestamp,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type ExecuteResult,
  type JsonValue,
  type RunId,
  type ScriptExecution,
  type StoredStep,
} from "@der/domain";
import { finalizeInterruptedUncertainStep } from "../workflows/run-steps";
import {
  approvalId,
  effectOf,
  executeScriptRun,
  RUN_ENDED,
  scriptApprovalOwner,
  type ScriptExecutionDeps,
} from "./script-execution";

const LEASE_MS = 30_000;

export interface ScriptDriverDeps extends ScriptExecutionDeps {
  readonly store: ScriptExecutionDeps["store"] & {
    listPendingScriptApprovalsPastDeadline(at: UtcTimestamp): MaybePromise<readonly Approval[]>;
  };
  readonly sweepIntervalMs: number;
  readonly deliverEvents?: () => Promise<void>;
  readonly logError?: (error: unknown) => void;
}

export class ScriptDriver {
  readonly #owner = crypto.randomUUID();
  readonly #closing = new AbortController();
  readonly #active = new Map<
    string,
    { promise: Promise<void>; again: boolean; changes: EventTarget }
  >();
  #timer: ReturnType<typeof setInterval> | undefined;
  #sweeping: Promise<void> | undefined;

  constructor(readonly deps: ScriptDriverDeps) {}

  start(): void {
    this.#timer = setInterval(() => this.#background(this.sweep()), this.deps.sweepIntervalMs);
    this.#background(this.sweep());
  }

  kick(id: string): Promise<void> {
    if (this.#closing.signal.aborted) {
      return Promise.resolve();
    }
    const active = this.#active.get(id);
    if (active !== undefined) {
      active.again = true;
      active.changes.dispatchEvent(new Event("change"));
      return active.promise;
    }
    const entry = {
      again: false,
      changes: new EventTarget(),
      promise: Promise.resolve()
        .then(async () => {
          do {
            entry.again = false;
            await this.#drive(id, entry.changes);
          } while (entry.again && !this.#closing.signal.aborted);
        })
        .finally(() => this.#active.delete(id)),
    };
    this.#active.set(id, entry);
    return entry.promise;
  }

  /** Waits for the terminal result; with `timeoutMs`, returns undefined when it has not arrived by then. */
  wait(id: string, signal: AbortSignal): Promise<ExecuteResult>;
  wait(id: string, signal: AbortSignal, timeoutMs: number): Promise<ExecuteResult | undefined>;
  async wait(
    id: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<ExecuteResult | undefined> {
    this.#background(this.kick(id));
    const until = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      this.#closing.signal.throwIfAborted();
      const { execution, steps } = this.deps.scripts.load(id);
      if (execution.result !== null) {
        if (execution.status === "in_doubt") {
          await this.#interruptRun(execution, steps, execution.result);
        }
        return execution.result;
      }
      if (Date.now() >= until) {
        return undefined;
      }
      await Bun.sleep(25);
    }
  }

  /** The asked writes of an execution whose Approval is still pending. */
  async proposedWrites(
    id: string,
  ): Promise<{ position: number; capability: string; input: JsonValue }[]> {
    const { steps } = this.deps.scripts.load(id);
    const waiting = [];
    for (const step of steps) {
      if (step.effect !== "write" || step.decision !== "ask" || step.status !== "pending") {
        continue;
      }
      const approval = await this.deps.store.getApproval(approvalId(id, step.position));
      if (approval?.decision.status === "pending") {
        waiting.push({ position: step.position, capability: step.capability, input: step.input });
      }
    }
    return waiting;
  }

  async #interruptRun(
    execution: ScriptExecution,
    steps: readonly StoredStep[],
    result: ExecuteResult,
  ): Promise<void> {
    const { store, now } = this.deps;
    const doubtful = steps.find((step) => step.status === "unknown");
    const run = await store.getRun(execution.runId);
    const effect =
      doubtful === undefined ? undefined : await store.getEffect(effectOf(execution, doubtful));
    if (run === undefined || RUN_ENDED.has(run.status) || effect === undefined || result.ok) {
      return;
    }
    await finalizeInterruptedUncertainStep(
      { store, now },
      { run, effectId: effect.id, detail: result.error.message },
    );
  }

  async cancelRun(runId: RunId): Promise<void> {
    const ids = new Set([
      ...this.#active.keys(),
      ...this.deps.scripts.listDrivable(formatUtcTimestamp(this.deps.now())),
    ]);
    await Promise.all(
      [...ids]
        .filter((id) => this.deps.scripts.load(id).execution.runId === runId)
        .map((id) => this.kick(id)),
    );
  }

  async decide(
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ): Promise<Approval | undefined> {
    const approval = await this.deps.store.getApproval(decision.approvalId);
    const id = approval === undefined ? undefined : scriptApprovalOwner(approval.awakeable);
    if (id === undefined) {
      return undefined;
    }
    try {
      return await this.deps.store.decide(decision, channelIntake);
    } finally {
      this.#background(this.kick(id));
    }
  }

  sweep(): Promise<void> {
    if (this.#closing.signal.aborted) {
      return Promise.resolve();
    }
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  async #sweep(): Promise<void> {
    const { scripts, store, now } = this.deps;
    const at = formatUtcTimestamp(now());
    const expired = await store.listPendingScriptApprovalsPastDeadline(at);
    for (const approval of expired) {
      if (this.#closing.signal.aborted) {
        return;
      }
      try {
        await this.decide({
          approvalId: approval.id,
          botId: approval.botId,
          sessionId: approval.sessionId,
          runId: approval.runId,
          status: "expired",
          decidedAt: at,
        });
      } catch (error) {
        this.deps.logError?.(error);
      }
    }
    for (const id of scripts.listDrivable(at)) {
      if (!this.#active.has(id)) {
        this.#background(this.kick(id));
      }
    }
    // An interruption lost to a crash after the execution ended in doubt.
    for (const id of scripts.listInDoubtWithActiveRun()) {
      if (this.#closing.signal.aborted) {
        return;
      }
      try {
        const { execution, steps } = scripts.load(id);
        if (execution.result !== null) {
          await this.#interruptRun(execution, steps, execution.result);
        }
      } catch (error) {
        this.deps.logError?.(error);
      }
    }
    await this.deps.deliverEvents?.();
  }

  async #drive(id: string, changes: EventTarget): Promise<void> {
    const { scripts, now } = this.deps;
    const signal = this.#closing.signal;
    let expires = 0;
    const renew = (): boolean => {
      expires = now().getTime() + LEASE_MS;
      return scripts.takeLease(id, this.#owner, formatUtcTimestamp(new Date(expires + 1000)));
    };
    if (signal.aborted || !renew()) {
      return;
    }
    let lost = false;
    const timer = setInterval(() => {
      try {
        lost ||= !renew();
        changes.dispatchEvent(new Event("change"));
      } catch (error) {
        lost = true;
        this.deps.logError?.(error);
        changes.dispatchEvent(new Event("change"));
      }
    }, LEASE_MS / 3);
    try {
      await executeScriptRun(
        this.deps,
        id,
        () => {
          signal.throwIfAborted();
          if (lost || now().getTime() >= expires) {
            throw new Error(`Lease lost for Script execution ${id}`);
          }
        },
        signal,
        changes,
      );
    } finally {
      clearInterval(timer);
      scripts.releaseLease(id, this.#owner);
    }
    const { execution, steps } = scripts.load(id);
    if (execution.result !== null && execution.detachedAt !== null) {
      // No `wait` observes a detached result, so the in-doubt interruption happens here.
      if (execution.status === "in_doubt") {
        await this.#interruptRun(execution, steps, execution.result);
      }
      await this.deps.deliverEvents?.();
    }
  }

  #background(work: Promise<void>): void {
    void work.catch((error: unknown) => {
      if (!this.#closing.signal.aborted) {
        this.deps.logError?.(error);
      }
    });
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#closing.abort();
    await Promise.allSettled([
      ...[...this.#active.values()].map(({ promise }) => promise),
      this.#sweeping,
    ]);
  }
}
