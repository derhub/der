import type {
  Engine,
  EngineEvent,
  EngineReadiness,
  ExecuteResult,
  Run,
  SessionStore,
} from "@der/domain";
import type { LoadEngineRunInput } from "@der/runtime/engines";

const DENIED_TEXT = "Effect execution was denied by operator.";
const EXPIRED_TEXT = "Approval expired before a decision was recorded.";

function outcomeText(operationId: string, result: ExecuteResult): string {
  if (result.ok) {
    return `Applied ${operationId}: ${JSON.stringify(result.result)}`;
  }
  return result.error.kind === "denied" ? DENIED_TEXT : EXPIRED_TEXT;
}

export function createFixtureEngine(
  store: SessionStore,
  loadRunInput: LoadEngineRunInput,
  shutdown?: AbortSignal,
): Engine {
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

      function* reply(content: string, key = "1"): Generator<EngineEvent> {
        yield {
          type: "chunk",
          chunkKey: `${run.id}:delta:${key}`,
          chunk: { type: "TEXT_MESSAGE_CONTENT", messageId, delta: content },
        };
        yield {
          type: "chunk",
          chunkKey: `${run.id}:msg-end`,
          chunk: { type: "TEXT_MESSAGE_END", messageId },
        };
        yield { type: "completed", finalMessage: { parts: [{ type: "text", text: content }] } };
      }

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
        // Like an official engine, whose vendor call fails only after the turn was planned.
        await loadRunInput(run);
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
        yield* reply(firstText.slice("direct:".length).trim() || "Fixture direct reply.");
        return;
      }

      if (firstText.startsWith("tools:")) {
        const input = await loadRunInput(run);
        const names = (input.tools ?? []).map((tool) => tool.name).join(", ");
        yield* reply(`Host tools: ${names}`);
        return;
      }

      const isUncertain = firstText.startsWith("uncertain:");
      const target = isUncertain
        ? firstText.slice("uncertain:".length).trim() || "sensor-1"
        : firstText.trim() || "lamp-1";
      const operationId = isUncertain ? "fixture.uncertain" : "fixture.apply";
      const mode = isUncertain ? "uncertain" : "apply";

      yield {
        type: "chunk",
        chunkKey: `${run.id}:delta:1`,
        chunk: {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: `Requesting approval for ${target}.`,
        },
      };

      const execute = (await loadRunInput(run)).tools?.find((tool) => tool.name === "execute");
      if (execute?.execute === undefined) {
        yield {
          type: "failed",
          code: "engine.fixture_failed",
          detail: "The execute host tool is not available to the fixture engine.",
        };
        return;
      }

      const toolCallId = `${run.id}:execute`;
      const script = `return await der.${operationId}(${JSON.stringify({ target, mode })});`;
      yield {
        type: "chunk",
        chunkKey: `${toolCallId}:start`,
        chunk: { type: "TOOL_CALL_START", toolCallId, toolCallName: "execute" },
      };
      yield {
        type: "chunk",
        chunkKey: `${toolCallId}:args`,
        chunk: { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ script }) },
      };
      yield {
        type: "chunk",
        chunkKey: `${toolCallId}:end`,
        chunk: { type: "TOOL_CALL_END", toolCallId },
      };

      const result = (await execute.execute({ script }, { signal: shutdown })) as ExecuteResult;
      if (shutdown?.aborted) {
        // The process is closing: this attempt is abandoned and the next process resumes the Run.
        await new Promise<never>(() => {});
      }
      yield {
        type: "chunk",
        chunkKey: `${toolCallId}:result`,
        chunk: {
          type: "TOOL_CALL_RESULT",
          messageId,
          toolCallId,
          content: JSON.stringify(result),
        },
      };

      if (!result.ok && result.error.kind !== "denied" && result.error.kind !== "expired") {
        yield { type: "failed", code: "engine.fixture_failed", detail: result.error.message };
        return;
      }
      yield* reply(outcomeText(operationId, result), "post-approval");
    },
  };
}
