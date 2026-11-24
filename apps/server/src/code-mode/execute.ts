import * as z from "zod";
import type { ExecuteResult, JsonValue, Run, ScriptStore } from "@der/domain";
import type { AnyTool } from "@tanstack/ai";
import type { ScriptDriver } from "../scripts/script-driver";

const executeInput = z.strictObject({ script: z.string().min(1) });

export interface ExecuteToolDeps {
  readonly run: Run;
  readonly scriptRunStore: Pick<ScriptStore, "acquire" | "detach" | "load">;
  readonly scriptDriver: ScriptDriver;
  readonly maxResultBytes: number;
  readonly inlineWaitMs: number;
}

export interface ExecutePending {
  readonly status: "pending";
  readonly executionId: string;
  readonly proposedWrites: readonly { position: number; capability: string; input: JsonValue }[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOGS_TRUNCATED = "[logs truncated]";

function failure(
  kind: Extract<ExecuteResult, { ok: false }>["error"]["kind"],
  message: string,
): ExecuteResult {
  return { ok: false, error: { kind, message }, logs: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cutUtf8(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
}

function fitLogs(logs: readonly string[], maxBytes: number): { logs: string[]; cut: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of logs) {
    used += encoder.encode(line).byteLength;
    if (used > maxBytes) {
      return { logs: kept, cut: true };
    }
    kept.push(line);
  }
  return { logs: kept, cut: false };
}

export function fitResult(result: ExecuteResult, maxBytes: number): ExecuteResult {
  const { logs, cut } = fitLogs(result.logs, maxBytes);
  if (!result.ok) {
    return { ...result, logs: cut ? [...logs, LOGS_TRUNCATED] : logs };
  }
  const serialized = JSON.stringify(result.result) ?? "null";
  const tooLarge = encoder.encode(serialized).byteLength > maxBytes;
  const value: JsonValue = tooLarge ? cutUtf8(serialized, maxBytes) : result.result;
  return {
    ok: true,
    result: value,
    logs,
    truncated: result.truncated || tooLarge || cut,
  };
}

/**
 * Waits `inlineWaitMs` for the Script's end, then detaches it. `detach` succeeds only
 * while the execution is unfinished, so either the inline result or the `script.finished`
 * event reaches the agent, never both and never neither.
 */
async function executeAndWait(
  deps: ExecuteToolDeps,
  script: string,
  signal: AbortSignal,
): Promise<ExecuteResult | ExecutePending> {
  const { scriptRunStore: store, scriptDriver: driver } = deps;
  const execution = store.acquire({
    runId: deps.run.id,
    botId: deps.run.botId,
    source: script,
    seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
  });
  await driver.wait(execution.id, signal, deps.inlineWaitMs);
  store.detach(execution.id);
  const settled = store.load(execution.id).execution;
  if (settled.detachedAt === null && settled.result !== null) {
    return settled.result;
  }
  return {
    status: "pending",
    executionId: execution.id,
    proposedWrites: await driver.proposedWrites(execution.id),
  };
}

export function createExecuteTool(deps: ExecuteToolDeps): AnyTool {
  return {
    name: "execute",
    description:
      'Run a JavaScript Script that calls capabilities as await step.run(id, input). Waits a few seconds for the Script to end and returns its result. A Script still running then, for example while an operator decides an approval, returns { status: "pending", executionId, proposedWrites } and its outcome arrives later as an event message. Never throws: check `ok` in a result. If this call is cut off, call it again with the identical script to reattach if its execution is still unfinished.',
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "Body of an async function. Use `return` to give back a JSON value. Await every capability call.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    } as AnyTool["inputSchema"],
    execute: async (
      rawArgs: unknown,
      context?: { readonly signal?: AbortSignal },
    ): Promise<ExecuteResult | ExecutePending> => {
      const parsed = executeInput.safeParse(rawArgs);
      if (!parsed.success) {
        return failure("script", `execute takes { script: string }: ${parsed.error.message}`);
      }
      const signal = context?.signal ?? new AbortController().signal;
      try {
        const outcome = await executeAndWait(deps, parsed.data.script, signal);
        return "status" in outcome ? outcome : fitResult(outcome, deps.maxResultBytes);
      } catch (error) {
        if (signal.aborted) {
          return failure(
            "cancelled",
            "execute was aborted before the script finished; call execute with the same script to reattach if its execution is still unfinished",
          );
        }
        return failure("capability", `execute failed: ${errorMessage(error)}`);
      }
    },
  };
}
