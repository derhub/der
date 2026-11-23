import type { ExecuteResult, Run, RoutineStore } from "@der/domain";
import { isTerminalScriptRunStatus, type SqliteScriptRuns } from "@der/storage";
import type { ScriptRuns } from "../scripts/script-workflow";
import type { RunStageResult, WorkflowDeps } from "./run-steps";

export interface ScriptRoutineDeps {
  readonly routines: Pick<RoutineStore, "getRoutine">;
  readonly scriptRunStore: Pick<SqliteScriptRuns, "acquire">;
  readonly scriptRuns: ScriptRuns;
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
  const routine =
    run.routineId === null ? undefined : await scripts.routines.getRoutine(run.routineId);
  if (routine?.engine !== "script") {
    return failed("script.routine_missing", `Run ${run.id} does not belong to a script routine.`);
  }

  const toolCallId = `${run.id}:execute`;
  const messageId = `msg_stream_${run.id}`;
  await deps.store.appendRunEvents(run.id, [
    {
      chunkKey: `${run.id}:started`,
      chunk: { type: "RUN_STARTED", threadId: run.sessionId, runId: run.id },
    },
    {
      chunkKey: `${toolCallId}:start`,
      chunk: { type: "TOOL_CALL_START", toolCallId, toolCallName: "execute" },
    },
    {
      chunkKey: `${toolCallId}:args`,
      chunk: {
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify({ script: routine.script }),
      },
    },
    { chunkKey: `${toolCallId}:end`, chunk: { type: "TOOL_CALL_END", toolCallId } },
  ]);

  const { scriptRun } = await scripts.scriptRunStore.acquire({
    runId: run.id,
    botId: run.botId,
    source: routine.script,
  });
  let result = isTerminalScriptRunStatus(scriptRun.status) ? scriptRun.result : null;
  if (result === null) {
    await scripts.scriptRuns.submit(scriptRun.id);
    result = await scripts.scriptRuns.attach(scriptRun.id, new AbortController().signal);
  }

  if ((await deps.store.getRun(run.id))?.status === "interrupted") {
    return {
      kind: "interrupted",
      detail: result.ok ? "Run interrupted." : result.error.message,
    };
  }

  const resultEvent = {
    chunkKey: `${toolCallId}:result`,
    chunk: {
      type: "TOOL_CALL_RESULT",
      messageId,
      toolCallId,
      content: JSON.stringify(result),
    },
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
      chunk: { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    },
    {
      chunkKey: `${run.id}:delta:1`,
      chunk: { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
    },
    { chunkKey: `${run.id}:msg-end`, chunk: { type: "TEXT_MESSAGE_END", messageId } },
  ]);
  return { kind: "completed", finalMessageParts: [{ type: "text", text }] };
}
