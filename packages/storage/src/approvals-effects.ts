import {
  CLOUD_EVENT_SPEC_VERSION,
  CLOUD_EVENT_TYPES,
  formatUtcTimestamp,
  type Approval,
  type ApprovalId,
  type ApprovalResolutionInput,
  type BotId,
  type ChannelIntakeMetadata,
  type CloudEvent,
  type EffectId,
  type EffectIdentity,
  type EffectRecord,
  type JsonValue,
  type OutboxEvent,
  type RunId,
  type SessionId,
  type UtcTimestamp,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { canonicalizeJson } from "./canonical";
import { insertOutboxForBindings } from "./channel-outbox";
import type { SqliteDatabase } from "./database";
import { conflictError, notFoundError, validationError } from "./errors";
import {
  mapApprovalRow,
  mapEffectRow,
  mapOutboxEventRow,
  type ApprovalRow,
  type ChannelBindingRow,
  type EffectRow,
  type OutboxEventRow,
  type RunRow,
} from "./rows";

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

export async function requestApproval(
  database: SqliteDatabase,
  input: RequestApprovalInput,
): Promise<RequestApprovalOutcome> {
  const effect = compiledParsers.effectIdentity.parse(input.effect);
  const instance = `/api/runs/${input.runId}`;
  if (effect.runId !== input.runId) {
    throw conflictError(
      "approval.scope_mismatch",
      "Approval effect scope mismatch",
      `Effect runId ${effect.runId} does not match approval runId ${input.runId}.`,
      instance,
    );
  }

  const canonicalArgsJson = canonicalizeJson(effect.canonicalArguments);
  const now = formatUtcTimestamp(database.now());

  return database.inTransactionWithRetry((db) => {
    const runRow = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(input.runId);
    if (!runRow) {
      throw notFoundError(
        "run.not_found",
        "Run not found",
        `Run ${input.runId} does not exist.`,
        instance,
      );
    }
    if (runRow.bot_id !== input.botId || runRow.session_id !== input.sessionId) {
      throw conflictError(
        "approval.scope_mismatch",
        "Run scope mismatch",
        `Run ${input.runId} does not belong to bot ${input.botId} and session ${input.sessionId}.`,
        instance,
      );
    }

    const existing = db
      .query<ApprovalRow, [string, string, string, string]>(
        `SELECT * FROM approvals
         WHERE run_id = ? AND operation_kind = ? AND operation_id = ? AND attempt_id = ?`,
      )
      .get(input.runId, effect.operationKind, effect.operationId, effect.attemptId);

    if (existing) {
      if (existing.canonical_arguments_json !== canonicalArgsJson) {
        throw conflictError(
          "approval.scope_mismatch",
          "Approval arguments mismatch",
          `Approval for ${effect.operationKind}:${effect.operationId} attempt ${effect.attemptId} already exists with different arguments.`,
          instance,
        );
      }
      const outboxRows = db
        .query<OutboxEventRow, [string]>("SELECT * FROM outbox_events WHERE event_id = ?")
        .all(`approval:${existing.id}`);
      return {
        approval: mapApprovalRow(existing),
        outboxEvents: outboxRows.map(mapOutboxEventRow),
        isDuplicate: true,
      };
    }

    const approvalId = input.id ?? `appr_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO approvals
        (id, bot_id, session_id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, prompt, awakeable, deadline, status, actor, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    ).run(
      approvalId,
      input.botId,
      input.sessionId,
      input.runId,
      effect.operationKind,
      effect.operationId,
      canonicalArgsJson,
      effect.attemptId,
      input.prompt,
      input.awakeable,
      input.deadline,
      now,
      now,
    );

    db.query(
      `UPDATE runs
       SET status = 'waiting_approval', updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).run(now, input.runId);

    const sessionBindings = db
      .query<ChannelBindingRow, [string, string]>(
        `SELECT * FROM channel_bindings
         WHERE bot_id = ? AND session_id = ? AND enabled = 1
         ORDER BY created_at ASC, id ASC`,
      )
      .all(input.botId, input.sessionId);

    const envelope: CloudEvent = {
      specversion: CLOUD_EVENT_SPEC_VERSION,
      id: `approval:${approvalId}`,
      source: `/bots/${input.botId}`,
      type: CLOUD_EVENT_TYPES.approvalRequested,
      time: now,
      subject: `sessions/${input.sessionId}/runs/${input.runId}/approvals/${approvalId}`,
      datacontenttype: "application/json",
      data: {
        botId: input.botId,
        sessionId: input.sessionId,
        runId: input.runId,
        approvalId,
        operationKind: effect.operationKind,
        operationId: effect.operationId,
        prompt: input.prompt,
        deadline: input.deadline,
      },
    };

    const outboxEvents = insertOutboxForBindings(db, sessionBindings, envelope, now);

    const created = db
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
      .get(approvalId);
    if (!created) {
      throw new Error(`Approval ${approvalId} was not persisted`);
    }

    return {
      approval: mapApprovalRow(created),
      outboxEvents,
      isDuplicate: false,
    };
  });
}

export function getApproval(
  database: SqliteDatabase,
  approvalId: ApprovalId,
): Approval | undefined {
  const row = database.db
    .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
    .get(approvalId);
  return row ? mapApprovalRow(row) : undefined;
}

export function getLatestApprovalForRun(
  database: SqliteDatabase,
  runId: RunId,
): Approval | undefined {
  const row = database.db
    .query<ApprovalRow, [string]>(
      "SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(runId);
  return row ? mapApprovalRow(row) : undefined;
}

export async function decideApproval(
  database: SqliteDatabase,
  decision: ApprovalResolutionInput,
  _channelIntake?: ChannelIntakeMetadata,
): Promise<Approval> {
  const parsed = compiledParsers.approvalResolutionInput.safeParse(decision);
  if (!parsed.success) {
    throw validationError(
      "approval.invalid_decision",
      "Invalid approval decision",
      parsed.error.message,
      `/api/approvals/${decision.approvalId ?? "unknown"}/decision`,
    );
  }

  const input = parsed.data;
  const instance = `/api/approvals/${input.approvalId}/decision`;
  const now = formatUtcTimestamp(database.now());

  const outcome = await database.inTransactionWithRetry<
    | { readonly kind: "settled"; readonly approval: Approval }
    | { readonly kind: "expired"; readonly deadline: string }
  >((db) => {
    const row = db
      .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
      .get(input.approvalId);
    if (!row) {
      throw notFoundError(
        "approval.not_found",
        "Approval not found",
        `Approval ${input.approvalId} does not exist.`,
        instance,
      );
    }

    if (
      row.bot_id !== input.botId ||
      row.session_id !== input.sessionId ||
      row.run_id !== input.runId
    ) {
      throw conflictError(
        "approval.scope_mismatch",
        "Approval scope mismatch",
        `Approval ${input.approvalId} does not match bot ${input.botId}, session ${input.sessionId}, and run ${input.runId}.`,
        instance,
      );
    }

    if (row.status === "pending") {
      if (input.status !== "expired" && Date.parse(now) >= Date.parse(row.deadline)) {
        db.query(
          `UPDATE approvals
           SET status = 'expired', actor = NULL, decided_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).run(row.deadline, now, input.approvalId);

        return { kind: "expired", deadline: row.deadline };
      }

      const actor = input.status === "expired" ? null : input.actor;
      const decidedAt = input.status === "expired" ? row.deadline : now;
      const result = db
        .query(
          `UPDATE approvals
           SET status = ?, actor = ?, decided_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(input.status, actor, decidedAt, now, input.approvalId);

      if (result.changes !== 1) {
        throw conflictError(
          "approval.decision_conflict",
          "Approval already settled",
          `Approval ${input.approvalId} was already decided concurrently.`,
          instance,
        );
      }

      if (input.status === "approved") {
        db.query(
          `UPDATE runs
           SET status = 'running', updated_at = ?
           WHERE id = ? AND status = 'waiting_approval'`,
        ).run(now, row.run_id);
      }

      const updated = db
        .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
        .get(input.approvalId);
      if (!updated) {
        throw new Error(`Approval ${input.approvalId} disappeared after update`);
      }
      return { kind: "settled", approval: mapApprovalRow(updated) };
    }

    const isExactReplay =
      row.status === input.status && (input.status === "expired" || row.actor === input.actor);

    if (isExactReplay) {
      return { kind: "settled", approval: mapApprovalRow(row) };
    }

    if (row.status === "expired") {
      return { kind: "expired", deadline: row.decided_at ?? row.deadline };
    }

    throw conflictError(
      "approval.decision_conflict",
      "Approval decision conflict",
      `Approval ${input.approvalId} was already ${row.status} by ${row.actor ?? "system"}.`,
      instance,
    );
  });

  if (outcome.kind === "expired") {
    throw conflictError(
      "approval.expired",
      "Approval expired",
      `Approval ${input.approvalId} expired at ${outcome.deadline}.`,
      instance,
    );
  }

  return outcome.approval;
}

export async function beginEffect(
  database: SqliteDatabase,
  identity: EffectIdentity,
  options?: { readonly approvalId?: ApprovalId },
): Promise<BeginEffectOutcome> {
  const valid = compiledParsers.effectIdentity.parse(identity);
  const canonicalArgsJson = canonicalizeJson(valid.canonicalArguments);
  const instance = `/api/runs/${valid.runId}`;
  const now = formatUtcTimestamp(database.now());

  return database.inTransactionWithRetry((db) => {
    if (options?.approvalId !== undefined) {
      const approvalRow = db
        .query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?")
        .get(options.approvalId);
      if (!approvalRow) {
        throw notFoundError(
          "approval.not_found",
          "Approval not found",
          `Approval ${options.approvalId} does not exist.`,
          instance,
        );
      }
      if (approvalRow.status !== "approved") {
        throw conflictError(
          "effect.not_approved",
          "Effect approval is not granted",
          `Approval ${options.approvalId} has status "${approvalRow.status}", expected "approved".`,
          instance,
        );
      }
      if (
        approvalRow.run_id !== valid.runId ||
        approvalRow.operation_kind !== valid.operationKind ||
        approvalRow.operation_id !== valid.operationId ||
        approvalRow.attempt_id !== valid.attemptId ||
        approvalRow.canonical_arguments_json !== canonicalArgsJson
      ) {
        throw conflictError(
          "effect.authorization_mismatch",
          "Approval does not authorize this effect",
          `Approval ${options.approvalId} does not match effect ${valid.operationKind}:${valid.operationId} (${valid.attemptId}) with the supplied arguments.`,
          instance,
        );
      }
    }

    const existing = db
      .query<EffectRow, [string, string, string, string]>(
        `SELECT * FROM effects
         WHERE run_id = ? AND operation_kind = ? AND operation_id = ? AND attempt_id = ?`,
      )
      .get(valid.runId, valid.operationKind, valid.operationId, valid.attemptId);

    if (existing) {
      if (existing.canonical_arguments_json !== canonicalArgsJson) {
        throw conflictError(
          "effect.identity_conflict",
          "Effect arguments conflict",
          `Effect ${valid.operationKind}:${valid.operationId} attempt ${valid.attemptId} already exists with different arguments.`,
          instance,
        );
      }
      const mapped = mapEffectRow(existing);
      if (mapped.status === "completed") {
        return { kind: "completed", effect: mapped };
      }
      return { kind: "ambiguous", effect: mapped };
    }

    const effectId = `eff_${crypto.randomUUID()}`;
    db.query(
      `INSERT INTO effects
        (id, run_id, operation_kind, operation_id, canonical_arguments_json, attempt_id, status, outcome_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'started', NULL, ?, ?)`,
    ).run(
      effectId,
      valid.runId,
      valid.operationKind,
      valid.operationId,
      canonicalArgsJson,
      valid.attemptId,
      now,
      now,
    );

    const created = db
      .query<EffectRow, [string]>("SELECT * FROM effects WHERE id = ?")
      .get(effectId);
    if (!created) {
      throw new Error(`Effect ${effectId} was not persisted`);
    }
    return { kind: "started", effect: mapEffectRow(created) };
  });
}

export async function completeEffect(
  database: SqliteDatabase,
  effectId: EffectId,
  outcome: JsonValue,
): Promise<EffectRecord> {
  const now = formatUtcTimestamp(database.now());
  return database.inTransactionWithRetry((db) => {
    db.query(
      `UPDATE effects
       SET status = 'completed', outcome_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(outcome), now, effectId);

    const updated = db
      .query<EffectRow, [string]>("SELECT * FROM effects WHERE id = ?")
      .get(effectId);
    if (!updated) {
      throw notFoundError(
        "effect.not_found",
        "Effect not found",
        `Effect ${effectId} does not exist.`,
        `/effects/${effectId}`,
      );
    }
    return mapEffectRow(updated);
  });
}

export async function markEffectUnknown(
  database: SqliteDatabase,
  effectId: EffectId,
): Promise<EffectRecord> {
  const now = formatUtcTimestamp(database.now());
  return database.inTransactionWithRetry((db) => {
    db.query(
      `UPDATE effects
       SET status = 'unknown', outcome_json = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, effectId);

    const updated = db
      .query<EffectRow, [string]>("SELECT * FROM effects WHERE id = ?")
      .get(effectId);
    if (!updated) {
      throw notFoundError(
        "effect.not_found",
        "Effect not found",
        `Effect ${effectId} does not exist.`,
        `/effects/${effectId}`,
      );
    }
    return mapEffectRow(updated);
  });
}

export function getEffect(
  database: SqliteDatabase,
  identity: EffectIdentity,
): EffectRecord | undefined {
  const row = database.db
    .query<EffectRow, [string, string, string, string]>(
      `SELECT * FROM effects
       WHERE run_id = ? AND operation_kind = ? AND operation_id = ? AND attempt_id = ?`,
    )
    .get(identity.runId, identity.operationKind, identity.operationId, identity.attemptId);
  return row ? mapEffectRow(row) : undefined;
}

export function findWriteInDoubt(database: SqliteDatabase, runId: RunId): EffectRecord | undefined {
  const row = database.db
    .query<EffectRow, [string, string]>(
      `SELECT e.* FROM effects e
       WHERE e.run_id = ? AND e.operation_kind = ?
         AND (
           e.status = 'unknown'
           OR (
             e.status = 'started'
             AND EXISTS (
               SELECT 1 FROM script_runs s
               WHERE s.run_id = e.run_id
                 AND substr(e.attempt_id, 1, length(s.id) + 1) = s.id || ':'
                 AND s.status NOT IN ('running', 'waiting_approval')
             )
           )
         )
       ORDER BY e.started_at, e.id
       LIMIT 1`,
    )
    .get(runId, "capability");
  return row ? mapEffectRow(row) : undefined;
}
