import {
  formatUtcTimestamp,
  type Approval,
  type ApprovalEffectStore,
  type ApprovalId,
  type ApprovalResolutionInput,
  type Bot,
  type BotId,
  type BotStore,
  type ChannelBinding,
  type ChannelBindingId,
  type ChannelIntakeMetadata,
  type ChannelIntegration,
  type ContextMode,
  type CreateBotInput,
  type CreateRoutineInput,
  type CreateSessionInput,
  type DeliveryResult,
  type EffectId,
  type EffectIdentity,
  type EffectRecord,
  type EngineKind,
  type EngineSession,
  type EngineSessionStore,
  type JsonValue,
  type Message,
  type MessagePage,
  type OutboxDeliveryState,
  type OutboxDestination,
  type OutboxEvent,
  type OutboxEventId,
  type OutboxStore,
  type Routine,
  type RoutineId,
  type RoutineStore,
  type FinishRunInput,
  type FinishRunOutcome,
  type ActiveRun,
  type Run,
  type RunAdmission,
  type RunEvent,
  type RunEventInput,
  type RunId,
  type RunRequest,
  type RunStore,
  type RunStreamState,
  type Session,
  type SessionEvent,
  type SessionEventStore,
  type NewSessionEvent,
  type SessionId,
  type SessionStore,
  type Store,
  type UpdateBotInput,
  type UtcTimestamp,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import {
  countEventChain,
  countPendingSessionEvents,
  enqueueSessionEvent,
  getActiveRun,
  listPendingSessionEvents,
  markSessionEventDelivered,
} from "./session-events";
import {
  beginEffect as beginEffectCommand,
  completeEffect as completeEffectCommand,
  decideApproval,
  getApproval as getApprovalQuery,
  findWriteInDoubt as findWriteInDoubtQuery,
  getEffect as getEffectQuery,
  listPendingApprovalsForRun,
  listPendingScriptApprovalsPastDeadline,
  getLatestApprovalForRun as getLatestApprovalForRunQuery,
  markEffectUnknown as markEffectUnknownCommand,
  requestApproval as requestApprovalCommand,
  type BeginEffectOutcome,
  type RequestApprovalInput,
  type RequestApprovalOutcome,
} from "./approvals-effects";
import { routineTargetColumns } from "./routines/routine-store";
import {
  listChannelBindings as listChannelBindingsQuery,
  listDueOutboxEvents as listDueOutboxEventsQuery,
  listOutboxDestinations as listOutboxDestinationsQuery,
  listOutboxEvents as listOutboxEventsQuery,
  recordOutboxDelivery as recordOutboxDeliveryCommand,
  upsertChannelBinding as upsertChannelBindingCommand,
  type UpsertChannelBindingInput,
} from "./channel-outbox";
import {
  getEngineSession as getEngineSessionQuery,
  takeEngineSession as takeEngineSessionCommand,
} from "./engine-sessions";
import { SqliteDatabase, type SqliteDatabaseOptions } from "./database";
import { notFoundError, validationError } from "./errors";
import {
  mapBotRow,
  mapMessageRow,
  mapRoutineRow,
  mapSessionRow,
  type BotRow,
  type MessageRow,
  type RoutineRow,
  type SessionRow,
} from "./rows";
import { finishRun as finishRunCommand, startRun } from "./run-lifecycle";
import {
  admitRun,
  appendRunEvents as appendRunEventsCommand,
  getRun as getRunQuery,
  getRunStreamState as getRunStreamStateQuery,
  listSessionRuns as listSessionRunsQuery,
  readRunEventsAfter as readRunEventsAfterQuery,
} from "./runs";

export type {
  BeginEffectOutcome,
  RequestApprovalInput,
  RequestApprovalOutcome,
} from "./approvals-effects";
export type { CreateRoutineInput };
export type { UpsertChannelBindingInput } from "./channel-outbox";
export type { FinishRunInput, FinishRunOutcome, RunEventInput, RunStreamState };

export interface SqliteStoreOptions extends SqliteDatabaseOptions {
  readonly maxEventBatchSize?: number;
  readonly replayPageSize?: number;
}

const DEFAULT_MAX_EVENT_BATCH_SIZE = 16;
const DEFAULT_REPLAY_PAGE_SIZE = 64;

export class SqliteStore
  implements
    Store,
    BotStore,
    SessionStore,
    RunStore,
    ApprovalEffectStore,
    OutboxStore,
    RoutineStore,
    EngineSessionStore,
    SessionEventStore
{
  readonly database: SqliteDatabase;
  private readonly maxEventBatchSize: number;
  private readonly replayPageSize: number;

  constructor(options: SqliteStoreOptions) {
    this.database = new SqliteDatabase(options);
    this.maxEventBatchSize = options.maxEventBatchSize ?? DEFAULT_MAX_EVENT_BATCH_SIZE;
    this.replayPageSize = options.replayPageSize ?? DEFAULT_REPLAY_PAGE_SIZE;
  }

  private nowUtc(): UtcTimestamp {
    return formatUtcTimestamp(this.database.now());
  }

  createBot(input: CreateBotInput & { readonly id?: BotId }): Bot {
    const parsed = compiledParsers.createBotInput.safeParse(input);
    if (!parsed.success) {
      throw validationError(
        "bot.invalid_input",
        "Invalid bot input",
        parsed.error.message,
        "/api/bots",
      );
    }
    if (!parsed.data.allowedEngines.includes(parsed.data.defaultEngine)) {
      throw validationError(
        "bot.invalid_engine",
        "Default engine is not allowed",
        `defaultEngine "${parsed.data.defaultEngine}" must appear in allowedEngines.`,
        "/api/bots",
      );
    }

    const now = this.nowUtc();
    const botId = input.id ?? `bot_${crypto.randomUUID()}`;

    return this.database.inTransaction((db) => {
      db.query(
        `INSERT INTO bots (id, name, persona, default_engine, allowed_engines_json, workspace_path, capability_policy_json, event_chain_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        botId,
        parsed.data.name,
        parsed.data.persona,
        parsed.data.defaultEngine,
        JSON.stringify(parsed.data.allowedEngines),
        parsed.data.workspacePath ?? null,
        JSON.stringify(parsed.data.capabilityPolicy),
        parsed.data.eventChainLimit,
        now,
        now,
      );

      const row = db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(botId);
      if (!row) {
        throw new Error(`Bot ${botId} was not persisted`);
      }
      return mapBotRow(row);
    });
  }

  getBot(botId: BotId): Bot | undefined {
    const row = this.database.db
      .query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?")
      .get(botId);
    return row ? mapBotRow(row) : undefined;
  }

  listBots(): Bot[] {
    const rows = this.database.db
      .query<BotRow, []>("SELECT * FROM bots ORDER BY created_at ASC, id ASC")
      .all();
    return rows.map(mapBotRow);
  }

  updateBot(botId: BotId, input: UpdateBotInput): Bot {
    const parsed = compiledParsers.updateBotInput.safeParse(input);
    if (!parsed.success) {
      throw validationError(
        "bot.invalid_input",
        "Invalid bot update",
        parsed.error.message,
        `/api/bots/${botId}`,
      );
    }

    const now = this.nowUtc();
    return this.database.inTransaction((db) => {
      const existingRow = db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(botId);
      if (!existingRow) {
        throw notFoundError(
          "bot.not_found",
          "Bot not found",
          `Bot ${botId} does not exist.`,
          `/api/bots/${botId}`,
        );
      }
      const existing = mapBotRow(existingRow);
      const nextDefault = parsed.data.defaultEngine ?? existing.defaultEngine;
      const nextAllowed = parsed.data.allowedEngines ?? existing.allowedEngines;
      if (!nextAllowed.includes(nextDefault)) {
        throw validationError(
          "bot.invalid_engine",
          "Default engine is not allowed",
          `defaultEngine "${nextDefault}" must appear in allowedEngines.`,
          `/api/bots/${botId}`,
        );
      }

      const nextName = parsed.data.name ?? existing.name;
      const nextPersona = parsed.data.persona ?? existing.persona;
      const nextWorkspacePath =
        parsed.data.workspacePath !== undefined
          ? parsed.data.workspacePath
          : (existing.workspacePath ?? null);

      const nextPolicy = parsed.data.capabilityPolicy ?? existing.capabilityPolicy;
      const nextChainLimit = parsed.data.eventChainLimit ?? existing.eventChainLimit;

      db.query(
        `UPDATE bots
         SET name = ?, persona = ?, default_engine = ?, allowed_engines_json = ?, workspace_path = ?,
             capability_policy_json = ?, event_chain_limit = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        nextName,
        nextPersona,
        nextDefault,
        JSON.stringify(nextAllowed),
        nextWorkspacePath,
        JSON.stringify(nextPolicy),
        nextChainLimit,
        now,
        botId,
      );

      const updated = db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(botId);
      if (!updated) {
        throw new Error(`Bot ${botId} disappeared after update`);
      }
      return mapBotRow(updated);
    });
  }

  createSession(input: CreateSessionInput & { readonly id?: SessionId }): Session {
    const parsed = compiledParsers.createSessionInput.safeParse(input);
    if (!parsed.success) {
      throw validationError(
        "session.invalid_input",
        "Invalid session input",
        parsed.error.message,
        `/api/bots/${input.botId}/sessions`,
      );
    }

    const now = this.nowUtc();
    const sessionId = input.id ?? `sess_${crypto.randomUUID()}`;

    return this.database.inTransaction((db) => {
      const botRow = db
        .query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?")
        .get(parsed.data.botId);
      if (!botRow) {
        throw notFoundError(
          "bot.not_found",
          "Bot not found",
          `Bot ${parsed.data.botId} does not exist.`,
          `/api/bots/${parsed.data.botId}/sessions`,
        );
      }
      const bot = mapBotRow(botRow);
      if (parsed.data.engine !== undefined && !bot.allowedEngines.includes(parsed.data.engine)) {
        throw validationError(
          "session.invalid_engine",
          "Engine is not allowed for bot",
          `Engine "${parsed.data.engine}" is not allowed on bot ${bot.id}.`,
          `/api/bots/${bot.id}/sessions`,
        );
      }

      db.query(
        `INSERT INTO sessions (id, bot_id, title, engine, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(sessionId, parsed.data.botId, parsed.data.title, parsed.data.engine ?? null, now, now);

      const row = db
        .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
        .get(sessionId);
      if (!row) {
        throw new Error(`Session ${sessionId} was not persisted`);
      }
      return mapSessionRow(row);
    });
  }

  getSession(sessionId: SessionId): Session | undefined {
    const row = this.database.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    return row ? mapSessionRow(row) : undefined;
  }

  listSessions(botId: BotId): Session[] {
    const rows = this.database.db
      .query<SessionRow, [string]>(
        `SELECT s.*, (
           SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id AND e.state = 'pending'
         ) AS pending_event_count
         FROM sessions s WHERE s.bot_id = ? ORDER BY s.created_at ASC, s.id ASC`,
      )
      .all(botId);
    return rows.map(mapSessionRow);
  }

  enqueueSessionEvent(input: NewSessionEvent): SessionEvent {
    return this.database.inTransaction((db) => enqueueSessionEvent(db, input, this.nowUtc()));
  }

  listPendingSessionEvents(): SessionEvent[] {
    return listPendingSessionEvents(this.database.db);
  }

  markSessionEventDelivered(eventId: string, runId: RunId): void {
    markSessionEventDelivered(this.database.db, eventId, runId);
  }

  countPendingSessionEvents(sessionId: SessionId): number {
    return countPendingSessionEvents(this.database.db, sessionId);
  }

  countEventChain(sessionId: SessionId): number {
    return countEventChain(this.database.db, sessionId);
  }

  getActiveRun(sessionId: SessionId): ActiveRun | undefined {
    return getActiveRun(this.database.db, sessionId);
  }

  createRoutine(input: CreateRoutineInput): Routine {
    const now = this.nowUtc();
    const routineId = input.id ?? `rt_${crypto.randomUUID()}`;
    const revision = input.revision ?? 1;

    return this.database.inTransaction((db) => {
      const sessionRow = db
        .query<SessionRow, [string, string]>("SELECT * FROM sessions WHERE id = ? AND bot_id = ?")
        .get(input.sessionId, input.botId);
      if (!sessionRow) {
        throw notFoundError(
          "session.not_found",
          "Session not found in bot scope",
          `Session ${input.sessionId} does not belong to bot ${input.botId}.`,
          `/api/bots/${input.botId}/routines`,
        );
      }

      const { prompt, script } = routineTargetColumns(input);
      db.query(
        `INSERT INTO routines (id, bot_id, session_id, name, cron, enabled, revision, engine, prompt, script, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        routineId,
        input.botId,
        input.sessionId,
        input.name,
        input.cron,
        input.enabled ? 1 : 0,
        revision,
        input.engine,
        prompt,
        script,
        now,
        now,
      );

      const row = db
        .query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?")
        .get(routineId);
      if (!row) {
        throw new Error(`Routine ${routineId} was not persisted`);
      }
      return mapRoutineRow(row);
    });
  }

  getRoutine(routineId: RoutineId): Routine | undefined {
    const row = this.database.db
      .query<RoutineRow, [string]>("SELECT * FROM routines WHERE id = ?")
      .get(routineId);
    return row ? mapRoutineRow(row) : undefined;
  }

  listMessages(sessionId: SessionId, options?: MessagePage): Message[] {
    const limit = options?.limit ?? 100;
    const afterOrdinal = options?.afterOrdinal ?? 0;
    const sql = options?.newest
      ? `SELECT * FROM (
           SELECT * FROM messages
           WHERE session_id = ? AND ordinal > ?
           ORDER BY ordinal DESC
           LIMIT ?
         ) ORDER BY ordinal ASC`
      : `SELECT * FROM messages
         WHERE session_id = ? AND ordinal > ?
         ORDER BY ordinal ASC
         LIMIT ?`;
    const rows = this.database.db
      .query<MessageRow, [string, number, number]>(sql)
      .all(sessionId, afterOrdinal, limit);
    return rows.map(mapMessageRow);
  }

  admit(request: RunRequest): Promise<RunAdmission> {
    return admitRun(this.database, request);
  }

  getRun(runId: RunId): Run | undefined {
    return getRunQuery(this.database, runId);
  }

  getEngineSession(sessionId: SessionId, engine: EngineKind): EngineSession | null {
    return getEngineSessionQuery(this.database.db, sessionId, engine);
  }

  takeEngineSession<T extends { readonly contextMode: ContextMode }>(
    runId: RunId,
    plan: (stored: EngineSession | null) => T,
  ): T | undefined {
    return takeEngineSessionCommand(this.database, runId, plan);
  }

  listSessionRuns(sessionId: SessionId): Run[] {
    return listSessionRunsQuery(this.database, sessionId);
  }

  markRunRunning(runId: RunId, checkpoint?: JsonValue | null): Promise<Run> {
    return startRun(this.database, runId, checkpoint);
  }

  appendRunEvents(runId: RunId, events: readonly RunEventInput[]): Promise<RunEvent[]> {
    return appendRunEventsCommand(this.database, runId, events, this.maxEventBatchSize);
  }

  getRunStreamState(runId: RunId): RunStreamState | undefined {
    return getRunStreamStateQuery(this.database, runId);
  }

  readRunEventsAfter(runId: RunId, after: number, limit = this.replayPageSize): RunEvent[] {
    return readRunEventsAfterQuery(this.database, runId, after, limit);
  }

  async *replay(runId: RunId, after: number): AsyncIterable<RunEvent> {
    let cursor = after;
    while (true) {
      const page = this.readRunEventsAfter(runId, cursor, this.replayPageSize);
      if (page.length === 0) {
        break;
      }
      for (const event of page) {
        cursor = event.sequence;
        yield event;
      }
      if (page.length < this.replayPageSize) {
        break;
      }
    }
  }

  requestApproval(input: RequestApprovalInput): Promise<RequestApprovalOutcome> {
    return requestApprovalCommand(this.database, input);
  }

  getApproval(approvalId: ApprovalId): Approval | undefined {
    return getApprovalQuery(this.database, approvalId);
  }

  getLatestApprovalForRun(runId: RunId): Approval | undefined {
    return getLatestApprovalForRunQuery(this.database, runId);
  }

  listPendingApprovalsForRun(runId: RunId): readonly Approval[] {
    return listPendingApprovalsForRun(this.database, runId);
  }

  listPendingScriptApprovalsPastDeadline(at: UtcTimestamp): readonly Approval[] {
    return listPendingScriptApprovalsPastDeadline(this.database, at);
  }

  decide(
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ): Promise<Approval> {
    return decideApproval(this.database, decision, channelIntake);
  }

  beginEffect(
    identity: EffectIdentity,
    options?: { readonly approvalId?: ApprovalId; readonly scriptExecutionId?: string },
  ): Promise<BeginEffectOutcome> {
    return beginEffectCommand(this.database, identity, options);
  }

  completeEffect(effectId: EffectId, outcome: JsonValue): Promise<EffectRecord> {
    return completeEffectCommand(this.database, effectId, outcome);
  }

  markEffectUnknown(effectId: EffectId): Promise<EffectRecord> {
    return markEffectUnknownCommand(this.database, effectId);
  }

  getEffect(identity: EffectIdentity): EffectRecord | undefined {
    return getEffectQuery(this.database, identity);
  }

  findWriteInDoubt(runId: RunId): EffectRecord | undefined {
    return findWriteInDoubtQuery(this.database, runId);
  }

  finishRun(input: FinishRunInput): Promise<FinishRunOutcome> {
    return finishRunCommand(this.database, input);
  }

  upsertChannelBinding(input: UpsertChannelBindingInput): ChannelBinding {
    return upsertChannelBindingCommand(this.database, input);
  }

  listChannelBindings(filter?: {
    readonly botId?: BotId;
    readonly sessionId?: SessionId;
    readonly integration?: ChannelIntegration;
    readonly enabledOnly?: boolean;
  }): ChannelBinding[] {
    return listChannelBindingsQuery(this.database, filter);
  }

  listOutboxDestinations(filter?: {
    readonly botId?: BotId;
    readonly sessionId?: SessionId;
    readonly kind?: string;
    readonly enabledOnly?: boolean;
  }): OutboxDestination[] {
    return listOutboxDestinationsQuery(this.database, filter);
  }

  listOutboxEvents(filter?: {
    readonly eventId?: string;
    readonly bindingId?: ChannelBindingId;
    readonly state?: OutboxDeliveryState;
  }): OutboxEvent[] {
    return listOutboxEventsQuery(this.database, filter);
  }

  listDueOutboxEvents(now: UtcTimestamp = this.nowUtc(), limit = 50): OutboxEvent[] {
    return listDueOutboxEventsQuery(this.database, now, limit);
  }

  recordOutboxDelivery(outboxId: OutboxEventId, result: DeliveryResult): Promise<OutboxEvent> {
    return recordOutboxDeliveryCommand(this.database, outboxId, result);
  }

  close(): void {
    this.database.close();
  }
}

export function openSqliteStore(options: SqliteStoreOptions): SqliteStore {
  return new SqliteStore(options);
}
