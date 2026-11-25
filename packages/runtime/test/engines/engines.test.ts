import { describe, expect, it } from "bun:test";
import type { EngineEvent, EngineReadiness, Run } from "@der/domain";
import type {
  ExecResult,
  ProcessOptions,
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SpawnHandle,
} from "@tanstack/ai-sandbox";
import {
  createAntigravityEngine,
  createClaudeCodeEngine,
  createCodexEngine,
  type ApprovalBroker,
} from "@der/runtime/engines";

function makeRun(overrides?: Partial<Run>): Run {
  return {
    id: "run-1",
    botId: "bot-1",
    sessionId: "sess-1",
    origin: "http",
    engine: "codex",
    status: "running",
    routineId: null,
    checkpoint: null,
    usage: null,
    contextMode: null,
    createdAt: "2026-11-22T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

function makeReadyReadiness(
  engine: "codex" | "claude-code" | "antigravity",
  overrides?: Partial<EngineReadiness>,
): EngineReadiness {
  return {
    engine,
    interactive: "ready",
    unattended: "unverified",
    isolationVerified: true,
    reasons: [],
    ...overrides,
  };
}

function createFakeSandboxProvider(handlers: {
  readonly onSpawn: (
    command: string,
    options?: ProcessOptions,
  ) => SpawnHandle | Promise<SpawnHandle>;
  readonly onExec?: (command: string, options?: ProcessOptions) => ExecResult | Promise<ExecResult>;
  readonly onDestroy?: () => void;
}): {
  readonly provider: SandboxProvider;
  readonly spawnedCommands: string[];
  readonly writtenFiles: Map<string, string>;
  readonly destroyCount: () => number;
} {
  const spawnedCommands: string[] = [];
  const writtenFiles = new Map<string, string>();
  let destroyed = 0;

  const capabilities: SandboxCapabilities = {
    fs: true,
    exec: true,
    env: true,
    ports: false,
    backgroundProcesses: true,
    writableStdin: true,
    killableProcesses: true,
    snapshots: false,
    networkPolicy: true,
    durableFilesystem: false,
    fork: false,
  };

  const makeHandle = (id: string): SandboxHandle => ({
    id,
    provider: "docker",
    workspaceRoot: "/workspace",
    capabilities,
    fs: {
      async read(path) {
        return writtenFiles.get(path) ?? "";
      },
      async readBytes(path) {
        return new TextEncoder().encode(writtenFiles.get(path) ?? "");
      },
      async write(path, data) {
        writtenFiles.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      async list() {
        return [];
      },
      async mkdir() {},
      async remove(path) {
        writtenFiles.delete(path);
      },
      async rename(from, to) {
        const value = writtenFiles.get(from);
        if (value !== undefined) {
          writtenFiles.delete(from);
          writtenFiles.set(to, value);
        }
      },
      async exists(path) {
        return writtenFiles.has(path);
      },
    },
    git: {
      async clone() {},
      async status() {
        return "";
      },
      async add() {},
      async commit() {},
      async push() {},
      async pull() {},
      async branch() {
        return "main";
      },
    },
    process: {
      async exec(command, options) {
        if (handlers.onExec) {
          return handlers.onExec(command, options);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async spawn(command, options) {
        spawnedCommands.push(command);
        return handlers.onSpawn(command, options);
      },
    },
    ports: {
      async connect() {
        throw new Error("ports unsupported");
      },
    },
    env: {
      async set() {},
    },
    async destroy() {
      destroyed += 1;
      handlers.onDestroy?.();
    },
  });

  const provider: SandboxProvider = {
    name: "docker",
    capabilities: () => capabilities,
    async create(input) {
      return makeHandle(input.id ?? "fake-container");
    },
    async resume() {
      return null;
    },
    async destroy() {
      destroyed += 1;
      handlers.onDestroy?.();
    },
  };

  return {
    provider,
    spawnedCommands,
    writtenFiles,
    destroyCount: () => destroyed,
  };
}

function createScriptedSpawnHandle(input: {
  readonly lines: readonly string[];
  readonly exitCode?: number;
  readonly stderrLines?: readonly string[];
}): SpawnHandle {
  return {
    pid: 1001,
    stdout: (async function* () {
      for (const line of input.lines) {
        yield `${line}\n`;
      }
    })(),
    stderr: (async function* () {
      for (const line of input.stderrLines ?? []) {
        yield `${line}\n`;
      }
    })(),
    stdin: {
      async write() {},
      async end() {},
    },
    async wait() {
      return input.exitCode ?? 0;
    },
    async kill() {},
  };
}

function createAcpJsonRpcSpawnHandle(behavior: {
  readonly loadSessionSupported?: boolean;
  readonly loadSessionFails?: boolean;
  readonly requestPermission?: boolean;
  readonly dropTransportMidTurn?: boolean;
  readonly stallUntilCancel?: boolean;
  readonly onPermissionOutcome?: (outcome: unknown) => void;
}): SpawnHandle {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let cancelled = false;
  let exitResolver: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    exitResolver = resolve;
  });

  const pushMessage = (msg: Record<string, unknown>) => {
    queue.push(`${JSON.stringify(msg)}\n`);
    notify?.();
    notify = undefined;
  };
  const closeStream = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    notify?.();
    notify = undefined;
    exitResolver?.(code);
  };

  let pendingPromptId: unknown;
  let permissionRequestId: number | undefined;
  let buffer = "";

  const handleRpc = (line: string) => {
    const msg = JSON.parse(line) as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
    };

    if (msg.method === "initialize") {
      pushMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: behavior.loadSessionSupported === true,
          },
        },
      });
      return;
    }

    if (msg.method === "session/load") {
      if (behavior.loadSessionFails) {
        pushMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "session cannot be resumed" },
        });
      } else {
        pushMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
      }
      return;
    }

    if (msg.method === "session/new") {
      pushMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "acp-session-new" },
      });
      return;
    }

    if (msg.method === "session/cancel") {
      cancelled = true;
      if (pendingPromptId !== undefined) {
        pushMessage({
          jsonrpc: "2.0",
          id: pendingPromptId,
          result: { stopReason: "cancelled" },
        });
        pendingPromptId = undefined;
      }
      return;
    }

    if (msg.method === "session/prompt") {
      pendingPromptId = msg.id;
      if (behavior.dropTransportMidTurn) {
        pushMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-new",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial..." },
            },
          },
        });
        setTimeout(() => closeStream(137), 5);
        return;
      }

      if (behavior.stallUntilCancel) {
        return;
      }

      if (behavior.requestPermission) {
        permissionRequestId = 9001;
        pushMessage({
          jsonrpc: "2.0",
          id: permissionRequestId,
          method: "session/request_permission",
          params: {
            sessionId: "acp-session-new",
            toolCall: {
              toolCallId: "tc-acp-1",
              title: "Write config",
              kind: "edit",
              rawInput: { path: "/workspace/out.txt" },
            },
            options: [
              { optionId: "allow-once-id", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once-id", name: "Reject once", kind: "reject_once" },
            ],
          },
        });
        return;
      }

      pushMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-session-new",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello from agy acp" },
          },
        },
      });
      pushMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn" },
      });
      pendingPromptId = undefined;
      return;
    }

    if (msg.id === permissionRequestId && msg.result) {
      behavior.onPermissionOutcome?.(msg.result["outcome"]);
      const outcome = msg.result["outcome"] as { outcome?: string; optionId?: string } | undefined;
      const replyText =
        outcome?.outcome === "selected" && outcome.optionId === "allow-once-id"
          ? "Permission approved and executed."
          : "Permission denied.";
      pushMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-session-new",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: replyText },
          },
        },
      });
      if (pendingPromptId !== undefined) {
        pushMessage({
          jsonrpc: "2.0",
          id: pendingPromptId,
          result: { stopReason: "end_turn" },
        });
        pendingPromptId = undefined;
      }
    }
  };

  return {
    pid: 2002,
    stdout: (async function* () {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
          }
        }
        if (closed) {
          break;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    })(),
    stderr: (async function* () {})(),
    stdin: {
      async write(data: string) {
        buffer += data;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) {
            handleRpc(line);
          }
          idx = buffer.indexOf("\n");
        }
      },
      async end() {
        closeStream(cancelled ? 130 : 0);
      },
    },
    async wait() {
      return exited;
    },
    async kill() {
      closeStream(137);
    },
  };
}

async function collectEvents(iterable: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("adapt Codex, Claude Code, and Antigravity ACP engines in contained sandboxes", () => {
  it("runs Codex through @tanstack/ai-codex preserving native execution inside the hardened sandbox", async () => {
    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: () =>
        createScriptedSpawnHandle({
          lines: [
            JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "item-1", type: "agent_message", text: "Native codex answer." },
            }),
            JSON.stringify({
              type: "turn.completed",
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
          ],
        }),
    });

    const engine = createCodexEngine({
      model: "gpt-5.3-codex",
      sandboxProvider: fakeSandbox.provider,
      diagnose: async () => makeReadyReadiness("codex"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Summarize workspace" }],
      }),
    });

    const events = await collectEvents(engine.run(makeRun({ engine: "codex" })));
    expect(fakeSandbox.spawnedCommands[0]).toContain("codex exec --experimental-json");
    expect(fakeSandbox.spawnedCommands[0]).toContain("--sandbox 'workspace-write'");
    expect(fakeSandbox.spawnedCommands[0]).toContain(`'approval_policy="never"'`);
    expect(events.some((event) => event.type === "chunk")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "completed",
      vendorSessionId: "codex-thread-1",
      finalMessage: {
        parts: [{ type: "text", text: "Native codex answer." }],
      },
      usage: {
        inputTokens: 10,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: 5,
        reportedCostUsd: null,
      },
    });
  });

  it("runs Claude Code through @tanstack/ai-claude-code and bridges permission prompts via ToolBridgeProvisionerCapability", async () => {
    let seenPermissionPromptFlag = false;
    const brokerCalls: string[] = [];
    const approvalBroker: ApprovalBroker = {
      async requestApproval(input) {
        brokerCalls.push(input.effect.operationId);
        return {
          status: "approved",
          approvalId: "apr-claude-1",
          effect: input.effect,
        };
      },
    };

    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: (_command) => {
        const argvFile = [...fakeSandbox.writtenFiles.entries()].find(([path]) =>
          path.includes("tanstack-claude-argv-"),
        );
        if (argvFile?.[1].includes("--permission-prompt-tool")) {
          seenPermissionPromptFlag = true;
        }
        return createScriptedSpawnHandle({
          lines: [
            JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-1" }),
            JSON.stringify({
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                id: "msg-1",
                content: [{ type: "text", text: "Claude reply via sandbox." }],
              },
            }),
            JSON.stringify({
              type: "result",
              subtype: "success",
              session_id: "claude-sess-1",
              result: "Claude reply via sandbox.",
            }),
          ],
        });
      },
    });

    const engine = createClaudeCodeEngine({
      model: "claude-sonnet-4-5",
      sandboxProvider: fakeSandbox.provider,
      callbackContinuity: "verified",
      toolBridgeProvisioner: {
        async provision(_tools, options) {
          if (options.permission) {
            const decision = await options.permission.resolve({
              tool_name: "Bash",
              input: { command: "echo ok" },
            });
            expect(decision.behavior).toBe("allow");
          }
          return {
            name: "tanstack",
            url: "http://127.0.0.1:4444/mcp",
            token: "secret-token",
            async close() {},
          };
        },
      },
      diagnose: async () => makeReadyReadiness("claude-code"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Check files" }],
        approvalBroker,
      }),
    });

    const events = await collectEvents(engine.run(makeRun({ engine: "claude-code" })));
    expect(seenPermissionPromptFlag).toBe(true);
    expect(brokerCalls).toEqual(["claude-code:Bash"]);
    expect(events.at(-1)).toEqual({
      type: "completed",
      vendorSessionId: "claude-sess-1",
      finalMessage: {
        parts: [{ type: "text", text: "Claude reply via sandbox." }],
      },
    });
  });

  it("runs Antigravity via @tanstack/ai-acp with agy acp and bridges live ACP permission requests to durable approvals", async () => {
    let observedAcpOutcome: unknown;
    const brokerEffects: string[] = [];
    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: () =>
        createAcpJsonRpcSpawnHandle({
          requestPermission: true,
          onPermissionOutcome: (outcome) => {
            observedAcpOutcome = outcome;
          },
        }),
    });

    const engine = createAntigravityEngine({
      model: "gemini-2.5-pro",
      sandboxProvider: fakeSandbox.provider,
      callbackContinuity: "verified",
      diagnose: async () => makeReadyReadiness("antigravity"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Update config" }],
        approvalBroker: {
          async requestApproval(input) {
            brokerEffects.push(input.effect.operationId);
            return {
              status: "approved",
              approvalId: "apr-acp-1",
              effect: input.effect,
            };
          },
        },
      }),
    });

    const events = await collectEvents(engine.run(makeRun({ engine: "antigravity" })));
    expect(fakeSandbox.spawnedCommands[0]).toContain("agy acp --stdio --disable-telemetry");
    expect(fakeSandbox.spawnedCommands[0]).not.toContain("--dangerously-skip-permissions");
    expect(brokerEffects).toEqual(["antigravity:edit:Write config"]);
    expect(observedAcpOutcome).toEqual({ outcome: "selected", optionId: "allow-once-id" });
    expect(events.at(-1)).toEqual({
      type: "completed",
      vendorSessionId: "acp-session-new",
      finalMessage: {
        parts: [{ type: "text", text: "Permission approved and executed." }],
      },
    });
  });
});

describe("enforce eligibility gates, cancellation, transport loss, and non-resumable engine processes", () => {
  it("blocks an event run when unattended eligibility is unverified", async () => {
    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: () => createScriptedSpawnHandle({ lines: [] }),
    });
    const engine = createCodexEngine({
      model: "gpt-5.3-codex",
      sandboxProvider: fakeSandbox.provider,
      diagnose: async () => makeReadyReadiness("codex", { unattended: "unverified" }),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "A script finished" }],
      }),
    });

    const events = await collectEvents(engine.run(makeRun({ engine: "codex", origin: "event" })));

    expect(events).toEqual([
      {
        type: "failed",
        code: "engine.unattended_blocked",
        detail: expect.stringContaining("unverified"),
      },
    ]);
    expect(fakeSandbox.spawnedCommands).toHaveLength(0);
  });

  it("blocks routine runs when unattended eligibility is unverified and blocks all runs when isolation is unverified", async () => {
    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: () => createScriptedSpawnHandle({ lines: [] }),
    });

    const unattendedUnverifiedEngine = createCodexEngine({
      model: "gpt-5.3-codex",
      sandboxProvider: fakeSandbox.provider,
      diagnose: async () => makeReadyReadiness("codex", { unattended: "unverified" }),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Scheduled job" }],
      }),
    });

    const routineEvents = await collectEvents(
      unattendedUnverifiedEngine.run(
        makeRun({ engine: "codex", origin: "routine", routineId: "routine-1" }),
      ),
    );
    expect(routineEvents).toEqual([
      {
        type: "failed",
        code: "engine.unattended_blocked",
        detail: expect.stringContaining("unverified"),
      },
    ]);
    expect(fakeSandbox.spawnedCommands).toHaveLength(0);

    const unisolatedEngine = createCodexEngine({
      model: "gpt-5.3-codex",
      sandboxProvider: fakeSandbox.provider,
      diagnose: async () =>
        makeReadyReadiness("codex", {
          interactive: "blocked",
          unattended: "blocked",
          isolationVerified: false,
          reasons: ["Docker daemon is not running in rootless mode."],
        }),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Interactive job" }],
      }),
    });

    const blockedEvents = await collectEvents(unisolatedEngine.run(makeRun({ engine: "codex" })));
    expect(blockedEvents).toEqual([
      {
        type: "failed",
        code: "engine.isolation_unverified",
        detail: expect.stringContaining("rootless"),
      },
    ]);
    expect(fakeSandbox.spawnedCommands).toHaveLength(0);
  });

  it("cancels an in-flight ACP engine cleanly when the run AbortSignal fires", async () => {
    const controller = new AbortController();
    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: () => {
        setTimeout(() => controller.abort("operator cancelled"), 15);
        return createAcpJsonRpcSpawnHandle({ stallUntilCancel: true });
      },
    });

    const engine = createAntigravityEngine({
      model: "gemini-2.5-pro",
      sandboxProvider: fakeSandbox.provider,
      callbackContinuity: "verified",
      diagnose: async () => makeReadyReadiness("antigravity"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Long running task" }],
        signal: controller.signal,
      }),
    });

    const events = await collectEvents(engine.run(makeRun({ engine: "antigravity" })));
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      code: "engine.cancelled",
    });
    expect(fakeSandbox.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("reports engine.transport_lost when the engine process dies mid-stream without a terminal event", async () => {
    const fakeSandbox = createFakeSandboxProvider({
      onSpawn: () => createAcpJsonRpcSpawnHandle({ dropTransportMidTurn: true }),
    });

    const engine = createAntigravityEngine({
      model: "gemini-2.5-pro",
      sandboxProvider: fakeSandbox.provider,
      callbackContinuity: "verified",
      diagnose: async () => makeReadyReadiness("antigravity"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Stream until crash" }],
      }),
    });

    const events = await collectEvents(engine.run(makeRun({ engine: "antigravity" })));
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      code: "engine.transport_lost",
    });
    expect(fakeSandbox.destroyCount()).toBeGreaterThanOrEqual(1);
  });

  it("reports engine.resume_unavailable when an engine process cannot resume the session", async () => {
    const codexSandbox = createFakeSandboxProvider({
      onSpawn: () =>
        createScriptedSpawnHandle({
          lines: [],
          stderrLines: ["error: thread codex-dead-session not found"],
          exitCode: 1,
        }),
    });
    const codexEngine = createCodexEngine({
      model: "gpt-5.3-codex",
      sandboxProvider: codexSandbox.provider,
      diagnose: async () => makeReadyReadiness("codex"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Continue prior run" }],
        resumeSessionId: "codex-dead-session",
      }),
    });

    const codexEvents = await collectEvents(codexEngine.run(makeRun({ engine: "codex" })));
    expect(codexEvents.at(-1)).toMatchObject({
      type: "failed",
      code: "engine.resume_unavailable",
    });

    const acpSandbox = createFakeSandboxProvider({
      onSpawn: () =>
        createAcpJsonRpcSpawnHandle({
          loadSessionSupported: true,
          loadSessionFails: true,
        }),
    });
    const acpEngine = createAntigravityEngine({
      model: "gemini-2.5-pro",
      sandboxProvider: acpSandbox.provider,
      callbackContinuity: "verified",
      diagnose: async () => makeReadyReadiness("antigravity"),
      loadRunInput: async () => ({
        messages: [{ role: "user", content: "Continue prior ACP turn" }],
        resumeSessionId: "acp-dead-session",
      }),
    });

    const acpEvents = await collectEvents(acpEngine.run(makeRun({ engine: "antigravity" })));
    expect(acpEvents.at(-1)).toMatchObject({
      type: "failed",
      code: "engine.resume_unavailable",
    });
  });
});
