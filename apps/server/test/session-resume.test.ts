import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorDriver } from "#workflows/coordinator";
import type { Run, RunEvent } from "@der/domain";
import type { CommandRunner, CommandSpawnHandle } from "@der/runtime/sandbox";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const UNKNOWN_SESSION = "No conversation found with session ID";

interface CliCall {
  readonly argv: string[];
  readonly prompt: string;
}

interface CliReply {
  readonly lines: string[];
  readonly stderr?: string;
  readonly exitCode?: number;
}

function initLine(sessionId: string): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
}

function answerLines(sessionId: string, text: string): string[] {
  return [
    initLine(sessionId),
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: `msg-${text}`, content: [{ type: "text", text }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: text }),
  ];
}

/** A Claude Code CLI that remembers the sessions it created and rejects `--resume` of any other id. */
function createFakeClaude(options: { readonly onRejectedResume?: (id: string) => CliReply } = {}) {
  const calls: CliCall[] = [];
  const known = new Set<string>();
  const written = new Map<string, string>();
  let created = 0;

  const reply = (call: CliCall): CliReply => {
    const at = call.argv.indexOf("--resume");
    if (at >= 0) {
      const id = call.argv[at + 1]!;
      if (!known.has(id)) {
        return (
          options.onRejectedResume?.(id) ?? {
            lines: [],
            stderr: `${UNKNOWN_SESSION}: ${id}`,
            exitCode: 1,
          }
        );
      }
      return { lines: answerLines(id, `answer ${calls.length}`) };
    }
    created += 1;
    const id = `vendor-${created}`;
    known.add(id);
    return { lines: answerLines(id, `answer ${calls.length}`) };
  };

  const spawnCli = (command: string): CommandSpawnHandle => {
    const argvName = /'(tanstack-claude-argv-[^']+\.json)'/.exec(command)![1]!;
    const argvPath = [...written.keys()].find((path) => path.endsWith(argvName))!;
    const argv = JSON.parse(written.get(argvPath)!) as string[];
    let prompt = "";
    let ended!: () => void;
    const endedPromise = new Promise<void>((resolve) => {
      ended = resolve;
    });
    let result: CliReply | undefined;
    const settle = async () => {
      await endedPromise;
      if (result === undefined) {
        const call = { argv, prompt };
        calls.push(call);
        result = reply(call);
      }
      return result;
    };
    return {
      pid: 4242,
      stdout: (async function* () {
        for (const line of (await settle()).lines) {
          yield `${line}\n`;
        }
      })(),
      stderr: (async function* () {
        const { stderr } = await settle();
        if (stderr !== undefined) {
          yield `${stderr}\n`;
        }
      })(),
      stdin: {
        async write(data: string) {
          prompt += data;
        },
        async end() {
          ended();
        },
      },
      async wait() {
        return (await settle()).exitCode ?? 0;
      },
      async kill() {
        ended();
      },
    };
  };

  const runner: CommandRunner = {
    async exec(command, args, execOptions) {
      if (command === "docker" && args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ServerVersion: "29.10.0",
            SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
            MemoryLimit: true,
            CpuCfsQuota: true,
            PidsLimit: true,
          }),
          stderr: "",
        };
      }
      if (command === "docker" && args[0] === "volume") {
        return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (command === "docker" && args[0] === "run") {
        return { exitCode: 0, stdout: "container-resume-1\n", stderr: "" };
      }
      if (command === "claude" && args[0] === "--version") {
        return { exitCode: 0, stdout: "2.1.330\n", stderr: "" };
      }
      const shellLine = args.at(-1) ?? "";
      const target = /base64 -d > '([^']+)'/.exec(shellLine);
      const stdin = execOptions?.stdin;
      if (target !== null && stdin !== undefined) {
        written.set(
          target[1]!,
          atob(typeof stdin === "string" ? stdin : new TextDecoder().decode(stdin)),
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async spawn(_command, args) {
      return spawnCli(args.at(-1) ?? "");
    },
  };

  return { calls, runner };
}

type FakeClaude = ReturnType<typeof createFakeClaude>;

async function startResumeServer(
  cli: FakeClaude,
  bot: { persona: string } = { persona: "Terse." },
): Promise<{ server: RunningServer; botId: string; sessionId: string }> {
  const tempDb = createTempDatabase("der-session-resume-");
  const workspaceDir = join(tempDb.dir, "workspaces");
  mkdirSync(workspaceDir, { recursive: true });
  const server = await startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateHost: "127.0.0.1",
      restateListen: 0,
      restateMode: "direct",
      databasePath: tempDb.dbPath,
      memoryProjectionDir: join(tempDb.dir, "memory"),
      skillsRootDir: join(tempDb.dir, "skills"),
      workspaceRootDir: workspaceDir,
      dockerHost: "unix:///run/der-rootless/docker.sock",
      enabledEngines: ["claude-code", "fixture"],
    },
    commandRunner: cli.runner,
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  const created = server.store.createBot({
    id: "bot-resume",
    name: "Resume Bot",
    persona: bot.persona,
    defaultEngine: "claude-code",
    allowedEngines: ["claude-code", "fixture"],
  });
  const session = server.store.createSession({
    id: "sess-resume",
    botId: created.id,
    title: "Long",
    engine: "claude-code",
  });
  return { server, botId: created.id, sessionId: session.id };
}

async function finished(server: RunningServer, runId: string): Promise<Run> {
  return waitUntil(
    async () => {
      const run = server.store.getRun(runId);
      return run !== undefined && run.status !== "queued" && run.status !== "running"
        ? run
        : undefined;
    },
    { timeoutMs: 20_000, label: `run ${runId} finished` },
  );
}

async function ask(
  ctx: { server: RunningServer; botId: string; sessionId: string },
  text: string,
  engine?: "fixture",
): Promise<Run> {
  const { run } = await ctx.server.coordinator.admit({
    botId: ctx.botId,
    sessionId: ctx.sessionId,
    origin: "http",
    idempotencyKey: `key-${text}`,
    input: { parts: [{ type: "text", text }] },
    ...(engine !== undefined ? { engine } : {}),
  });
  const done = await finished(ctx.server, run.id);
  expect([text, done.status]).toEqual([text, "completed"]);
  return done;
}

function resumeTarget(call: CliCall | undefined): string | undefined {
  const at = call?.argv.indexOf("--resume") ?? -1;
  return at >= 0 ? call!.argv[at + 1] : undefined;
}

describe("resume the vendor session on the second Run", () => {
  it("passes the stored vendor session id and only the new user message", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);

    const first = await ask(ctx, "first question");
    const second = await ask(ctx, "second question");

    expect(cli.calls.map((call) => [resumeTarget(call), call.prompt])).toEqual([
      [undefined, "first question"],
      ["vendor-1", "second question"],
    ]);
    expect([first.contextMode, second.contextMode]).toEqual(["rebuilt", "resumed"]);
    expect(ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")).toMatchObject({
      vendorSessionId: "vendor-1",
      lastOrdinal: 4,
      pendingRunId: null,
    });
  }, 60_000);
});

describe("carry a memory edit once in a resumed Run", () => {
  it("sends the context note on the next resumed Run and none on the Run after it", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);

    await ask(ctx, "first question");
    await ask(ctx, "second question");
    await ctx.server.memory.write({ botId: ctx.botId, markdown: "likes tea" });
    await ask(ctx, "third question");
    await ask(ctx, "fourth question");

    expect(cli.calls.map((call) => call.prompt)).toEqual([
      "first question",
      "second question",
      "[Context update: memory and skills changed since your last turn]\n[Bot Memory v1]\nlikes tea\n\nthird question",
      "fourth question",
    ]);
  }, 60_000);
});

describe("rebuild the context", () => {
  async function runEventsOf(server: RunningServer, runId: string): Promise<RunEvent[]> {
    return server.store.readRunEventsAfter(runId, 0, 500);
  }

  it.each([
    {
      case: "the CLI exits with the unknown-session error",
      onRejectedResume: undefined,
    },
    {
      case: "the CLI answers with a different session id and stale text",
      onRejectedResume: () => ({ lines: answerLines("vendor-replacement", "STALE ATTEMPT TEXT") }),
    },
  ])(
    "finishes rebuilt with a new session id when $case",
    async ({ onRejectedResume }) => {
      const cli = createFakeClaude(onRejectedResume ? { onRejectedResume } : {});
      const ctx = await startResumeServer(cli);
      await ask(ctx, "first question");
      ctx.server.store.saveEngineSession({
        sessionId: ctx.sessionId,
        engine: "claude-code",
        vendorSessionId: "vendor-lost",
        baseHash: ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")!.baseHash,
        contextHash: ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")!.contextHash,
        lastOrdinal: 2,
      });

      const second = await ask(ctx, "second question");

      const assistantTexts = ctx.server.store
        .listMessages(ctx.sessionId)
        .filter((message) => message.role === "assistant")
        .map((message) => message.parts);
      const chunks = JSON.stringify((await runEventsOf(ctx.server, second.id)).map((e) => e.chunk));
      expect([
        cli.calls.map((call) => resumeTarget(call)),
        cli.calls[2]!.prompt.includes("first question"),
        cli.calls[2]!.prompt.endsWith("second question"),
        second.contextMode,
        ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
        assistantTexts,
        chunks.includes("STALE ATTEMPT TEXT"),
        chunks.includes("vendor-replacement"),
      ]).toEqual([
        [undefined, "vendor-lost", undefined],
        true,
        true,
        "rebuilt",
        "vendor-2",
        [[{ type: "text", text: "answer 1" }], [{ type: "text", text: "answer 3" }]],
        false,
        false,
      ]);
    },
    60_000,
  );

  it("finishes rebuilt with the full prompt after a persona edit", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");

    ctx.server.store.updateBot(ctx.botId, { persona: "Verbose pirate." });
    const second = await ask(ctx, "second question");

    const argv = cli.calls[1]!.argv;
    expect([
      resumeTarget(cli.calls[1]),
      cli.calls[1]!.prompt.includes("first question"),
      argv[argv.indexOf("--append-system-prompt") + 1]!.includes("Verbose pirate."),
      second.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
    ]).toEqual([undefined, true, true, "rebuilt", "vendor-2"]);
  }, 60_000);

  it("finishes rebuilt after a turn on another engine and carries that turn", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");
    await ask(ctx, "direct: reply from the fixture engine", "fixture");

    const third = await ask(ctx, "third question");

    expect([
      resumeTarget(cli.calls[1]),
      cli.calls[1]!.prompt.includes("reply from the fixture engine"),
      third.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
    ]).toEqual([undefined, true, "rebuilt", "vendor-2"]);
  }, 60_000);

  it("finishes rebuilt when the engine step ran before and was replayed", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");
    const { run } = await ctx.server.coordinator.admitOnly({
      botId: ctx.botId,
      sessionId: ctx.sessionId,
      origin: "http",
      idempotencyKey: "key-second question",
      input: { parts: [{ type: "text", text: "second question" }] },
    });
    const replayingDriver: CoordinatorDriver = {
      async runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const firstExecution = await fn();
        return name === "run-engine" ? fn() : firstExecution;
      },
      async awaitApproval() {
        throw new Error("no approvals in this test");
      },
      async resolveApproval() {},
    };

    await ctx.server.coordinator.executeRun(run.id, replayingDriver);

    const done = await finished(ctx.server, run.id);
    expect([
      cli.calls.map((call) => resumeTarget(call)),
      cli.calls[2]!.prompt.includes("first question"),
      done.status,
      done.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
    ]).toEqual([[undefined, "vendor-1", undefined], true, "completed", "rebuilt", "vendor-2"]);
  }, 60_000);
});
