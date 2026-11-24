import { describe, expect, it } from "bun:test";
import type { EngineEvent, EngineReadiness, Run } from "@der/domain";
import {
  claudeCodeResume,
  createClaudeCodeEngine,
  type EngineRunInput,
} from "@der/runtime/engines";
import type {
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SpawnHandle,
} from "@tanstack/ai-sandbox";

const UNKNOWN_SESSION_STDERR =
  "No conversation found with session ID: 00000000-0000-4000-8000-000000000000";

const readiness: EngineReadiness = {
  engine: "claude-code",
  interactive: "ready",
  unattended: "unverified",
  isolationVerified: true,
  reasons: [],
};

const run: Run = {
  id: "run-2",
  botId: "bot-1",
  sessionId: "sess-1",
  origin: "http",
  engine: "claude-code",
  status: "running",
  routineId: null,
  checkpoint: null,
  usage: null,
  contextMode: null,
  createdAt: "2026-11-23T10:00:00Z",
  updatedAt: "2026-11-23T10:00:00Z",
  finishedAt: null,
};

interface FakeCli {
  readonly provider: SandboxProvider;
  readonly argvFiles: string[];
  readonly stdin: string[];
}

function fakeClaudeCli(script: {
  readonly lines: readonly string[];
  readonly stderrLines?: readonly string[];
  readonly exitCode?: number;
}): FakeCli {
  const argvFiles: string[] = [];
  const stdin: string[] = [];
  const written = new Map<string, string>();
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
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        written.set(path, text);
        if (path.includes("tanstack-claude-argv-")) {
          argvFiles.push(text);
        }
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
      async spawn(): Promise<SpawnHandle> {
        return {
          pid: 1001,
          stdout: (async function* () {
            for (const line of script.lines) {
              yield `${line}\n`;
            }
          })(),
          stderr: (async function* () {
            for (const line of script.stderrLines ?? []) {
              yield `${line}\n`;
            }
          })(),
          stdin: {
            async write(data: string) {
              stdin.push(data);
            },
            async end() {},
          },
          async wait() {
            return script.exitCode ?? 0;
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
    async create(input) {
      return handle(input.id ?? "fake-container");
    },
    async resume() {
      return null;
    },
    async destroy() {},
  };
  return { provider, argvFiles, stdin };
}

function acceptedTurn(sessionId: string): string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "msg-1", content: [{ type: "text", text: "Second answer." }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "Second answer.",
    }),
  ];
}

async function runEngine(cli: FakeCli, input: EngineRunInput): Promise<EngineEvent[]> {
  const engine = createClaudeCodeEngine({
    model: "claude-sonnet-4-5",
    sandboxProvider: cli.provider,
    callbackContinuity: "verified",
    diagnose: async () => readiness,
    loadRunInput: async () => input,
  });
  const events: EngineEvent[] = [];
  for await (const event of engine.run(run)) {
    events.push(event);
  }
  return events;
}

describe("resume a Claude Code session", () => {
  it("passes the vendor session id and only the trailing user message to the CLI", async () => {
    const cli = fakeClaudeCli({ lines: acceptedTurn("vendor-1") });

    const events = await runEngine(cli, {
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
      resumeSessionId: "vendor-1",
      requireResume: true,
    });

    const argv = JSON.parse(cli.argvFiles[0]!) as string[];
    expect([argv[argv.indexOf("--resume") + 1], cli.stdin.join(""), events.at(-1)]).toEqual([
      "vendor-1",
      "second question",
      { type: "completed", finalMessage: { parts: [{ type: "text", text: "Second answer." }] } },
    ]);
  });

  it("starts a fresh CLI session without --resume when no session id is given", async () => {
    const cli = fakeClaudeCli({ lines: acceptedTurn("vendor-new") });

    await runEngine(cli, { messages: [{ role: "user", content: "hello" }] });

    expect((JSON.parse(cli.argvFiles[0]!) as string[]).includes("--resume")).toBe(false);
  });
});

describe("detect a Claude Code session the CLI rejects", () => {
  it.each([
    {
      case: "the recorded unknown-session error",
      message: `Agent process exited with code 1: ${UNKNOWN_SESSION_STDERR}`,
      expected: true,
    },
    {
      case: "an unrelated error that mentions a thread",
      message: "Agent process exited with code 1: thread pool exhausted",
      expected: false,
    },
    {
      case: "an unrelated error that mentions a session",
      message: "Agent process exited with code 1: session token expired, run /login",
      expected: false,
    },
  ])("treats $case as resume failure: $expected", ({ message, expected }) => {
    expect(claudeCodeResume.isResumeFailure(message)).toBe(expected);
  });

  it("reports engine.resume_unavailable when the CLI exits with the unknown-session error", async () => {
    const cli = fakeClaudeCli({ lines: [], stderrLines: [UNKNOWN_SESSION_STDERR], exitCode: 1 });

    const events = await runEngine(cli, {
      messages: [{ role: "user", content: "second question" }],
      resumeSessionId: "00000000-0000-4000-8000-000000000000",
      requireResume: true,
    });

    expect(events.at(-1)).toEqual({
      type: "failed",
      code: "engine.resume_unavailable",
      detail: `Unable to resume session "00000000-0000-4000-8000-000000000000": Agent process exited with code 1: ${UNKNOWN_SESSION_STDERR}`,
    });
  });

  it("reports engine.resume_unavailable when the CLI answers with a different session id", async () => {
    const cli = fakeClaudeCli({ lines: acceptedTurn("vendor-replacement") });

    const events = await runEngine(cli, {
      messages: [{ role: "user", content: "second question" }],
      resumeSessionId: "vendor-1",
      requireResume: true,
    });

    expect(events.at(-1)).toEqual({
      type: "failed",
      code: "engine.resume_unavailable",
      detail:
        'Engine could not resume session "vendor-1"; started fresh session "vendor-replacement" instead.',
    });
  });

  it("reports a dropped stream after the CLI accepted the session as transport loss, not a rejected resume", async () => {
    const cli = fakeClaudeCli({
      lines: [JSON.stringify({ type: "system", subtype: "init", session_id: "vendor-1" })],
    });

    const events = await runEngine(cli, {
      messages: [{ role: "user", content: "second question" }],
      resumeSessionId: "vendor-1",
      requireResume: true,
    });

    expect(events.at(-1)).toEqual({
      type: "failed",
      code: "engine.transport_lost",
      detail: "Engine process transport closed before completing the run.",
    });
  });
});
