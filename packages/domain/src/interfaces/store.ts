import type {
  Approval,
  ApprovalResolutionInput,
  EffectIdentity,
  EffectRecord,
} from "../schemas/approval";
import type { Bot, CreateBotInput, UpdateBotInput } from "../schemas/bot";
import type { DeliveryResult, OutboxDeliveryState, OutboxEvent } from "../schemas/channel";
import type {
  ApprovalId,
  BotId,
  ChannelBindingId,
  EffectId,
  EngineKind,
  JsonValue,
  OutboxEventId,
  RoutineId,
  RunId,
  SessionId,
} from "../schemas/common";
import type { Message, MessagePart } from "../schemas/message";
import type { Routine, RoutineTarget } from "../schemas/routine";
import type {
  ChannelIntakeMetadata,
  ContextMode,
  Run,
  RunAdmission,
  RunEvent,
  RunRequest,
  RunStatus,
  RunUsage,
  TerminalRunStatus,
} from "../schemas/run";
import type { CreateSessionInput, Session } from "../schemas/session";
import type { UtcTimestamp } from "../protocol/timestamp";

export type MaybePromise<T> = T | Promise<T>;

export interface MessagePage {
  readonly limit?: number;
  readonly afterOrdinal?: number;
  /** Return the last `limit` messages after `afterOrdinal`, still in ascending order. */
  readonly newest?: boolean;
}

export interface BotStore {
  createBot(input: CreateBotInput & { readonly id?: BotId }): MaybePromise<Bot>;
  getBot(botId: BotId): MaybePromise<Bot | undefined>;
  listBots(): MaybePromise<Bot[]>;
  updateBot(botId: BotId, patch: UpdateBotInput): MaybePromise<Bot>;
}

export interface SessionStore {
  createSession(input: CreateSessionInput & { readonly id?: SessionId }): MaybePromise<Session>;
  getSession(sessionId: SessionId): MaybePromise<Session | undefined>;
  listSessions(botId: BotId): MaybePromise<Session[]>;
  listMessages(sessionId: SessionId, options?: MessagePage): MaybePromise<Message[]>;
}

export interface RunEventInput {
  readonly chunkKey: string;
  readonly chunk: JsonValue;
  readonly isTerminal?: boolean;
}

export interface FinishRunInput {
  readonly runId: RunId;
  readonly status: TerminalRunStatus;
  readonly terminalEvent: RunEventInput;
  readonly finalMessageParts?: readonly MessagePart[];
  readonly detail?: string;
  readonly checkpoint?: JsonValue | null;
  readonly usage?: RunUsage;
  readonly contextMode?: ContextMode;
}

export interface FinishRunOutcome {
  readonly run: Run;
  readonly terminalEvent: RunEvent;
  readonly finalMessage?: Message;
  readonly outboxEvents: readonly OutboxEvent[];
}

export interface RunStreamState {
  readonly highWaterMark: number;
  readonly terminalSequence: number | undefined;
  readonly status: RunStatus;
}

export interface RunStore {
  admit(request: RunRequest): Promise<RunAdmission>;
  getRun(runId: RunId): MaybePromise<Run | undefined>;
  /** Runs of a session, newest first. */
  listSessionRuns(sessionId: SessionId): MaybePromise<Run[]>;
  markRunRunning(runId: RunId, checkpoint?: JsonValue | null): Promise<Run>;
  appendRunEvents(runId: RunId, events: readonly RunEventInput[]): Promise<RunEvent[]>;
  getRunStreamState(runId: RunId): MaybePromise<RunStreamState | undefined>;
  readRunEventsAfter(runId: RunId, after: number, limit?: number): MaybePromise<RunEvent[]>;
  replay(runId: RunId, after: number): AsyncIterable<RunEvent>;
  finishRun(input: FinishRunInput): Promise<FinishRunOutcome>;
}

export interface RequestApprovalInput {
  readonly id?: ApprovalId;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly effect: EffectIdentity;
  readonly prompt: string;
  readonly awakeable: string;
  readonly deadline: UtcTimestamp;
}

export interface RequestApprovalOutcome {
  readonly approval: Approval;
  readonly outboxEvents: readonly OutboxEvent[];
  readonly isDuplicate: boolean;
}

export type BeginEffectOutcome =
  | { readonly kind: "started"; readonly effect: EffectRecord }
  | { readonly kind: "completed"; readonly effect: EffectRecord }
  | { readonly kind: "ambiguous"; readonly effect: EffectRecord };

export interface ApprovalEffectStore {
  requestApproval(input: RequestApprovalInput): Promise<RequestApprovalOutcome>;
  getApproval(approvalId: ApprovalId): MaybePromise<Approval | undefined>;
  getLatestApprovalForRun(runId: RunId): MaybePromise<Approval | undefined>;
  decide(
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ): Promise<Approval>;
  beginEffect(
    identity: EffectIdentity,
    options?: { readonly approvalId?: ApprovalId },
  ): Promise<BeginEffectOutcome>;
  completeEffect(effectId: EffectId, outcome: JsonValue): Promise<EffectRecord>;
  markEffectUnknown(effectId: EffectId): Promise<EffectRecord>;
  getEffect(identity: EffectIdentity): MaybePromise<EffectRecord | undefined>;
  findWriteInDoubt(runId: RunId): MaybePromise<EffectRecord | undefined>;
}

export interface OutboxEventFilter {
  readonly eventId?: string;
  readonly bindingId?: ChannelBindingId;
  readonly state?: OutboxDeliveryState;
}

export interface OutboxStore {
  listOutboxEvents(filter?: OutboxEventFilter): MaybePromise<OutboxEvent[]>;
  listDueOutboxEvents(now?: UtcTimestamp, limit?: number): MaybePromise<OutboxEvent[]>;
  recordOutboxDelivery(outboxId: OutboxEventId, result: DeliveryResult): Promise<OutboxEvent>;
}

export type CreateRoutineInput = {
  readonly id?: RoutineId;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly revision?: number;
} & RoutineTarget;

export interface RoutineStore {
  createRoutine(input: CreateRoutineInput): MaybePromise<Routine>;
  getRoutine(routineId: RoutineId): MaybePromise<Routine | undefined>;
}

export interface EngineSession {
  readonly sessionId: SessionId;
  readonly engine: EngineKind;
  readonly vendorSessionId: string;
  readonly baseHash: string;
  readonly contextHash: string;
  /** Highest message ordinal the vendor session has seen. */
  readonly lastOrdinal: number;
  /** Run whose engine call is in flight; null once the call finished. */
  readonly pendingRunId: RunId | null;
  readonly updatedAt: UtcTimestamp;
}

export interface EngineSessionStore {
  getEngineSession(sessionId: SessionId, engine: EngineKind): EngineSession | null;
  /** No-op when the session has no row for the engine. */
  markEngineSessionPending(sessionId: SessionId, engine: EngineKind, runId: RunId): void;
  /** Upsert; clears `pendingRunId` and stamps `updatedAt`. */
  saveEngineSession(row: Omit<EngineSession, "pendingRunId" | "updatedAt">): void;
  dropEngineSession(sessionId: SessionId, engine: EngineKind): void;
}

export interface Store
  extends
    BotStore,
    SessionStore,
    RunStore,
    ApprovalEffectStore,
    OutboxStore,
    RoutineStore,
    EngineSessionStore {}
