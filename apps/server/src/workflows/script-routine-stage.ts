import {
  streamChunk,
  type ExecuteResult,
  type Run,
  type RoutineStore,
  type ScriptStore,
} from "@der/domain";
import { routineScriptId } from "../scripts/script-execution";
import type { ScriptDriver } from "../scripts/script-driver";
import type { RunStageResult, WorkflowDeps } from "./run-steps";

export interface ScriptRoutineDeps {
  readonly routines: Pick<RoutineStore, "getRoutine">;
  readonly scriptRunStore: Pick<ScriptStore, "acquire" | "load">;
  readonly scriptDriver: ScriptDriver;
}

function failed(code: string, detail: string): RunStageResult {
  return { kind: "failed", code, detail };
}

function resultText(result: Extract<ExecuteResult, { ok: true }>): string {
  return `Script result: ${JSON.stringify(result.result) ?? "null"}`;
}

export async function executeScriptRoutineStage(
  deps: WorkflowDeps,
  run: Run,
): Promise<RunStageResult> {
  const scripts = deps.scriptRoutines?.();
  if (scripts === undefined) {
    return failed("script.not_configured", "Script routines are not configured on this server.");
  }
  const current = (await deps.store.getRun(run.id)) ?? run;
  const resumedId = routineScriptId(current);
  const routine =
    resumedId !== undefined || run.routineId === null
      ? undefined
      : await scripts.routines.getRoutine(run.routineId);
  if (resumedId === undefined && routine?.engine !== "script") {
    return failed("script.routine_missing", `Run ${run.id} does not belong to a script routine.`);
  }
  const execution =
    resumedId !== undefined
      ? scripts.scriptRunStore.load(resumedId).execution
      : scripts.scriptRunStore.acquire({
          runId: run.id,
          botId: run.botId,
          source: routine!.script!,
          seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
        });

  const toolCallId = `${run.id}:execute`;
  const messageId = `msg_stream_${run.id}`;
  await deps.store.appendRunEvents(run.id, [
    {
      chunkKey: `${run.id}:started`,
      chunk: streamChunk({ type: "RUN_STARTED", threadId: run.sessionId, runId: run.id }),
    },
    {
      chunkKey: `${toolCallId}:start`,
      chunk: streamChunk({ type: "TOOL_CALL_START", toolCallId, toolCallName: "execute" }),
    },
    {
      chunkKey: `${toolCallId}:args`,
      chunk: streamChunk({
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify({ script: execution.source }),
      }),
    },
    { chunkKey: `${toolCallId}:end`, chunk: streamChunk({ type: "TOOL_CALL_END", toolCallId }) },
  ]);

  if (resumedId === undefined) {
    await deps.store.markRunRunning(run.id, { scriptRunId: execution.id });
  }
  const result = await scripts.scriptDriver.wait(execution.id, new AbortController().signal);

  if ((await deps.store.getRun(run.id))?.status === "interrupted") {
    return {
      kind: "interrupted",
      detail: result.ok ? "Run interrupted." : result.error.message,
    };
  }

  const resultEvent = {
    chunkKey: `${toolCallId}:result`,
    chunk: streamChunk({
      type: "TOOL_CALL_RESULT",
      messageId,
      toolCallId,
      content: JSON.stringify(result),
    }),
  };
  if (!result.ok) {
    await deps.store.appendRunEvents(run.id, [resultEvent]);
    return failed(`script.${result.error.kind}`, result.error.message);
  }

  const text = resultText(result);
  await deps.store.appendRunEvents(run.id, [
    resultEvent,
    {
      chunkKey: `${run.id}:msg-start`,
      chunk: streamChunk({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }),
    },
    {
      chunkKey: `${run.id}:delta:1`,
      chunk: streamChunk({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: text }),
    },
    { chunkKey: `${run.id}:msg-end`, chunk: streamChunk({ type: "TEXT_MESSAGE_END", messageId }) },
  ]);
  return { kind: "completed", finalMessageParts: [{ type: "text", text }] };
}
