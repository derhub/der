import type { Engine, EngineEvent, EngineReadiness, Run } from "@der/domain";
import { chat } from "@tanstack/ai";
import {
  codexText,
  type CodexApprovalMode,
  type CodexModel,
  type CodexSandboxMode,
} from "@tanstack/ai-codex";
import { defineSandbox, withSandbox, type SandboxProvider } from "@tanstack/ai-sandbox";
import { DEFAULT_ENGINE_SHADOW_HOMES } from "../sandbox/docker-policy";
import {
  bridgeAdapterStream,
  checkRunReadinessGate,
  extractCheckpointSessionId,
  linkAbortSignal,
  type LoadEngineRunInput,
} from "./stream-bridge";

export interface CodexEngineConfig {
  readonly model: CodexModel;
  readonly sandboxProvider: SandboxProvider;
  readonly diagnose: () => Promise<EngineReadiness>;
  readonly loadRunInput: LoadEngineRunInput;
  readonly codexExecutable?: string;
  readonly cwd?: string;
  readonly sandboxMode?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalMode;
  readonly env?: Record<string, string>;
}

export function createCodexEngine(config: CodexEngineConfig): Engine {
  return {
    kind: "codex",

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
      const resumeSessionId = input.resumeSessionId ?? extractCheckpointSessionId(run);
      const { controller, release } = linkAbortSignal(input.signal);

      // Keep authMode="api-key" without host API keys so @tanstack/ai-codex never reads host ~/.codex
      // while the container's named shadow-home volume provides CODEX_HOME auth natively.
      const containerEnv: Record<string, string> = {
        ...DEFAULT_ENGINE_SHADOW_HOMES.codex.envOverrides,
        ...config.env,
      };
      delete containerEnv["CODEX_API_KEY"];
      delete containerEnv["OPENAI_API_KEY"];

      const adapter = codexText(config.model, {
        cwd: config.cwd ?? "/workspace",
        sandboxMode: config.sandboxMode ?? "workspace-write",
        approvalPolicy: config.approvalPolicy ?? "never",
        authMode: "api-key",
        ...(config.codexExecutable !== undefined
          ? { codexExecutable: config.codexExecutable }
          : {}),
        env: containerEnv,
      });

      const sandbox = defineSandbox({
        id: `der-codex-${run.sessionId}`,
        provider: config.sandboxProvider,
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
          middleware: [withSandbox(sandbox)],
        });

        yield* bridgeAdapterStream({
          run,
          stream,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          abortController: controller,
          sessionIdEventName: "codex.session-id",
          ...(resumeSessionId !== undefined ? { expectedResumeSessionId: resumeSessionId } : {}),
          ...(input.requireResume !== undefined ? { requireResume: input.requireResume } : {}),
        });
      } finally {
        release();
      }
    },
  };
}
