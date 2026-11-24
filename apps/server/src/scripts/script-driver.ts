import {
  formatUtcTimestamp,
  type Approval,
  type MaybePromise,
  type UtcTimestamp,
  type ApprovalResolutionInput,
  type ChannelIntakeMetadata,
  type ExecuteResult,
  type RunId,
} from "@der/domain";
import {
  executeScriptRun,
  scriptApprovalOwner,
  type ScriptExecutionDeps,
} from "./script-execution";

const LEASE_MS = 30_000;

export interface ScriptDriverDeps extends ScriptExecutionDeps {
  readonly store: ScriptExecutionDeps["store"] & {
    listPendingScriptApprovalsPastDeadline(at: UtcTimestamp): MaybePromise<readonly Approval[]>;
  };
  readonly sweepIntervalMs: number;
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

  async wait(id: string, signal: AbortSignal): Promise<ExecuteResult> {
    this.#background(this.kick(id));
    for (;;) {
      signal.throwIfAborted();
      this.#closing.signal.throwIfAborted();
      const { execution } = this.deps.scripts.load(id);
      if (execution.result !== null) {
        return execution.result;
      }
      await Bun.sleep(25);
    }
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
