import type { Database } from "bun:sqlite";
import {
  formatUtcTimestamp,
  type BotId,
  type ChannelBinding,
  type ChannelBindingId,
  type ChannelIntegration,
  type CloudEvent,
  type DeliveryResult,
  type OutboxDeliveryState,
  type OutboxDestination,
  type OutboxEvent,
  type OutboxEventId,
  type SessionId,
  type UtcTimestamp,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { SqliteDatabase } from "./database";
import { notFoundError } from "./errors";
import {
  mapChannelBindingRow,
  mapOutboxEventRow,
  type ChannelBindingRow,
  type OutboxEventRow,
} from "./rows";

export interface UpsertChannelBindingInput {
  readonly id?: ChannelBindingId;
  readonly integration: ChannelIntegration;
  readonly externalChatId: string;
  readonly externalActorId: string;
  readonly botId: BotId;
  readonly sessionId: SessionId;
  readonly enabled: boolean;
}

export function insertOutboxForBindings(
  db: Database,
  bindings: readonly ChannelBindingRow[],
  envelope: CloudEvent,
  now: UtcTimestamp,
): OutboxEvent[] {
  const validated = compiledParsers.cloudEvent.parse(envelope);
  const envelopeJson = JSON.stringify(validated);
  const inserted: OutboxEvent[] = [];

  for (const binding of bindings) {
    const existing = db
      .query<OutboxEventRow, [string, string]>(
        "SELECT * FROM outbox_events WHERE binding_id = ? AND event_id = ?",
      )
      .get(binding.id, validated.id);
    if (existing) {
      inserted.push(mapOutboxEventRow(existing));
      continue;
    }

    const id = `outbox_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO outbox_events
        (id, binding_id, event_id, envelope_json, state, attempts, next_retry_at, delivered_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
    ).run(id, binding.id, validated.id, envelopeJson, now, now);

    const created = db
      .query<OutboxEventRow, [string]>("SELECT * FROM outbox_events WHERE id = ?")
      .get(id);
    if (created) {
      inserted.push(mapOutboxEventRow(created));
    }
  }

  return inserted;
}

export function upsertChannelBinding(
  database: SqliteDatabase,
  input: UpsertChannelBindingInput,
): ChannelBinding {
  const now = formatUtcTimestamp(database.now());
  return database.inTransaction((db) => {
    const existing = db
      .query<ChannelBindingRow, [string, string, string, string]>(
        `SELECT * FROM channel_bindings
         WHERE integration = ? AND external_chat_id = ? AND external_actor_id = ? AND session_id = ?`,
      )
      .get(input.integration, input.externalChatId, input.externalActorId, input.sessionId);

    if (existing) {
      db.query("UPDATE channel_bindings SET enabled = ?, updated_at = ? WHERE id = ?").run(
        input.enabled ? 1 : 0,
        now,
        existing.id,
      );
      const updated = db
        .query<ChannelBindingRow, [string]>("SELECT * FROM channel_bindings WHERE id = ?")
        .get(existing.id);
      if (!updated) {
        throw new Error(`ChannelBinding ${existing.id} disappeared`);
      }
      return mapChannelBindingRow(updated);
    }

    const bindingId = input.id ?? `bind_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO channel_bindings
        (id, integration, external_chat_id, external_actor_id, bot_id, session_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bindingId,
      input.integration,
      input.externalChatId,
      input.externalActorId,
      input.botId,
      input.sessionId,
      input.enabled ? 1 : 0,
      now,
      now,
    );

    const created = db
      .query<ChannelBindingRow, [string]>("SELECT * FROM channel_bindings WHERE id = ?")
      .get(bindingId);
    if (!created) {
      throw new Error(`ChannelBinding ${bindingId} was not persisted`);
    }
    return mapChannelBindingRow(created);
  });
}

export function listChannelBindings(
  database: SqliteDatabase,
  filter?: {
    readonly botId?: BotId;
    readonly sessionId?: SessionId;
    readonly integration?: ChannelIntegration;
    readonly enabledOnly?: boolean;
  },
): ChannelBinding[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.botId !== undefined) {
    clauses.push("bot_id = ?");
    params.push(filter.botId);
  }
  if (filter?.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter?.integration !== undefined) {
    clauses.push("integration = ?");
    params.push(filter.integration);
  }
  if (filter?.enabledOnly) {
    clauses.push("enabled = 1");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database.db
    .query<ChannelBindingRow, (string | number)[]>(
      `SELECT * FROM channel_bindings ${where} ORDER BY created_at ASC, id ASC`,
    )
    .all(...params);
  return rows.map(mapChannelBindingRow);
}

export function toOutboxDestination(binding: ChannelBinding): OutboxDestination {
  return {
    id: binding.id,
    kind: binding.integration,
    target: binding.externalChatId,
    botId: binding.botId,
    sessionId: binding.sessionId,
    enabled: binding.enabled,
    metadata: {
      externalActorId: binding.externalActorId,
    },
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

export function listOutboxDestinations(
  database: SqliteDatabase,
  filter?: {
    readonly botId?: BotId;
    readonly sessionId?: SessionId;
    readonly kind?: string;
    readonly enabledOnly?: boolean;
  },
): OutboxDestination[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.botId !== undefined) {
    clauses.push("bot_id = ?");
    params.push(filter.botId);
  }
  if (filter?.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter?.kind !== undefined) {
    clauses.push("integration = ?");
    params.push(filter.kind);
  }
  if (filter?.enabledOnly) {
    clauses.push("enabled = 1");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database.db
    .query<ChannelBindingRow, (string | number)[]>(
      `SELECT * FROM channel_bindings ${where} ORDER BY created_at ASC, id ASC`,
    )
    .all(...params);
  return rows.map((row) => toOutboxDestination(mapChannelBindingRow(row)));
}

export function listOutboxEvents(
  database: SqliteDatabase,
  filter?: {
    readonly eventId?: string;
    readonly bindingId?: ChannelBindingId;
    readonly state?: OutboxDeliveryState;
  },
): OutboxEvent[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.eventId !== undefined) {
    clauses.push("event_id = ?");
    params.push(filter.eventId);
  }
  if (filter?.bindingId !== undefined) {
    clauses.push("binding_id = ?");
    params.push(filter.bindingId);
  }
  if (filter?.state !== undefined) {
    clauses.push("state = ?");
    params.push(filter.state);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = database.db
    .query<OutboxEventRow, string[]>(
      `SELECT * FROM outbox_events ${where} ORDER BY created_at ASC, rowid ASC`,
    )
    .all(...params);
  return rows.map(mapOutboxEventRow);
}

export function listDueOutboxEvents(
  database: SqliteDatabase,
  now: UtcTimestamp,
  limit = 50,
): OutboxEvent[] {
  const rows = database.db
    .query<OutboxEventRow, [string, number]>(
      `SELECT * FROM outbox_events
       WHERE state = 'pending' OR (state = 'retrying' AND (next_retry_at IS NULL OR next_retry_at <= ?))
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(now, limit);
  return rows.map(mapOutboxEventRow);
}

export async function recordOutboxDelivery(
  database: SqliteDatabase,
  outboxId: OutboxEventId,
  result: DeliveryResult,
): Promise<OutboxEvent> {
  const valid = compiledParsers.deliveryResult.parse(result);
  const now = formatUtcTimestamp(database.now());

  return database.inTransactionWithRetry((db) => {
    const existing = db
      .query<OutboxEventRow, [string]>("SELECT * FROM outbox_events WHERE id = ?")
      .get(outboxId);
    if (!existing) {
      throw notFoundError(
        "outbox.not_found",
        "Outbox event not found",
        `Outbox event ${outboxId} does not exist.`,
        `/outbox/${outboxId}`,
      );
    }

    const nextAttempts = existing.attempts + 1;
    if (valid.status === "delivered") {
      db.query(
        `UPDATE outbox_events
         SET state = 'delivered', attempts = ?, next_retry_at = NULL, delivered_at = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(nextAttempts, valid.deliveredAt, now, outboxId);
    } else if (valid.status === "retryable") {
      const retryAt = formatUtcTimestamp(
        new Date(database.now().getTime() + (valid.retryAfterMs ?? 5000)),
      );
      db.query(
        `UPDATE outbox_events
         SET state = 'retrying', attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextAttempts, retryAt, valid.detail, now, outboxId);
    } else {
      db.query(
        `UPDATE outbox_events
         SET state = 'failed', attempts = ?, next_retry_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextAttempts, `${valid.code}: ${valid.detail}`, now, outboxId);
    }

    const updated = db
      .query<OutboxEventRow, [string]>("SELECT * FROM outbox_events WHERE id = ?")
      .get(outboxId);
    if (!updated) {
      throw new Error(`Outbox event ${outboxId} disappeared`);
    }
    return mapOutboxEventRow(updated);
  });
}
