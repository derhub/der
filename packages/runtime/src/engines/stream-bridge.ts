import type { EngineEvent, EngineReadiness, JsonValue, Run, RunUsage } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { AnyTool, ModelMessage, StreamChunk } from "@tanstack/ai";
import type { ApprovalBridge, ApprovalBroker } from "./approval-bridge";
import { assertUnattendedEligible } from "./doctor";
import { normalizeToJsonValue, redactDiagnostics } from "./redaction";

export interface EngineRunInput {
  readonly messages: Array<ModelMessage>;
  readonly systemPrompts?: Array<string>;
  readonly tools?: Array<AnyTool>;
  readonly signal?: AbortSignal;
  readonly approvalBroker?: ApprovalBroker;
  /** Vendor session to resume; the turn fails with `engine.resume_unavailable` if it is refused. */
  readonly resumeSessionId?: string;
}

export type LoadEngineRunInput = (run: Run) => Promise<EngineRunInput>;

export function checkRunReadinessGate(
  run: Run,
  readiness: EngineReadiness,
): EngineEvent | undefined {
  if (!readiness.isolationVerified) {
    return {
      type: "failed",
      code: "engine.isolation_unverified",
      detail:
        readiness.reasons.join("; ") ||
        `Engine "${readiness.engine}" failed isolation verification.`,
    };
  }

  if (run.origin === "routine") {
    const unattended = assertUnattendedEligible(readiness);
    if (!unattended.allowed) {
      return {
        type: "failed",
        code: "engine.unattended_blocked",
        detail: unattended.reason,
      };
    }
    return undefined;
  }

  if (readiness.interactive !== "ready") {
    return {
      type: "failed",
      code:
        readiness.interactive === "login_required" ? "engine.login_required" : "engine.not_ready",
      detail:
        readiness.loginGuidance ??
        (readiness.reasons.join("; ") || `Engine "${readiness.engine}" is not ready.`),
    };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Usage carried by an adapter `RUN_FINISHED` chunk, raw or as persisted in run events. */
export function readRunUsage(finished: Record<string, unknown>): RunUsage | undefined {
  const usage = finished["usage"];
  if (
    !isRecord(usage) ||
    typeof usage["promptTokens"] !== "number" ||
    typeof usage["completionTokens"] !== "number"
  ) {
    return undefined;
  }
  const details = isRecord(usage["promptTokensDetails"]) ? usage["promptTokensDetails"] : {};
  return {
    inputTokens: usage["promptTokens"],
    cachedInputTokens: countOrNull(details["cachedTokens"]),
    cacheWriteTokens: countOrNull(details["cacheWriteTokens"]),
    outputTokens: usage["completionTokens"],
    reportedCostUsd: countOrNull(usage["cost"]),
  };
}

function isTransportLossMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("exited with code") ||
    lower.includes("exited unexpectedly") ||
    lower.includes("process exited") ||
    lower.includes("transport") ||
    lower.includes("eof") ||
    lower.includes("closed") ||
    lower.includes("disconnected") ||
    lower.includes("stream ended")
  );
}

function isBroadResumeFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  const mentionsSession =
    lower.includes("resume") ||
    lower.includes("not found") ||
    lower.includes("no such session") ||
    lower.includes("session") ||
    lower.includes("thread");
  return mentionsSession || isTransportLossMessage(message);
}

function isAssistantOutput(chunkType: string): boolean {
  return chunkType === "TEXT_MESSAGE_CONTENT" || chunkType.startsWith("TOOL_CALL_");
}

/**
 * Translates adapter chunks into engine events. A resumed turn holds its chunks until the first
 * assistant content or tool call, the point where the vendor has accepted the session; a refusal
 * before it is `engine.resume_unavailable` and yields none of them, any other vendor error yields
 * them first. `isResumeFailure` narrows which vendor-reported errors count as a refusal, so a
 * transient vendor error does not discard the session.
 */
export async function* bridgeAdapterStream(options: {
  readonly run: Run;
  readonly stream: AsyncIterable<StreamChunk>;
  readonly signal?: AbortSignal;
  readonly abortController: AbortController;
  readonly approvalBridge?: ApprovalBridge;
  readonly sessionIdEventName: string;
  readonly resumeSessionId?: string;
  readonly isResumeFailure?: (message: string) => boolean;
}): AsyncIterable<EngineEvent> {
  const isResumeFailure = options.isResumeFailure ?? isBroadResumeFailureMessage;
  const resumeSessionId = options.resumeSessionId;
  let seq = 0;
  let assistantText = "";
  let sawTerminal = false;
  let vendorSessionId = resumeSessionId;
  let held: EngineEvent[] | undefined = resumeSessionId !== undefined ? [] : undefined;
  const release = (): EngineEvent[] => {
    const released = held ?? [];
    held = undefined;
    return released;
  };

  try {
    for await (const rawChunk of options.stream) {
      if (options.signal?.aborted) {
        options.approvalBridge?.cancel("Run cancelled by abort signal.");
        yield {
          type: "failed",
          code: "engine.cancelled",
          detail: "Engine run was cancelled.",
        };
        return;
      }

      const chunk = rawChunk as Record<string, unknown>;
      const chunkType = typeof chunk["type"] === "string" ? chunk["type"] : "UNKNOWN";

      const sessionValue =
        chunkType === "CUSTOM" && chunk["name"] === options.sessionIdEventName
          ? chunk["value"]
          : undefined;
      if (isRecord(sessionValue) && typeof sessionValue["sessionId"] === "string") {
        const observedSessionId = sessionValue["sessionId"];
        if (held !== undefined && observedSessionId !== resumeSessionId) {
          // The abort makes the adapter cancel the fresh session, but an ACP adapter has already
          // sent it the prompt: whatever the vendor does before the cancel lands is not undone.
          const detail = `Engine could not resume session "${resumeSessionId}"; started fresh session "${observedSessionId}" instead.`;
          options.approvalBridge?.markTransportLost(detail);
          options.abortController.abort(detail);
          yield { type: "failed", code: "engine.resume_unavailable", detail };
          return;
        }
        vendorSessionId = observedSessionId;
      }

      if (chunkType === "TEXT_MESSAGE_CONTENT" && typeof chunk["delta"] === "string") {
        assistantText += chunk["delta"];
      }

      if (chunkType === "RUN_ERROR") {
        sawTerminal = true;
        const message = redactDiagnostics(
          typeof chunk["message"] === "string" && chunk["message"].length > 0
            ? chunk["message"]
            : "Engine run failed.",
        );
        if (options.signal?.aborted) {
          options.approvalBridge?.cancel(message);
          yield {
            type: "failed",
            code: "engine.cancelled",
            detail: "Engine run was cancelled.",
          };
          return;
        }
        if (held !== undefined && isResumeFailure(message)) {
          options.approvalBridge?.markTransportLost(message);
          yield {
            type: "failed",
            code: "engine.resume_unavailable",
            detail: `Unable to resume session "${resumeSessionId}": ${message}`,
          };
          return;
        }
        yield* release();
        if (isTransportLossMessage(message)) {
          options.approvalBridge?.markTransportLost(message);
          yield {
            type: "failed",
            code: "engine.transport_lost",
            detail: message,
          };
          return;
        }
        const rawCode =
          typeof chunk["code"] === "string" && chunk["code"].length > 0
            ? chunk["code"]
            : "engine.run_error";
        yield {
          type: "failed",
          code: rawCode,
          detail: message,
        };
        return;
      }

      if (chunkType === "RUN_FINISHED") {
        sawTerminal = true;
        if (options.signal?.aborted) {
          options.approvalBridge?.cancel("Run cancelled by abort signal.");
          yield {
            type: "failed",
            code: "engine.cancelled",
            detail: "Engine run was cancelled.",
          };
          return;
        }
        yield* release();
        seq += 1;
        const normalizedChunk: JsonValue = normalizeToJsonValue(chunk);
        yield compiledParsers.engineEvent.parse({
          type: "chunk",
          chunkKey: `${options.run.id}:${seq}:${chunkType}`,
          chunk: normalizedChunk,
          isTerminal: true,
        });
        const usage = readRunUsage(chunk);
        yield compiledParsers.engineEvent.parse({
          type: "completed",
          ...(usage !== undefined ? { usage } : {}),
          ...(vendorSessionId !== undefined ? { vendorSessionId } : {}),
          ...(assistantText.length > 0
            ? { finalMessage: { parts: [{ type: "text", text: assistantText }] } }
            : {}),
        });
        return;
      }

      seq += 1;
      const normalizedChunk: JsonValue = normalizeToJsonValue(chunk);
      const event = compiledParsers.engineEvent.parse({
        type: "chunk",
        chunkKey: `${options.run.id}:${seq}:${chunkType}`,
        chunk: normalizedChunk,
      });
      if (held !== undefined && !isAssistantOutput(chunkType)) {
        held.push(event);
        continue;
      }
      yield* release();
      yield event;
    }
  } catch (error) {
    const message = redactDiagnostics(error instanceof Error ? error.message : String(error));
    if (options.signal?.aborted) {
      options.approvalBridge?.cancel(message);
      yield {
        type: "failed",
        code: "engine.cancelled",
        detail: "Engine run was cancelled.",
      };
      return;
    }
    options.approvalBridge?.markTransportLost(message);
    yield {
      type: "failed",
      code: held !== undefined ? "engine.resume_unavailable" : "engine.transport_lost",
      detail: message,
    };
    return;
  }

  if (options.signal?.aborted) {
    options.approvalBridge?.cancel("Run cancelled by abort signal.");
    yield {
      type: "failed",
      code: "engine.cancelled",
      detail: "Engine run was cancelled.",
    };
    return;
  }

  if (!sawTerminal) {
    options.approvalBridge?.markTransportLost("Engine stream ended without a terminal event.");
    yield {
      type: "failed",
      code: held !== undefined ? "engine.resume_unavailable" : "engine.transport_lost",
      detail: "Engine process transport closed before completing the run.",
    };
  }
}

export function linkAbortSignal(signal?: AbortSignal): {
  readonly controller: AbortController;
  readonly release: () => void;
} {
  const controller = new AbortController();
  if (!signal) {
    return { controller, release: () => {} };
  }
  const onAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  if (signal.aborted) {
    onAbort();
    return { controller, release: () => {} };
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    release: () => signal.removeEventListener("abort", onAbort),
  };
}
