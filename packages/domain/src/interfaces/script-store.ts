import type { UtcTimestamp } from "../protocol/timestamp";
import type { BotId, JsonValue, RunId } from "../schemas/common";
import type {
  ExecuteResult,
  ScriptRunStatus,
  TerminalScriptRunStatus,
} from "../schemas/script-run";

export type ScriptRunId = string;

export type StepEffect = "read" | "write";
export type StepDecision = "allow" | "ask" | "deny";
export type StepStatus = "pending" | "done" | "failed" | "unknown" | "skipped";

export interface AcquireScript {
  readonly runId: RunId;
  readonly botId: BotId;
  readonly source: string;
  readonly seed: number;
}

export interface ScriptExecution {
  readonly id: ScriptRunId;
  readonly runId: RunId;
  readonly botId: BotId;
  readonly digest: string;
  readonly occurrence: number;
  readonly source: string;
  readonly status: ScriptRunStatus;
  readonly result: ExecuteResult | null;
  readonly seed: number;
  readonly createdAt: UtcTimestamp;
  readonly leaseOwner: string | null;
  readonly leaseUntil: UtcTimestamp | null;
  readonly detachedAt: UtcTimestamp | null;
  readonly deliveredAt: UtcTimestamp | null;
}

export interface NewStep {
  readonly position: number;
  readonly capability: string;
  readonly effect: StepEffect;
  readonly decision: StepDecision;
  readonly inputHash: string;
  readonly input: JsonValue;
  readonly round?: number;
}

export interface StoredStep {
  readonly position: number;
  readonly capability: string;
  readonly effect: StepEffect;
  readonly decision: StepDecision;
  readonly inputHash: string;
  readonly input: JsonValue;
  readonly status: StepStatus;
  readonly result: JsonValue | null;
  readonly error: JsonValue | null;
  readonly seq: number | null;
  readonly batch: number | null;
  readonly round: number | null;
}

export interface StepOutcome {
  readonly status: Exclude<StepStatus, "pending">;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
}

export interface DeliveryMark {
  readonly position: number;
  readonly seq: number;
  readonly batch: number;
}

export interface ScriptEnd {
  readonly status: TerminalScriptRunStatus;
  readonly result: ExecuteResult;
}

export interface FinishResult {
  readonly execution: ScriptExecution;
  readonly detached: boolean;
}

export interface ScriptStore {
  /**
   * Returns the latest execution of this source in the Run while it is unfinished or finished
   * with its result not yet handed over (`markResultDelivered`); otherwise starts the next occurrence.
   */
  acquire(input: AcquireScript): ScriptExecution;
  load(id: ScriptRunId): { execution: ScriptExecution; steps: readonly StoredStep[] };
  /** First writer wins per position; returns the stored rows for every requested position. */
  registerSteps(id: ScriptRunId, steps: readonly NewStep[]): readonly StoredStep[];
  /** Settles a pending step once; a settled step is left unchanged. */
  completeStep(id: ScriptRunId, position: number, outcome: StepOutcome): void;
  /** Gives each undelivered position the next seq, all in one new batch; returns the marks of the requested positions. */
  markDelivered(id: ScriptRunId, positions: readonly number[]): readonly DeliveryMark[];
  /** Sets the terminal status once; later calls leave the first status and result. A detached execution gets its `script.finished` event in the same unit. */
  finish(id: ScriptRunId, end: ScriptEnd): FinishResult;
  /** Records that the finished result reached the agent; the first call sets it, later calls change nothing. A no-op while unfinished. */
  markResultDelivered(id: ScriptRunId): void;
  /** Returns true only on the call that set it, and only while the execution is unfinished. */
  detach(id: ScriptRunId): boolean;
  /** Succeeds when no other owner holds an unexpired lease. */
  takeLease(id: ScriptRunId, owner: string, until: UtcTimestamp): boolean;
  releaseLease(id: ScriptRunId, owner: string): void;
  /** Executions that are not terminal and whose lease is absent or expired at `now`. */
  listDrivable(now: UtcTimestamp): readonly ScriptRunId[];
}
