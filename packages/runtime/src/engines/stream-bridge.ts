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
  readonly resumeSessionId?: string;
  readonly requireResume?: boolean;
}

export type LoadEngineRunInput = (run: Run) => Promise<EngineRunInput>;

export interface EngineResumeTraits {
  /** The engine resumes its vendor session between Runs; otherwise every Run rebuilds. */
  readonly resumable: boolean;
  /** True when an engine error message means the vendor refused the session it was asked to resume. */
  readonly isResumeFailure: (message: string) => boolean;
}

/** Vendor session id carried by an engine's `<engine>.session-id` chunk, if `chunk` is one. */
export function readSessionIdChunk(chunk: JsonValue): string | undefined {
  if (
    !isRecord(chunk) ||
    chunk["type"] !== "CUSTOM" ||
    typeof chunk["name"] !== "string" ||
    !chunk["name"].endsWith(".session-id") ||
    !isRecord(chunk["value"])
  ) {
    return undefined;
  }
  const sessionId = chunk["value"]["sessionId"];
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export function extractCheckpointSessionId(run: Run): string | undefined {
  if (
    run.checkpoint !== null &&
    typeof run.checkpoint === "object" &&
    !Array.isArray(run.checkpoint) &&
    typeof run.checkpoint["sessionId"] === "string" &&
    run.checkpoint["sessionId"].length > 0
  ) {
    return run.checkpoint["sessionId"];
  }
  return undefined;
}

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

export function isBroadResumeFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  const mentionsSession =
    lower.includes("resume") ||
    lower.includes("not found") ||
    lower.includes("no such session") ||
    lower.includes("session") ||
    lower.includes("thread");
  return mentionsSession || isTransportLossMessage(message);
}

export async function* bridgeAdapterStream(options: {
  readonly run: Run;
  readonly stream: AsyncIterable<StreamChunk>;
  readonly signal?: AbortSignal;
  readonly abortController: AbortController;
  readonly approvalBridge?: ApprovalBridge;
  readonly sessionIdEventName: string;
  readonly expectedResumeSessionId?: string;
  readonly requireResume?: boolean;
  readonly isResumeFailure?: (message: string) => boolean;
}): AsyncIterable<EngineEvent> {
  const isResumeFailure = options.isResumeFailure ?? isBroadResumeFailureMessage;
  let seq = 0;
  let assistantText = "";
  let sawTerminal = false;
  let resumeMismatchDetail: string | undefined;
  let resumeAccepted = false;
  const isUnacceptedResume = () =>
    options.requireResume === true &&
    options.expectedResumeSessionId !== undefined &&
    !resumeAccepted;

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

      if (
        options.requireResume &&
        options.expectedResumeSessionId !== undefined &&
        chunkType === "CUSTOM" &&
        chunk["name"] === options.sessionIdEventName &&
        chunk["value"] !== null &&
        typeof chunk["value"] === "object"
      ) {
        const value = chunk["value"] as Record<string, unknown>;
        const observedSessionId =
          typeof value["sessionId"] === "string" ? value["sessionId"] : undefined;
        if (observedSessionId === options.expectedResumeSessionId) {
          resumeAccepted = true;
        }
        if (
          observedSessionId !== undefined &&
          observedSessionId !== options.expectedResumeSessionId
        ) {
          resumeMismatchDetail = `Engine could not resume session "${options.expectedResumeSessionId}"; started fresh session "${observedSessionId}" instead.`;
          options.approvalBridge?.markTransportLost(resumeMismatchDetail);
          options.abortController.abort(resumeMismatchDetail);
          yield {
            type: "failed",
            code: "engine.resume_unavailable",
            detail: resumeMismatchDetail,
          };
          return;
        }
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
        if (isUnacceptedResume() && isResumeFailure(message)) {
          options.approvalBridge?.markTransportLost(message);
          yield {
            type: "failed",
            code: "engine.resume_unavailable",
            detail: `Unable to resume session "${options.expectedResumeSessionId}": ${message}`,
          };
          return;
        }
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
          ...(assistantText.length > 0
            ? { finalMessage: { parts: [{ type: "text", text: assistantText }] } }
            : {}),
        });
        return;
      }

      seq += 1;
      const normalizedChunk: JsonValue = normalizeToJsonValue(chunk);
      yield compiledParsers.engineEvent.parse({
        type: "chunk",
        chunkKey: `${options.run.id}:${seq}:${chunkType}`,
        chunk: normalizedChunk,
      });
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
      code: isUnacceptedResume() ? "engine.resume_unavailable" : "engine.transport_lost",
      detail: message,
    };
    return;
  }

  if (resumeMismatchDetail !== undefined) {
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
      code: isUnacceptedResume() ? "engine.resume_unavailable" : "engine.transport_lost",
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
