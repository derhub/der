import {
  effectOperationKind,
  type Approval,
  type ApprovalDecision,
  type Bot,
  type ChannelBinding,
  type ChannelCursor,
  type ChannelReceipt,
  type EffectRecord,
  type Message,
  type OutboxEvent,
  type PersistedEffectOperationKind,
  type Routine,
  type Run,
  type RunEvent,
  type Session,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";

const ACTIVE_OPERATION_KINDS = new Set<string>(effectOperationKind.options);

function normalizePersistedOperationKind(raw: string): PersistedEffectOperationKind {
  return ACTIVE_OPERATION_KINDS.has(raw) ? (raw as PersistedEffectOperationKind) : "legacy";
}

export interface BotRow {
  readonly id: string;
  readonly name: string;
  readonly persona: string;
  readonly default_engine: string;
  readonly allowed_engines_json: string;
  readonly workspace_path: string | null;
  readonly capability_policy_json: string;
  readonly event_chain_limit: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SessionRow {
  readonly id: string;
  readonly bot_id: string;
  readonly title: string;
  readonly engine: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RoutineRow {
  readonly id: string;
  readonly bot_id: string;
  readonly session_id: string;
  readonly name: string;
  readonly cron: string;
  readonly enabled: number;
  readonly revision: number;
  readonly engine: string;
  readonly prompt: string | null;
  readonly script: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RunRow {
  readonly id: string;
  readonly bot_id: string;
  readonly session_id: string;
  readonly origin: string;
  readonly engine: string;
  readonly status: string;
  readonly routine_id: string | null;
  readonly routine_slot: string | null;
  readonly checkpoint_json: string | null;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reported_cost_usd: number | null;
  readonly context_mode: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
}

export interface MessageRow {
  readonly id: string;
  readonly bot_id: string;
  readonly session_id: string;
  readonly ordinal: number;
  readonly role: string;
  readonly parts_json: string;
  readonly run_id: string | null;
  readonly created_at: string;
}

export interface RunEventRow {
  readonly run_id: string;
  readonly sequence: number;
  readonly chunk_key: string;
  readonly chunk_json: string;
  readonly is_terminal: number;
  readonly created_at: string;
}

export interface ApprovalRow {
  readonly id: string;
  readonly bot_id: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly operation_kind: string;
  readonly operation_id: string;
  readonly canonical_arguments_json: string;
  readonly attempt_id: string;
  readonly prompt: string;
  readonly awakeable: string;
  readonly deadline: string;
  readonly status: string;
  readonly actor: string | null;
  readonly decided_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EffectRow {
  readonly id: string;
  readonly run_id: string;
  readonly operation_kind: string;
  readonly operation_id: string;
  readonly canonical_arguments_json: string;
  readonly attempt_id: string;
  readonly status: string;
  readonly outcome_json: string | null;
  readonly started_at: string;
  readonly updated_at: string;
}

export interface ChannelBindingRow {
  readonly id: string;
  readonly integration: string;
  readonly external_chat_id: string;
  readonly external_actor_id: string;
  readonly bot_id: string;
  readonly session_id: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChannelReceiptRow {
  readonly integration: string;
  readonly consumer: string;
  readonly external_update_id: string;
  readonly disposition: string;
  readonly reference_id: string | null;
  readonly recorded_at: string;
}

export interface ChannelCursorRow {
  readonly integration: string;
  readonly consumer: string;
  readonly position: string;
  readonly updated_at: string;
}

export interface OutboxEventRow {
  readonly id: string;
  readonly binding_id: string;
  readonly event_id: string;
  readonly envelope_json: string;
  readonly state: string;
  readonly attempts: number;
  readonly next_retry_at: string | null;
  readonly delivered_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function mapBotRow(row: BotRow): Bot {
  return compiledParsers.bot.parse({
    id: row.id,
    name: row.name,
    persona: row.persona,
    defaultEngine: row.default_engine,
    allowedEngines: JSON.parse(row.allowed_engines_json) as unknown,
    ...(row.workspace_path !== null ? { workspacePath: row.workspace_path } : {}),
    capabilityPolicy: JSON.parse(row.capability_policy_json) as unknown,
    eventChainLimit: row.event_chain_limit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapSessionRow(row: SessionRow): Session {
  return compiledParsers.session.parse({
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    ...(row.engine !== null ? { engine: row.engine } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapRoutineRow(row: RoutineRow): Routine {
  return compiledParsers.routine.parse({
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    name: row.name,
    cron: row.cron,
    enabled: row.enabled === 1,
    revision: row.revision,
    engine: row.engine,
    prompt: row.prompt,
    script: row.script,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapRunRow(row: RunRow): Run {
  return compiledParsers.run.parse({
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    origin: row.origin,
    engine: row.engine,
    status: row.status,
    routineId: row.routine_id,
    checkpoint: row.checkpoint_json !== null ? (JSON.parse(row.checkpoint_json) as unknown) : null,
    usage:
      row.input_tokens !== null && row.output_tokens !== null
        ? {
            inputTokens: row.input_tokens,
            cachedInputTokens: row.cached_input_tokens,
            cacheWriteTokens: row.cache_write_tokens,
            outputTokens: row.output_tokens,
            reportedCostUsd: row.reported_cost_usd,
          }
        : null,
    contextMode: row.context_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  });
}

export function mapMessageRow(row: MessageRow): Message {
  return compiledParsers.message.parse({
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    role: row.role,
    parts: JSON.parse(row.parts_json) as unknown,
    runId: row.run_id,
    createdAt: row.created_at,
  });
}

export function mapRunEventRow(row: RunEventRow): RunEvent {
  return compiledParsers.runEvent.parse({
    runId: row.run_id,
    sequence: row.sequence,
    chunkKey: row.chunk_key,
    chunk: JSON.parse(row.chunk_json) as unknown,
    isTerminal: row.is_terminal === 1,
    createdAt: row.created_at,
  });
}

export function mapApprovalRow(row: ApprovalRow): Approval {
  let decision: ApprovalDecision;
  if (row.status === "pending") {
    decision = {
      status: "pending",
      awakeable: row.awakeable,
      deadline: row.deadline,
    };
  } else if (row.status === "approved" || row.status === "denied") {
    decision = {
      status: row.status,
      actor: row.actor ?? "",
      decidedAt: row.decided_at ?? "",
    };
  } else {
    decision = {
      status: "expired",
      decidedAt: row.decided_at ?? "",
    };
  }

  return compiledParsers.approval.parse({
    id: row.id,
    botId: row.bot_id,
    sessionId: row.session_id,
    runId: row.run_id,
    effect: {
      runId: row.run_id,
      operationKind: normalizePersistedOperationKind(row.operation_kind),
      operationId: row.operation_id,
      canonicalArguments: JSON.parse(row.canonical_arguments_json) as unknown,
      attemptId: row.attempt_id,
    },
    prompt: row.prompt,
    awakeable: row.awakeable,
    deadline: row.deadline,
    decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapEffectRow(row: EffectRow): EffectRecord {
  return compiledParsers.effectRecord.parse({
    id: row.id,
    identity: {
      runId: row.run_id,
      operationKind: normalizePersistedOperationKind(row.operation_kind),
      operationId: row.operation_id,
      canonicalArguments: JSON.parse(row.canonical_arguments_json) as unknown,
      attemptId: row.attempt_id,
    },
    status: row.status,
    outcome: row.outcome_json !== null ? (JSON.parse(row.outcome_json) as unknown) : null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  });
}

export function mapChannelBindingRow(row: ChannelBindingRow): ChannelBinding {
  return compiledParsers.channelBinding.parse({
    id: row.id,
    integration: row.integration,
    externalChatId: row.external_chat_id,
    externalActorId: row.external_actor_id,
    botId: row.bot_id,
    sessionId: row.session_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function mapChannelReceiptRow(row: ChannelReceiptRow): ChannelReceipt {
  return compiledParsers.channelReceipt.parse({
    integration: row.integration,
    consumer: row.consumer,
    externalUpdateId: row.external_update_id,
    disposition: row.disposition,
    referenceId: row.reference_id,
    recordedAt: row.recorded_at,
  });
}

export function mapChannelCursorRow(row: ChannelCursorRow): ChannelCursor {
  return compiledParsers.channelCursor.parse({
    integration: row.integration,
    consumer: row.consumer,
    position: row.position,
    updatedAt: row.updated_at,
  });
}

export function mapOutboxEventRow(row: OutboxEventRow): OutboxEvent {
  return compiledParsers.outboxEvent.parse({
    id: row.id,
    bindingId: row.binding_id,
    eventId: row.event_id,
    envelope: JSON.parse(row.envelope_json) as unknown,
    state: row.state,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
