import { describe, expect, it } from "bun:test";
import type { EngineEvent, EngineReadiness, Run } from "@der/domain";
import {
  createAntigravityEngine,
  createClaudeCodeEngine,
  createCodexEngine,
  type EngineRunInput,
} from "@der/runtime/engines";
import type {
  ProcessOptions,
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SpawnHandle,
} from "@tanstack/ai-sandbox";

interface RecordedSpawn {
  readonly command: string;
  readonly env: Record<string, string>;
}

function readinessFor(engine: EngineReadiness["engine"]): EngineReadiness {
  return {
    engine,
    interactive: "ready",
    unattended: "unverified",
    isolationVerified: true,
    reasons: [],
  };
}

function runFor(engine: Run["engine"]): Run {
  return {
    id: "run-1",
    botId: "bot-1",
    sessionId: "sess-1",
    origin: "http",
    engine,
    status: "running",
    routineId: null,
    checkpoint: null,
    usage: null,
    contextMode: null,
    createdAt: "2026-11-23T10:00:00Z",
    updatedAt: "2026-11-23T10:00:00Z",
    finishedAt: null,
  };
}

const input: EngineRunInput = { messages: [{ role: "user", content: "hello" }] };

function recordingSandbox(): {
  readonly provider: SandboxProvider;
  readonly spawns: RecordedSpawn[];
} {
  const spawns: RecordedSpawn[] = [];
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
  const written = new Map<string, string>();
  const handle = (id: string): SandboxHandle => ({
    id,
    provider: "docker",
    workspaceRoot: "/workspace",
    capabilities,
    fs: {
      async read(path) {
        return written.get(path) ?? "";
      },
      async readBytes(path) {
        return new TextEncoder().encode(written.get(path) ?? "");
      },
      async write(path, data) {
        written.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      async list() {
        return [];
      },
      async mkdir() {},
      async remove(path) {
        written.delete(path);
      },
      async rename() {},
      async exists(path) {
        return written.has(path);
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
      async exec() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async spawn(command: string, options?: ProcessOptions): Promise<SpawnHandle> {
        spawns.push({ command, env: { ...options?.env } });
        return {
          pid: 1001,
          stdout: (async function* () {})(),
          stderr: (async function* () {})(),
          stdin: { async write() {}, async end() {} },
          async wait() {
            return 0;
          },
          async kill() {},
        };
      },
    },
    ports: {
      async connect() {
        throw new Error("ports unsupported");
      },
    },
    env: { async set() {} },
    async destroy() {},
  });
  const provider: SandboxProvider = {
    name: "docker",
    capabilities: () => capabilities,
    async create(request) {
      return handle(request.id ?? "fake-container");
    },
    async resume() {
      return null;
    },
    async destroy() {},
  };
  return { provider, spawns };
}

async function drain(events: AsyncIterable<EngineEvent>): Promise<void> {
  for await (const _ of events) {
    // the spawn is recorded whatever the scripted CLI answers
  }
}

describe("pass the auto-compact window to the vendor CLI", () => {
  it("gives the Claude Code CLI CLAUDE_CODE_AUTO_COMPACT_WINDOW with the configured number", async () => {
    const sandbox = recordingSandbox();
    const engine = createClaudeCodeEngine({
      model: "claude-sonnet-4-5",
      sandboxProvider: sandbox.provider,
      callbackContinuity: "verified",
      autoCompactTokens: 120_000,
      diagnose: async () => readinessFor("claude-code"),
      loadRunInput: async () => input,
    });

    await drain(engine.run(runFor("claude-code")));

    expect(sandbox.spawns[0]!.env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]).toBe("120000");
  });

  it("gives the Codex CLI model_auto_compact_token_limit with the configured number", async () => {
    const sandbox = recordingSandbox();
    const engine = createCodexEngine({
      model: "gpt-5.3-codex",
      sandboxProvider: sandbox.provider,
      autoCompactTokens: 80_000,
      diagnose: async () => readinessFor("codex"),
      loadRunInput: async () => input,
    });

    await drain(engine.run(runFor("codex")));

    expect(sandbox.spawns[0]!.command).toContain("'model_auto_compact_token_limit=80000'");
  });

  it("leaves both settings out when no window is configured", async () => {
    const claude = recordingSandbox();
    const codex = recordingSandbox();

    await drain(
      createClaudeCodeEngine({
        model: "claude-sonnet-4-5",
        sandboxProvider: claude.provider,
        callbackContinuity: "verified",
        diagnose: async () => readinessFor("claude-code"),
        loadRunInput: async () => input,
      }).run(runFor("claude-code")),
    );
    await drain(
      createCodexEngine({
        model: "gpt-5.3-codex",
        sandboxProvider: codex.provider,
        diagnose: async () => readinessFor("codex"),
        loadRunInput: async () => input,
      }).run(runFor("codex")),
    );

    expect([
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW" in claude.spawns[0]!.env,
      codex.spawns[0]!.command.includes("model_auto_compact_token_limit"),
    ]).toEqual([false, false]);
  });

  it("gives the Antigravity CLI neither setting", async () => {
    const sandbox = recordingSandbox();
    const engine = createAntigravityEngine({
      model: "gemini-2.5-pro",
      sandboxProvider: sandbox.provider,
      callbackContinuity: "verified",
      diagnose: async () => readinessFor("antigravity"),
      loadRunInput: async () => input,
    });

    await drain(engine.run(runFor("antigravity")));

    const spawn = sandbox.spawns[0]!;
    expect([
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW" in spawn.env,
      spawn.command.includes("model_auto_compact_token_limit"),
    ]).toEqual([false, false]);
  });
});
