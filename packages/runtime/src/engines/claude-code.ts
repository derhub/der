import type { Engine, EngineEvent, EngineReadiness, Run } from "@der/domain";
import { chat, defineChatMiddleware } from "@tanstack/ai";
import {
  claudeCodeText,
  type ClaudeCodeModel,
  type ClaudeCodePermissionMode,
  type ClaudeCodeSettingSource,
} from "@tanstack/ai-claude-code";
import {
  defineSandbox,
  defineSandboxPolicy,
  provideToolBridgeProvisioner,
  ToolBridgeProvisionerCapability,
  withSandbox,
  type SandboxPolicy,
  type SandboxProvider,
  type ToolBridgeProvisioner,
} from "@tanstack/ai-sandbox";
import { DEFAULT_ENGINE_SHADOW_HOMES } from "../sandbox/docker-policy";
import {
  createApprovalBridge,
  createDurableApprovalBridgeProvisioner,
  type CallbackContinuityState,
} from "./approval-bridge";
import {
  bridgeAdapterStream,
  checkRunReadinessGate,
  linkAbortSignal,
  type LoadEngineRunInput,
} from "./stream-bridge";

/** `claude --resume <unknown id> -p` exits 1 with "No conversation found with session ID: <id>" on stderr. */
const UNKNOWN_SESSION_MESSAGE = /No conversation found with session ID/i;

export interface ClaudeCodeEngineConfig {
  readonly model: ClaudeCodeModel;
  readonly sandboxProvider: SandboxProvider;
  readonly diagnose: () => Promise<EngineReadiness>;
  readonly loadRunInput: LoadEngineRunInput;
  readonly callbackContinuity?: CallbackContinuityState;
  readonly toolBridgeProvisioner?: ToolBridgeProvisioner;
  readonly allowedOperationIds?: ReadonlySet<string>;
  readonly claudeExecutable?: string;
  readonly cwd?: string;
  readonly permissionMode?: ClaudeCodePermissionMode;
  readonly settingSources?: Array<ClaudeCodeSettingSource>;
  readonly policy?: SandboxPolicy;
  readonly emitDiff?: boolean;
  readonly env?: Record<string, string>;
  readonly autoCompactTokens?: number;
}

function withToolBridgeProvisioner(provisioner: ToolBridgeProvisioner) {
  return defineChatMiddleware({
    name: "der-claude-approval-bridge",
    provides: [ToolBridgeProvisionerCapability],
    setup(ctx) {
      provideToolBridgeProvisioner(ctx, provisioner);
    },
  });
}

export function createClaudeCodeEngine(config: ClaudeCodeEngineConfig): Engine {
  return {
    kind: "claude-code",
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
        engine: "claude-code",
        callbackContinuity: config.callbackContinuity ?? "unverified",
        ...(input.approvalBroker !== undefined ? { broker: input.approvalBroker } : {}),
        ...(config.allowedOperationIds !== undefined
          ? { allowedOperationIds: config.allowedOperationIds }
          : {}),
        signal: controller.signal,
      });

      const durableProvisioner = createDurableApprovalBridgeProvisioner(
        approvalBridge,
        config.toolBridgeProvisioner,
      );

      const adapter = claudeCodeText(config.model, {
        cwd: config.cwd ?? "/workspace",
        authMode: "host",
        settingSources: config.settingSources ?? ["project"],
        emitDiff: config.emitDiff ?? false,
        ...(config.permissionMode !== undefined ? { permissionMode: config.permissionMode } : {}),
        ...(config.claudeExecutable !== undefined
          ? { claudeExecutable: config.claudeExecutable }
          : {}),
        env: {
          ...DEFAULT_ENGINE_SHADOW_HOMES["claude-code"].envOverrides,
          ...(config.autoCompactTokens !== undefined
            ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(config.autoCompactTokens) }
            : {}),
          ...config.env,
        },
      });

      const sandbox = defineSandbox({
        id: `der-claude-code-${run.sessionId}`,
        provider: config.sandboxProvider,
        policy: config.policy ?? defineSandboxPolicy({ default: "ask" }),
        lifecycle: { reuse: "none", destroyOnComplete: true },
        fileEvents: false,
      });

      try {
        const stream = chat({
          adapter,
          messages: input.messages,
          systemPrompts: input.systemPrompts ?? [],
          tools: input.tools ?? [],
          modelOptions: resumeSessionId !== undefined ? { sessionId: resumeSessionId } : {},
          threadId: run.sessionId,
          runId: run.id,
          abortController: controller,
          middleware: [withToolBridgeProvisioner(durableProvisioner), withSandbox(sandbox)],
        });

        yield* bridgeAdapterStream({
          run,
          stream,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          abortController: controller,
          approvalBridge,
          sessionIdEventName: "claude-code.session-id",
          isResumeFailure: (message) => UNKNOWN_SESSION_MESSAGE.test(message),
          ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        });
      } finally {
        release();
      }
    },
  };
}
