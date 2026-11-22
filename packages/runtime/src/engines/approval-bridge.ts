import type { ApprovalId, EffectIdentity, RunId } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { AcpPermissionOutcome, AcpPermissionRequest } from "@tanstack/ai-acp";
import {
  nodeHttpBridgeProvisioner,
  type PermissionToolResult,
  type ProvisionedBridge,
  type ToolBridgeProvisioner,
  type ToolBridgeProvisionOptions,
} from "@tanstack/ai-sandbox";
import type { OfficialEngineKind } from "../sandbox/docker-policy";
import { digestJson, normalizeToJsonValue, redactDiagnostics } from "./redaction";

export type CallbackContinuityState = "verified" | "unverified" | "lost";

export interface ApprovalDecisionOutcome {
  readonly status: "approved" | "denied" | "expired";
  readonly approvalId: ApprovalId;
  readonly effect: EffectIdentity;
  readonly reason?: string;
}

export interface ApprovalRequestInput {
  readonly effect: EffectIdentity;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface ApprovalBroker {
  requestApproval(input: ApprovalRequestInput): Promise<ApprovalDecisionOutcome>;
}

export interface ApprovalBridgeOptions {
  readonly runId: RunId;
  readonly engine: OfficialEngineKind;
  readonly callbackContinuity: CallbackContinuityState;
  readonly broker?: ApprovalBroker;
  readonly allowedOperationIds?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

export interface ApprovalBridge {
  continuityState(): CallbackContinuityState;
  discardedStaleDecisionCount(): number;
  markTransportLost(reason: string): void;
  cancel(reason: string): void;
  mediateAcpPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
  mediateClaudePermission(request: {
    readonly tool_name?: string;
    readonly input?: unknown;
  }): Promise<PermissionToolResult>;
}

const DEFAULT_CLAUDE_OPERATION_IDS = new Set([
  "claude-code:Bash",
  "claude-code:Read",
  "claude-code:Write",
  "claude-code:Edit",
  "claude-code:MultiEdit",
  "claude-code:NotebookEdit",
  "claude-code:Glob",
  "claude-code:Grep",
  "claude-code:WebFetch",
  "claude-code:WebSearch",
  "claude-code:Task",
]);

function sameEffectIdentity(left: EffectIdentity, right: EffectIdentity): boolean {
  return (
    left.runId === right.runId &&
    left.operationKind === right.operationKind &&
    left.operationId === right.operationId &&
    left.attemptId === right.attemptId &&
    JSON.stringify(normalizeToJsonValue(left.canonicalArguments)) ===
      JSON.stringify(normalizeToJsonValue(right.canonicalArguments))
  );
}

export function createApprovalBridge(options: ApprovalBridgeOptions): ApprovalBridge {
  let state: CallbackContinuityState = options.callbackContinuity;
  let cancelled = options.signal?.aborted === true;
  let sequence = 0;
  let discardedStaleCount = 0;

  const activeControllers = new Set<AbortController>();

  const invalidateAll = (nextState: CallbackContinuityState, reason: string) => {
    state = nextState;
    for (const controller of activeControllers) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    }
    activeControllers.clear();
  };

  if (options.signal) {
    const onAbort = () => {
      cancelled = true;
      invalidateAll("lost", "Run cancelled while waiting on permission callback.");
    };
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const requestDecision = async (input: {
    readonly operationId: string;
    readonly rawArguments: unknown;
    readonly prompt: string;
  }): Promise<
    | { readonly ok: true; readonly outcome: ApprovalDecisionOutcome }
    | { readonly ok: false; readonly message: string }
  > => {
    if (cancelled || state !== "verified") {
      return {
        ok: false,
        message:
          state === "lost"
            ? "Permission callback channel lost; stale approvals cannot be applied."
            : "Live permission callback continuity is unverified; failing closed.",
      };
    }

    if (!options.broker) {
      return {
        ok: false,
        message: "No durable approval broker is attached to this engine run.",
      };
    }

    sequence += 1;
    const canonicalArguments = normalizeToJsonValue(input.rawArguments);
    const fingerprint = await digestJson({
      operationId: input.operationId,
      canonicalArguments,
      sequence,
    });
    const effect = compiledParsers.effectIdentity.parse({
      runId: options.runId,
      operationKind: "engine-permission",
      operationId: input.operationId,
      canonicalArguments,
      attemptId: `${options.runId}:perm:${sequence}:${fingerprint}`,
    });

    if (cancelled || state !== "verified") {
      return {
        ok: false,
        message: "Permission callback invalidated before approval request was dispatched.",
      };
    }

    const waitController = new AbortController();
    activeControllers.add(waitController);

    const brokerPromise = options.broker.requestApproval({
      effect,
      prompt: redactDiagnostics(input.prompt),
      signal: waitController.signal,
    });

    let settledLive = false;
    const abortPromise = new Promise<"aborted">((resolve) => {
      if (waitController.signal.aborted) {
        resolve("aborted");
        return;
      }
      waitController.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });

    // Track late decisions arriving after transport loss or cancellation so they are discarded cleanly.
    void brokerPromise.then(
      () => {
        if (!settledLive) {
          discardedStaleCount += 1;
        }
      },
      () => {},
    );

    try {
      const winner = await Promise.race([brokerPromise, abortPromise]);
      if (winner === "aborted" || cancelled || state !== "verified") {
        return {
          ok: false,
          message:
            "Permission callback invalidated before decision settled; stale decision discarded.",
        };
      }

      if (!sameEffectIdentity(winner.effect, effect)) {
        return {
          ok: false,
          message: "Approval decision did not match the requested exact operation identity.",
        };
      }

      settledLive = true;
      return { ok: true, outcome: winner };
    } catch (error) {
      settledLive = true;
      return {
        ok: false,
        message: redactDiagnostics(
          error instanceof Error ? error.message : "Approval broker failed.",
        ),
      };
    } finally {
      activeControllers.delete(waitController);
    }
  };

  return {
    continuityState(): CallbackContinuityState {
      return state;
    },

    discardedStaleDecisionCount(): number {
      return discardedStaleCount;
    },

    markTransportLost(reason: string): void {
      invalidateAll("lost", reason);
    },

    cancel(reason: string): void {
      cancelled = true;
      invalidateAll("lost", reason);
    },

    async mediateAcpPermission(request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
      const kindPart = request.toolCall.kind?.trim() || "tool";
      const titlePart = request.toolCall.title?.trim() || request.toolCall.toolCallId;
      const operationId = `${options.engine}:${kindPart}:${titlePart}`;

      if (
        options.allowedOperationIds !== undefined &&
        !options.allowedOperationIds.has(operationId)
      ) {
        const rejectOption = request.options.find((opt) => opt.kind === "reject_once");
        return rejectOption
          ? { outcome: "selected", optionId: rejectOption.optionId }
          : { outcome: "cancelled" };
      }

      const result = await requestDecision({
        operationId,
        rawArguments: request.toolCall.rawInput ?? {},
        prompt: `Approve ${operationId}?`,
      });

      if (!result.ok) {
        return { outcome: "cancelled" };
      }

      if (result.outcome.status === "approved") {
        // Never select allow_always so one exact-operation approval cannot authorize later actions.
        const allowOnce = request.options.find((opt) => opt.kind === "allow_once");
        return allowOnce
          ? { outcome: "selected", optionId: allowOnce.optionId }
          : { outcome: "cancelled" };
      }

      if (result.outcome.status === "denied") {
        const rejectOnce = request.options.find((opt) => opt.kind === "reject_once");
        return rejectOnce
          ? { outcome: "selected", optionId: rejectOnce.optionId }
          : { outcome: "cancelled" };
      }

      return { outcome: "cancelled" };
    },

    async mediateClaudePermission(request: {
      readonly tool_name?: string;
      readonly input?: unknown;
    }): Promise<PermissionToolResult> {
      const toolName = request.tool_name?.trim() ?? "";
      if (toolName.length === 0) {
        return {
          behavior: "deny",
          message: "Unrecognized host operation: missing tool_name.",
        };
      }

      const operationId = `claude-code:${toolName}`;
      const allowedSet = options.allowedOperationIds ?? DEFAULT_CLAUDE_OPERATION_IDS;
      const isBridgedMcpTool = toolName.startsWith("mcp__");
      if (!isBridgedMcpTool && !allowedSet.has(operationId)) {
        return {
          behavior: "deny",
          message: `Unrecognized host operation "${toolName}" denied by default.`,
        };
      }

      const result = await requestDecision({
        operationId,
        rawArguments: request.input ?? {},
        prompt: `Approve Claude Code tool ${toolName}?`,
      });

      if (!result.ok) {
        return {
          behavior: "deny",
          message: result.message,
        };
      }

      if (result.outcome.status === "approved") {
        return {
          behavior: "allow",
          ...(request.input !== undefined ? { updatedInput: request.input } : {}),
        };
      }

      return {
        behavior: "deny",
        message:
          result.outcome.status === "expired"
            ? "Approval expired before operator decision."
            : (result.outcome.reason ?? "Operation denied by operator."),
      };
    },
  };
}

export function createDurableApprovalBridgeProvisioner(
  bridge: ApprovalBridge,
  innerProvisioner: ToolBridgeProvisioner = nodeHttpBridgeProvisioner,
): ToolBridgeProvisioner {
  return {
    async provision(tools, options: ToolBridgeProvisionOptions): Promise<ProvisionedBridge> {
      const wrappedOptions: ToolBridgeProvisionOptions = options.permission
        ? {
            ...options,
            permission: {
              toolName: options.permission.toolName,
              resolve: (input) => bridge.mediateClaudePermission(input),
            },
          }
        : options;

      return innerProvisioner.provision(tools, wrappedOptions);
    },
  };
}
