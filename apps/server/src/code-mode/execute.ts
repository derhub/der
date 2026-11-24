import * as z from "zod";
import type { ExecuteResult, JsonValue, Run, ScriptStore } from "@der/domain";
import type { AnyTool } from "@tanstack/ai";
import type { ScriptDriver } from "../scripts/script-driver";

const executeInput = z.strictObject({ script: z.string().min(1) });

export interface ExecuteToolDeps {
  readonly run: Run;
  readonly scriptRunStore: Pick<ScriptStore, "acquire">;
  readonly scriptDriver: ScriptDriver;
  readonly maxResultBytes: number;
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

async function executeAndWait(deps: ExecuteToolDeps, script: string, signal: AbortSignal) {
  const execution = deps.scriptRunStore.acquire({
    runId: deps.run.id,
    botId: deps.run.botId,
    source: script,
    seed: crypto.getRandomValues(new Uint32Array(1))[0]!,
  });
  return deps.scriptDriver.wait(execution.id, signal);
}

export function createExecuteTool(deps: ExecuteToolDeps): AnyTool {
  return {
    name: "execute",
    description:
      "Run a JavaScript Script that calls capabilities as await step.run(id, input). Blocks until the Script ends, including while an operator decides an approval. Never throws: check `ok` in the result. If this call is cut off, call it again with the identical script to reattach if its execution is still unfinished.",
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
    ): Promise<ExecuteResult> => {
      const parsed = executeInput.safeParse(rawArgs);
      if (!parsed.success) {
        return failure("script", `execute takes { script: string }: ${parsed.error.message}`);
      }
      const signal = context?.signal ?? new AbortController().signal;
      try {
        return fitResult(
          await executeAndWait(deps, parsed.data.script, signal),
          deps.maxResultBytes,
        );
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
