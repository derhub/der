import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@der/domain";

export interface ScriptLimits {
  readonly memoryBytes: number;
  readonly activeMs: number;
  readonly maxCalls: number;
  readonly outputBytes: number;
}

export type ScriptErrorKind =
  | "script"
  | "denied"
  | "expired"
  | "limit"
  | "capability"
  | "cancelled"
  | "nondeterministic";

export type ScriptHostErrorKind = "denied" | "expired" | "cancelled" | "capability";

export type ScriptCallReply =
  | { readonly ok: true; readonly value: JsonValue; readonly now?: number }
  | {
      readonly ok: false;
      readonly error: { readonly kind: ScriptHostErrorKind; readonly message: string };
      readonly now?: number;
    };

export type ScriptResult =
  | {
      readonly ok: true;
      readonly result: JsonValue;
      readonly logs: string[];
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: ScriptErrorKind;
        readonly message: string;
        readonly call?: string;
        readonly line?: number;
      };
      readonly logs: string[];
    };

export interface RunScriptOptions {
  readonly script: string;
  readonly call: (id: string, input: JsonValue) => Promise<ScriptCallReply>;
  readonly limits: ScriptLimits;
  readonly seed: number;
  readonly now: number;
  readonly signal?: AbortSignal;
  readonly guestArtifactPath?: string;
}

export class ScriptRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ScriptRunnerError";
    this.code = code;
  }
}

const CHILD_PATH = join(import.meta.dir, "script-child.ts");
const POLL_MS = 20;
const STARTUP_MS = 60_000;
const STDERR_TAIL_BYTES = 2048;

const transpiler = new Bun.Transpiler({ loader: "js" });
const IMPORT_FORM = /(?<![\w$])import\s*[(.]/;
const WRAPPER_LINES = 1;

const importRejected = (): ScriptResult => ({
  ok: false,
  error: { kind: "script", message: "import is not available in a Script" },
  logs: [],
});

function hasModuleSyntax(script: string): boolean {
  try {
    const scan = transpiler.scan(script);
    return scan.imports.length > 0 || scan.exports.length > 0;
  } catch {
    return false;
  }
}

function rejectImports(script: string): ScriptResult | undefined {
  if (hasModuleSyntax(script)) {
    return importRejected();
  }
  let printed: string;
  try {
    printed = transpiler.transformSync(
      `globalThis.__script = async function (der) {\n${script}\n};`,
    );
  } catch (error) {
    const detail = (
      Array.isArray((error as AggregateError).errors) ? (error as AggregateError).errors[0] : error
    ) as { message?: string; position?: { line: number } } | undefined;
    const line = detail?.position === undefined ? 0 : detail.position.line - WRAPPER_LINES;
    return {
      ok: false,
      error: {
        kind: "script",
        message: `SyntaxError: ${detail?.message ?? String(error)}`,
        ...(line > 0 ? { line } : {}),
      },
      logs: [],
    };
  }
  return IMPORT_FORM.test(printed) ? importRejected() : undefined;
}

function readRssBytes(pid: number): number | undefined {
  try {
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /VmRSS:\s+(\d+) kB/.exec(status);
      return match ? Number(match[1]) * 1024 : undefined;
    }
    const ps = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
    const kilobytes = Number(ps.stdout.toString().trim());
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : undefined;
  } catch {
    return undefined;
  }
}

function isHostErrorKind(value: unknown): value is ScriptHostErrorKind {
  return (
    value === "denied" || value === "expired" || value === "cancelled" || value === "capability"
  );
}

export async function runScript(options: RunScriptOptions): Promise<ScriptResult> {
  const { limits, signal } = options;
  const logs: string[] = [];
  if (signal?.aborted) {
    return { ok: false, error: { kind: "cancelled", message: "script cancelled" }, logs };
  }

  const rejected = rejectImports(options.script);
  if (rejected !== undefined) {
    return rejected;
  }

  const child = Bun.spawn([process.execPath, CHILD_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {},
  });

  const outcome: { verdict?: ScriptResult; fatal?: ScriptRunnerError } = {};
  let resolveVerdict: () => void = () => {};
  const verdictSettled = new Promise<void>((resolve) => {
    resolveVerdict = resolve;
  });
  let ready = false;
  let activeSince: number | undefined;
  let activeUsed = 0;
  let outputBytes = 0;
  let calls = 0;
  let stderrTail = "";
  const startedAt = performance.now();

  const finish = (result: ScriptResult): void => {
    if (outcome.verdict !== undefined) {
      return;
    }
    outcome.verdict = result;
    child.kill("SIGKILL");
    resolveVerdict();
  };
  const fail = (kind: ScriptErrorKind, message: string): void => {
    finish({ ok: false, error: { kind, message }, logs });
  };
  const send = async (message: unknown): Promise<void> => {
    await child.stdin.write(`${JSON.stringify(message)}\n`);
    await child.stdin.flush();
  };
  const pauseActiveClock = (): void => {
    if (activeSince !== undefined) {
      activeUsed += performance.now() - activeSince;
      activeSince = undefined;
    }
  };

  const onAbort = (): void => fail("cancelled", "script cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });

  const watchdog = setInterval(() => {
    if (outcome.verdict !== undefined) {
      return;
    }
    const rss = readRssBytes(child.pid);
    if (rss !== undefined && rss > limits.memoryBytes) {
      fail("limit", `memory limit of ${limits.memoryBytes} bytes exceeded`);
      return;
    }
    if (!ready) {
      if (performance.now() - startedAt > STARTUP_MS) {
        outcome.fatal = new ScriptRunnerError(
          "script.guest_start_timeout",
          "script guest did not start",
        );
        fail("script", "script guest did not start");
      }
      return;
    }
    const used =
      activeSince === undefined ? activeUsed : activeUsed + (performance.now() - activeSince);
    if (used > limits.activeMs) {
      fail("limit", `active time limit of ${limits.activeMs} ms exceeded`);
    }
  }, POLL_MS);

  const handleCall = async (message: Record<string, unknown>): Promise<void> => {
    pauseActiveClock();
    calls += 1;
    if (calls > limits.maxCalls) {
      fail("limit", `call limit of ${limits.maxCalls} exceeded`);
      return;
    }
    const id = message["id"];
    const ordinal = message["call"];
    if (typeof id !== "string" || typeof ordinal !== "number") {
      fail("script", "guest sent a malformed call");
      return;
    }
    let reply: ScriptCallReply;
    try {
      reply = await options.call(id, message["input"] as JsonValue);
    } catch (error) {
      reply = {
        ok: false,
        error: {
          kind: "capability",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (outcome.verdict !== undefined) {
      return;
    }
    const wire = reply.ok
      ? { call: ordinal, ok: true, value: reply.value, now: reply.now }
      : {
          call: ordinal,
          ok: false,
          error: isHostErrorKind(reply.error.kind)
            ? reply.error
            : { kind: "capability", message: reply.error.message },
          now: reply.now,
        };
    await send(wire);
    activeSince = performance.now();
  };

  const handleLine = async (line: string): Promise<void> => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      fail("script", "guest wrote a malformed line");
      return;
    }
    if (message["ready"] === true) {
      ready = true;
      activeSince = performance.now();
    } else if (message["fatal"] !== undefined) {
      const detail = message["fatal"] as { code: string; message: string };
      outcome.fatal = new ScriptRunnerError(detail.code, detail.message);
      fail("script", detail.message);
    } else if (typeof message["log"] === "string") {
      logs.push(message["log"]);
    } else if (message["call"] !== undefined) {
      await handleCall(message);
    } else if (message["done"] === true) {
      const error = message["error"] as Extract<ScriptResult, { ok: false }>["error"] | undefined;
      finish(
        error === undefined
          ? { ok: true, result: (message["result"] ?? null) as JsonValue, logs, truncated: false }
          : {
              ok: false,
              error: { ...error, kind: isHostErrorKind(error.kind) ? error.kind : "script" },
              logs,
            },
      );
    }
  };

  const pump = async (): Promise<void> => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      outputBytes += chunk.byteLength;
      if (outputBytes > limits.outputBytes) {
        fail("limit", `output limit of ${limits.outputBytes} bytes exceeded`);
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && outcome.verdict === undefined) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await handleLine(line);
        newline = buffer.indexOf("\n");
      }
      if (outcome.verdict !== undefined) {
        return;
      }
    }
  };

  const collectStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  };

  await send({
    init: {
      script: options.script,
      seed: options.seed,
      now: options.now,
      ...(options.guestArtifactPath === undefined
        ? {}
        : { guestArtifactPath: options.guestArtifactPath }),
    },
  });

  const stderrDone = collectStderr();
  const pumped = pump().catch((error: unknown) =>
    fail("script", error instanceof Error ? error.message : String(error)),
  );
  try {
    await Promise.race([pumped, verdictSettled]);
    if (outcome.verdict === undefined) {
      const exitCode = await child.exited;
      await stderrDone;
      fail("script", `script ended without a result (exit ${exitCode}): ${stderrTail.trim()}`);
    }
  } finally {
    clearInterval(watchdog);
    signal?.removeEventListener("abort", onAbort);
    child.kill("SIGKILL");
    await child.exited;
  }
  if (outcome.fatal !== undefined) {
    throw outcome.fatal;
  }
  return outcome.verdict as ScriptResult;
}
