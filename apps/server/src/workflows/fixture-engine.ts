import type {
  Engine,
  EngineEvent,
  EngineReadiness,
  Run,
  SessionStore,
  ToolDescriptor,
  ToolOperation,
  ToolResult,
  Tools,
} from "@der/domain";

export class UncertainEffectError extends Error {
  readonly code = "effect.outcome_uncertain";

  constructor(message: string) {
    super(message);
    this.name = "UncertainEffectError";
  }
}

export interface FixtureToolRecord {
  readonly operationId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly canonicalArguments: unknown;
}

export interface FixtureToolsOptions {
  readonly onInvoke?: (operation: ToolOperation) => void | Promise<void>;
}

export function createFixtureEngine(store: SessionStore): Engine {
  return {
    kind: "fixture",
    async diagnose(): Promise<EngineReadiness> {
      return {
        engine: "fixture",
        interactive: "ready",
        unattended: "ready",
        isolationVerified: true,
        reasons: [],
      };
    },
    async *run(run: Run): AsyncIterable<EngineEvent> {
      const messages = await store.listMessages(run.sessionId);
      const triggerMessage = messages.find((msg) => msg.runId === run.id && msg.role === "user");
      const firstText = triggerMessage?.parts.find((part) => part.type === "text")?.text ?? "";
      const messageId = `msg_stream_${run.id}`;

      yield {
        type: "chunk",
        chunkKey: `${run.id}:started`,
        chunk: {
          type: "RUN_STARTED",
          threadId: run.sessionId,
          runId: run.id,
        },
      };

      if (firstText.startsWith("fail:")) {
        yield {
          type: "failed",
          code: "engine.fixture_failed",
          detail: firstText.slice("fail:".length).trim() || "Fixture engine reported failure.",
        };
        return;
      }

      yield {
        type: "chunk",
        chunkKey: `${run.id}:msg-start`,
        chunk: {
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant",
        },
      };

      if (firstText.startsWith("direct:")) {
        const reply = firstText.slice("direct:".length).trim() || "Fixture direct reply.";
        yield {
          type: "chunk",
          chunkKey: `${run.id}:delta:1`,
          chunk: {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: reply,
          },
        };
        yield {
          type: "chunk",
          chunkKey: `${run.id}:msg-end`,
          chunk: {
            type: "TEXT_MESSAGE_END",
            messageId,
          },
        };
        yield {
          type: "completed",
          finalMessage: {
            parts: [{ type: "text", text: reply }],
          },
        };
        return;
      }

      const isUncertain = firstText.startsWith("uncertain:");
      const target = isUncertain
        ? firstText.slice("uncertain:".length).trim() || "sensor-1"
        : firstText.trim() || "lamp-1";

      yield {
        type: "chunk",
        chunkKey: `${run.id}:delta:1`,
        chunk: {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: `Requesting approval for ${target}.`,
        },
      };

      yield {
        type: "approval_required",
        effect: {
          runId: run.id,
          operationKind: "fixture",
          operationId: isUncertain ? "fixture.uncertain" : "fixture.apply",
          canonicalArguments: { target, mode: isUncertain ? "uncertain" : "apply" },
          attemptId: "attempt-1",
        },
        prompt: `Approve ${isUncertain ? "fixture.uncertain" : "fixture.apply"} for ${target}?`,
      };
    },
  };
}

export function createFixtureTools(options?: FixtureToolsOptions): Tools & {
  readonly applied: FixtureToolRecord[];
} {
  const applied: FixtureToolRecord[] = [];
  const descriptors: readonly ToolDescriptor[] = [
    {
      kind: "fixture",
      id: "fixture.apply",
      name: "Fixture Apply",
      description: "Applies one deterministic credential-free fixture effect.",
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          mode: { type: "string" },
        },
      },
    },
    {
      kind: "fixture",
      id: "fixture.uncertain",
      name: "Fixture Uncertain",
      description: "Simulates a dispatched effect whose upstream response is lost.",
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          mode: { type: "string" },
        },
      },
    },
  ];

  return {
    applied,
    async list() {
      return descriptors;
    },
    async invoke(operation: ToolOperation): Promise<ToolResult> {
      await options?.onInvoke?.(operation);
      const { effect } = operation;
      if (effect.operationKind !== "fixture") {
        return {
          ok: false,
          isError: true,
          outcome: null,
          detail: `Unsupported host operation kind "${effect.operationKind}".`,
        };
      }

      if (effect.operationId === "fixture.uncertain") {
        throw new UncertainEffectError(
          `Upstream response lost after dispatching ${effect.operationId} for run ${effect.runId}.`,
        );
      }

      if (effect.operationId !== "fixture.apply") {
        return {
          ok: false,
          isError: true,
          outcome: null,
          detail: `Unrecognized fixture operation "${effect.operationId}".`,
        };
      }

      applied.push({
        operationId: effect.operationId,
        attemptId: effect.attemptId,
        runId: effect.runId,
        canonicalArguments: effect.canonicalArguments,
      });

      return {
        ok: true,
        isError: false,
        outcome: {
          applied: true,
          operationId: effect.operationId,
          arguments: effect.canonicalArguments,
        },
      };
    },
  };
}
