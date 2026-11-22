import {
  DomainError,
  formatUtcTimestamp,
  type Approval,
  type ChannelIntakeMetadata,
  type ChannelReceiptDisposition,
  type ChannelUpdate,
  type RunId,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { SqliteStore } from "@der/storage";
import type { DurableWorkflow } from "../workflows/index";

export interface ChannelCallbackAcknowledger {
  acknowledgeCallback?(
    callbackQueryId: string,
    options?: { readonly text?: string; readonly showAlert?: boolean },
  ): Promise<void>;
}

export interface IntakeDeps {
  readonly store: SqliteStore;
  readonly workflow: DurableWorkflow;
  readonly consumer: string;
  readonly messaging?: ChannelCallbackAcknowledger;
  readonly now?: () => Date;
  readonly onCallbackAckError?: (error: unknown, callbackQueryId: string) => void;
}

export type IntakeOutcome =
  | { readonly status: "admitted"; readonly runId: RunId }
  | { readonly status: "decided"; readonly approval: Approval }
  | {
      readonly status: "duplicate";
      readonly disposition: ChannelReceiptDisposition;
      readonly referenceId: string | null;
    }
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "retryable"; readonly reason: string };

function isRetryableCommandError(error: unknown): boolean {
  if (error instanceof DomainError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

async function acknowledgeCallbackBestEffort(
  deps: IntakeDeps,
  callbackQueryId: string | undefined,
  text: string,
): Promise<void> {
  if (callbackQueryId === undefined || deps.messaging?.acknowledgeCallback === undefined) {
    return;
  }
  try {
    await deps.messaging.acknowledgeCallback(callbackQueryId, { text });
  } catch (error) {
    deps.onCallbackAckError?.(error, callbackQueryId);
  }
}

export async function processChannelUpdate(
  deps: IntakeDeps,
  update: ChannelUpdate,
): Promise<IntakeOutcome> {
  const valid = compiledParsers.channelUpdate.parse(update);
  const nowFn = deps.now ?? (() => deps.store.database.now());
  const channelIntake: ChannelIntakeMetadata = {
    integration: valid.integration,
    consumer: deps.consumer,
    externalUpdateId: valid.externalUpdateId,
    nextCursor: valid.externalUpdateId,
  };

  const existingReceipt = deps.store.getChannelReceipt(
    valid.integration,
    deps.consumer,
    valid.externalUpdateId,
  );
  if (existingReceipt !== undefined) {
    if (valid.payload.kind === "approval_decision") {
      await acknowledgeCallbackBestEffort(
        deps,
        valid.payload.callbackQueryId,
        "Already processed.",
      );
    }
    return {
      status: "duplicate",
      disposition: existingReceipt.disposition,
      referenceId: existingReceipt.referenceId,
    };
  }

  if (valid.payload.kind === "message") {
    const binding = deps.store.findChannelBinding({
      integration: valid.integration,
      externalChatId: valid.externalChatId,
      externalActorId: valid.externalActorId,
    });
    if (binding === undefined) {
      await deps.store.recordChannelReceipt({
        integration: valid.integration,
        consumer: deps.consumer,
        externalUpdateId: valid.externalUpdateId,
        disposition: "rejected",
        referenceId: null,
        nextCursor: valid.externalUpdateId,
      });
      return { status: "rejected", reason: "binding_not_found" };
    }

    try {
      const admission = await deps.workflow.admit({
        botId: binding.botId,
        sessionId: binding.sessionId,
        origin: valid.integration === "telegram" ? "telegram" : "http",
        idempotencyKey: `${valid.integration}:${deps.consumer}:${valid.externalUpdateId}`,
        input: {
          parts: [{ type: "text", text: valid.payload.text }],
        },
        channelIntake,
      });
      return { status: "admitted", runId: admission.run.id };
    } catch (error) {
      if (isRetryableCommandError(error)) {
        return {
          status: "retryable",
          reason: error instanceof DomainError ? error.code : "intake.transient_error",
        };
      }
      const code = error instanceof DomainError ? error.code : "intake.rejected";
      await deps.store.recordChannelReceipt({
        integration: valid.integration,
        consumer: deps.consumer,
        externalUpdateId: valid.externalUpdateId,
        disposition: "rejected",
        referenceId: null,
        nextCursor: valid.externalUpdateId,
      });
      return { status: "rejected", reason: code };
    }
  }

  const approvalPayload = valid.payload;
  const approval = deps.store.getApproval(approvalPayload.approvalId);
  if (approval === undefined) {
    await deps.store.recordChannelReceipt({
      integration: valid.integration,
      consumer: deps.consumer,
      externalUpdateId: valid.externalUpdateId,
      disposition: "rejected",
      referenceId: null,
      nextCursor: valid.externalUpdateId,
    });
    await acknowledgeCallbackBestEffort(
      deps,
      approvalPayload.callbackQueryId,
      "Approval not found.",
    );
    return { status: "rejected", reason: "approval_not_found" };
  }

  const binding = deps.store.findChannelBinding({
    integration: valid.integration,
    externalChatId: valid.externalChatId,
    externalActorId: valid.externalActorId,
    sessionId: approval.sessionId,
  });
  if (
    binding === undefined ||
    binding.botId !== approval.botId ||
    binding.sessionId !== approval.sessionId
  ) {
    await deps.store.recordChannelReceipt({
      integration: valid.integration,
      consumer: deps.consumer,
      externalUpdateId: valid.externalUpdateId,
      disposition: "rejected",
      referenceId: approval.id,
      nextCursor: valid.externalUpdateId,
    });
    await acknowledgeCallbackBestEffort(
      deps,
      approvalPayload.callbackQueryId,
      "Not authorized for this approval.",
    );
    return { status: "rejected", reason: "binding_scope_mismatch" };
  }

  try {
    const decided = await deps.workflow.decide(
      {
        approvalId: approval.id,
        botId: binding.botId,
        sessionId: binding.sessionId,
        runId: approval.runId,
        status: approvalPayload.decision,
        actor: `${valid.integration}:${valid.externalActorId}`,
        decidedAt: formatUtcTimestamp(nowFn()),
      },
      channelIntake,
    );
    await acknowledgeCallbackBestEffort(
      deps,
      approvalPayload.callbackQueryId,
      `Approval recorded: ${decided.decision.status}.`,
    );
    return { status: "decided", approval: decided };
  } catch (error) {
    if (isRetryableCommandError(error)) {
      return {
        status: "retryable",
        reason: error instanceof DomainError ? error.code : "intake.transient_error",
      };
    }

    const code = error instanceof DomainError ? error.code : "approval.rejected";
    await deps.store.recordChannelReceipt({
      integration: valid.integration,
      consumer: deps.consumer,
      externalUpdateId: valid.externalUpdateId,
      disposition: "rejected",
      referenceId: approval.id,
      nextCursor: valid.externalUpdateId,
    });
    const ackText = code === "approval.expired" ? "Approval expired." : "Approval already settled.";
    await acknowledgeCallbackBestEffort(deps, approvalPayload.callbackQueryId, ackText);
    return { status: "rejected", reason: code };
  }
}
