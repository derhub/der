import type { Engine, EngineEvent, EngineReadiness, Run } from "@der/domain";
import { chat } from "@tanstack/ai";
import { acpCompatible } from "@tanstack/ai-acp";
import { defineSandbox, withSandbox, type SandboxProvider } from "@tanstack/ai-sandbox";
import { DEFAULT_ENGINE_SHADOW_HOMES } from "../sandbox/docker-policy";
import { createApprovalBridge, type CallbackContinuityState } from "./approval-bridge";
import {
  bridgeAdapterStream,
  checkRunReadinessGate,
  linkAbortSignal,
  type LoadEngineRunInput,
} from "./stream-bridge";

/**
 * `agy acp` answers `session/load` for an unknown id with that same id, then fails the first
 * prompt with "not_found: trajectory not found: <id>".
 */
const UNKNOWN_TRAJECTORY_MESSAGE = /trajectory not found/i;

export interface AntigravityEngineConfig {
  readonly model: string;
  readonly sandboxProvider: SandboxProvider;
  readonly diagnose: () => Promise<EngineReadiness>;
  readonly loadRunInput: LoadEngineRunInput;
  readonly callbackContinuity?: CallbackContinuityState;
  readonly allowedOperationIds?: ReadonlySet<string>;
  readonly agyExecutable?: string;
  readonly cwd?: string;
  readonly appDataDir?: string;
  readonly geminiDir?: string;
  readonly env?: Record<string, string>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildAntigravityAcpCommand(config: {
  readonly executable?: string;
  readonly appDataDir?: string;
  readonly geminiDir?: string;
}): string {
  const executable = config.executable ?? "agy";
  const appDataDir = config.appDataDir ?? "/home/engine/.antigravity";
  const geminiDir = config.geminiDir ?? "/home/engine/.gemini";
  return `${executable} acp --stdio --disable-telemetry --app-data-dir ${shellQuote(appDataDir)} --gemini-dir ${shellQuote(geminiDir)}`;
}

export function createAntigravityEngine(config: AntigravityEngineConfig): Engine {
  return {
    kind: "antigravity",
    resumable: true,

    async diagnose(): Promise<EngineReadiness> {
      return config.diagnose();
    },

    async *run(run: Run): AsyncIterable<EngineEvent> {
      const readiness = await config.diagnose();
      const gateFailure = checkRunReadinessGate(run, readiness);
      if (gateFailure) {
        yield gateFailure;
        return;
      }

      const input = await config.loadRunInput(run);
      const resumeSessionId = input.resumeSessionId;
      const { controller, release } = linkAbortSignal(input.signal);

      const approvalBridge = createApprovalBridge({
        runId: run.id,
        engine: "antigravity",
        callbackContinuity: config.callbackContinuity ?? "unverified",
        ...(input.approvalBroker !== undefined ? { broker: input.approvalBroker } : {}),
        ...(config.allowedOperationIds !== undefined
          ? { allowedOperationIds: config.allowedOperationIds }
          : {}),
        signal: controller.signal,
      });

      const antigravity = acpCompatible({
        name: "antigravity",
        cwd: config.cwd ?? "/workspace",
        authMode: "host",
        command: () =>
          buildAntigravityAcpCommand({
            ...(config.agyExecutable !== undefined ? { executable: config.agyExecutable } : {}),
            ...(config.appDataDir !== undefined ? { appDataDir: config.appDataDir } : {}),
            ...(config.geminiDir !== undefined ? { geminiDir: config.geminiDir } : {}),
          }),
        env: {
          ...DEFAULT_ENGINE_SHADOW_HOMES.antigravity.envOverrides,
          ...config.env,
        },
        onPermissionRequest: (request) => approvalBridge.mediateAcpPermission(request),
      });

      const sandbox = defineSandbox({
        id: `der-antigravity-${run.sessionId}`,
        provider: config.sandboxProvider,
        lifecycle: { reuse: "none", destroyOnComplete: true },
        fileEvents: false,
      });

      try {
        const stream = chat({
          adapter: antigravity(config.model),
          messages: input.messages,
          systemPrompts: resumeSessionId !== undefined ? [] : (input.systemPrompts ?? []),
          tools: input.tools ?? [],
          modelOptions: resumeSessionId !== undefined ? { sessionId: resumeSessionId } : {},
          threadId: run.sessionId,
          runId: run.id,
          abortController: controller,
          middleware: [withSandbox(sandbox)],
        });

        yield* bridgeAdapterStream({
          run,
          stream,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          abortController: controller,
          approvalBridge,
          sessionIdEventName: "antigravity.session-id",
          isResumeFailure: (message) => UNKNOWN_TRAJECTORY_MESSAGE.test(message),
          ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        });
      } finally {
        release();
      }
    },
  };
}
