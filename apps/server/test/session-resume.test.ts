import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CoordinatorDriver } from "#workflows/coordinator";
import { finalizeInterruptedUncertainStep } from "#workflows/run-steps";
import type { Run, RunEvent } from "@der/domain";
import type { CommandRunner, CommandSpawnHandle } from "@der/runtime/sandbox";
import { SqliteStore, type FinishRunInput, type FinishRunOutcome } from "@der/storage";
import { MEMORY_ROUTINE_SLOTS_MIGRATION } from "@der/storage/memory";
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
function createFakeClaude(
  options: {
    readonly onRejectedResume?: (id: string) => CliReply;
    readonly onCall?: (index: number) => CliReply | undefined;
    readonly onReadinessProbe?: () => Promise<void>;
  } = {},
) {
  const calls: CliCall[] = [];
  const known = new Set<string>();
  const written = new Map<string, string>();
  let created = 0;

  const reply = (call: CliCall): CliReply => {
    const scripted = options.onCall?.(calls.length - 1);
    if (scripted !== undefined) {
      return scripted;
    }
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
        await options.onReadinessProbe?.();
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

  return { calls, runner, forget: (id: string) => known.delete(id) };
}

type FakeClaude = ReturnType<typeof createFakeClaude>;

/** Records every finish and runs `afterFinish` once, when the next finish has committed. */
class FinishHookStore extends SqliteStore {
  afterFinish: (() => Promise<void>) | undefined;
  readonly finishes: FinishRunInput[] = [];

  override async finishRun(input: FinishRunInput): Promise<FinishRunOutcome> {
    this.finishes.push(input);
    const finished = await super.finishRun(input);
    const hook = this.afterFinish;
    this.afterFinish = undefined;
    await hook?.();
    return finished;
  }
}

async function startResumeServer(
  cli: FakeClaude,
  openStore?: (dbPath: string) => SqliteStore,
): Promise<{ server: RunningServer; botId: string; sessionId: string; dir: string }> {
  const tempDb = createTempDatabase("der-session-resume-");
  cleanups.push(tempDb.cleanup);
  const server = await openResumeServer(cli, tempDb.dir, openStore?.(tempDb.dbPath));
  const created = server.store.createBot({
    id: "bot-resume",
    name: "Resume Bot",
    persona: "Terse.",
    defaultEngine: "claude-code",
    allowedEngines: ["claude-code", "fixture", "codex"],
  });
  const session = server.store.createSession({
    id: "sess-resume",
    botId: created.id,
    title: "Long",
    engine: "claude-code",
  });
  return { server, botId: created.id, sessionId: session.id, dir: tempDb.dir };
}

async function openResumeServer(
  cli: FakeClaude,
  dir: string,
  store?: SqliteStore,
  claudeModel = "claude-sonnet-4-5",
): Promise<RunningServer> {
  const workspaceDir = join(dir, "workspaces");
  mkdirSync(workspaceDir, { recursive: true });
  const server = await startServer({
    ...(store !== undefined ? { store } : {}),
    config: {
      host: "127.0.0.1",
      port: 0,
      restateHost: "127.0.0.1",
      restateListen: 0,
      restateMode: "direct",
      databasePath: join(dir, "der.sqlite"),
      memoryProjectionDir: join(dir, "memory"),
      skillsRootDir: join(dir, "skills"),
      workspaceRootDir: workspaceDir,
      dockerHost: "unix:///run/der-rootless/docker.sock",
      enabledEngines: ["claude-code", "fixture"],
      engineModels: { codex: "gpt-5-codex", claudeCode: claudeModel, antigravity: "default" },
    },
    commandRunner: cli.runner,
  });
  cleanups.push(async () => {
    await server.close();
    store?.close();
  });
  return server;
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
      cli.forget("vendor-1");

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
        [undefined, "vendor-1", undefined],
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

  it("finishes rebuilt with the full prompt after a restart with another Claude model", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");
    await ctx.server.close();

    const server = await openResumeServer(cli, ctx.dir, undefined, "claude-opus-4-1");
    const second = await ask({ ...ctx, server }, "second question");

    const argv = cli.calls[1]!.argv;
    expect([
      resumeTarget(cli.calls[1]),
      argv[argv.indexOf("--model") + 1],
      cli.calls[1]!.prompt,
      second.contextMode,
    ]).toEqual([
      undefined,
      "claude-opus-4-1",
      "Previous conversation:\nUser: first question\nAssistant: answer 1\n\nsecond question",
      "rebuilt",
    ]);
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

  it("finishes rebuilt with every message after a turn on an unregistered engine failed", async () => {
    const cli = createFakeClaude();
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");
    const { run: failing } = await ctx.server.coordinator.admit({
      botId: ctx.botId,
      sessionId: ctx.sessionId,
      origin: "http",
      idempotencyKey: "key-codex-turn",
      input: { parts: [{ type: "text", text: "codex question" }] },
      engine: "codex",
    });
    const failed = await finished(ctx.server, failing.id);

    const third = await ask(ctx, "third question");

    expect([
      failed.status,
      resumeTarget(cli.calls[1]),
      cli.calls[1]!.prompt,
      third.contextMode,
    ]).toEqual([
      "failed",
      undefined,
      "Previous conversation:\nUser: first question\nAssistant: answer 1\nUser: codex question\n\nthird question",
      "rebuilt",
    ]);
  }, 60_000);

  async function executeWithReplayedEngineStep(ctx: {
    server: RunningServer;
    botId: string;
    sessionId: string;
  }): Promise<Run> {
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
    return finished(ctx.server, run.id);
  }

  function assistantTexts(ctx: { server: RunningServer; sessionId: string }): string[] {
    return ctx.server.store
      .listMessages(ctx.sessionId)
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      );
  }

  function textDeltas(events: readonly RunEvent[]): string[] {
    return events.flatMap((event) => {
      const chunk = event.chunk as Record<string, unknown>;
      return chunk["type"] === "TEXT_MESSAGE_CONTENT" ? [String(chunk["delta"])] : [];
    });
  }

  function textDeltasAndAttemptResets(events: readonly RunEvent[]): string[] {
    return events.flatMap((event) => {
      const chunk = event.chunk as Record<string, unknown>;
      if (chunk["type"] === "CUSTOM" && chunk["name"] === "der.attempt-reset") {
        return ["<attempt-reset>"];
      }
      return chunk["type"] === "TEXT_MESSAGE_CONTENT" ? [String(chunk["delta"])] : [];
    });
  }

  const PARTIAL_THEN_CRASH: CliReply = {
    lines: [
      initLine("vendor-1"),
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "msg-partial", content: [{ type: "text", text: "PARTIAL" }] },
      }),
    ],
    stderr: "boom",
    exitCode: 1,
  };

  it("finishes with the first answer and usage when a replayed engine step finds a persisted finish", async () => {
    const cli = createFakeClaude({
      onCall: (index) =>
        index === 1
          ? {
              lines: [
                initLine("vendor-1"),
                JSON.stringify({
                  type: "assistant",
                  parent_tool_use_id: null,
                  message: { id: "msg-first", content: [{ type: "text", text: "first attempt" }] },
                }),
                JSON.stringify({
                  type: "result",
                  subtype: "success",
                  session_id: "vendor-1",
                  result: "first attempt",
                  usage: { input_tokens: 11, output_tokens: 22 },
                }),
              ],
            }
          : undefined,
    });
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");

    const done = await executeWithReplayedEngineStep(ctx);

    const events = await runEventsOf(ctx.server, done.id);
    expect([
      cli.calls.map((call) => resumeTarget(call)),
      done.status,
      done.contextMode,
      done.usage?.inputTokens,
      done.usage?.outputTokens,
      assistantTexts(ctx),
      textDeltas(events),
    ]).toEqual([
      [undefined, "vendor-1"],
      "completed",
      "resumed",
      11,
      22,
      ["answer 1", "first attempt"],
      ["first attempt"],
    ]);
  }, 60_000);

  it("finishes rebuilt with only the new attempt's output when a replayed engine step finds no finish", async () => {
    const cli = createFakeClaude({
      onCall: (index) => (index === 1 ? PARTIAL_THEN_CRASH : undefined),
    });
    const ctx = await startResumeServer(cli);
    await ask(ctx, "first question");

    const done = await executeWithReplayedEngineStep(ctx);

    const events = await runEventsOf(ctx.server, done.id);
    const terminal = events.find((event) => event.isTerminal === true)!;
    const rebuiltAttempt = events.filter((event) =>
      event.chunkKey.endsWith(terminal.chunkKey.slice(terminal.chunkKey.indexOf(":replay-"))),
    );
    expect([
      cli.calls.map((call) => resumeTarget(call)),
      cli.calls[2]!.prompt.includes("first question"),
      done.status,
      done.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
      assistantTexts(ctx),
      textDeltas(rebuiltAttempt),
      textDeltasAndAttemptResets(events),
    ]).toEqual([
      [undefined, "vendor-1", undefined],
      true,
      "completed",
      "rebuilt",
      "vendor-2",
      ["answer 1", "answer 3"],
      ["answer 3"],
      ["PARTIAL", "<attempt-reset>", "answer 3"],
    ]);
  }, 60_000);

  /**
   * Finishes "second question" and admits "third question" the moment that finish commits. The
   * successor's engine step runs once, its result is lost, `beforeReplay` runs and the step runs
   * again.
   */
  async function raceSuccessorAgainstFinish(
    cli: FakeClaude,
    beforeReplay: (store: FinishHookStore, predecessorId: string) => Promise<void>,
  ): Promise<{ ctx: Awaited<ReturnType<typeof startResumeServer>>; successor: Run }> {
    let hookStore: FinishHookStore | undefined;
    const ctx = await startResumeServer(cli, (dbPath) => {
      hookStore = new FinishHookStore({
        filename: dbPath,
        extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
      });
      return hookStore;
    });
    await ask(ctx, "first question");

    const inline: CoordinatorDriver = {
      runStep: (_name, fn) => fn(),
      async awaitApproval() {
        throw new Error("no approvals in this test");
      },
      async resolveApproval() {},
    };
    let firstEngineStepDone!: () => void;
    const firstEngineStep = new Promise<void>((resolve) => {
      firstEngineStepDone = resolve;
    });
    let releaseReplay!: () => void;
    const replay = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayingAfterRelease: CoordinatorDriver = {
      ...inline,
      async runStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
        if (name !== "run-engine") {
          return fn();
        }
        await fn();
        firstEngineStepDone();
        await replay;
        return fn();
      },
    };
    let successorId = "";
    let successorExecution: Promise<void> | undefined;
    hookStore!.afterFinish = async () => {
      const { run } = await ctx.server.coordinator.admitOnly({
        botId: ctx.botId,
        sessionId: ctx.sessionId,
        origin: "http",
        idempotencyKey: "key-third question",
        input: { parts: [{ type: "text", text: "third question" }] },
      });
      successorId = run.id;
      successorExecution = ctx.server.coordinator.executeRun(run.id, replayingAfterRelease);
      await firstEngineStep;
    };

    const { run: predecessor } = await ctx.server.coordinator.admitOnly({
      botId: ctx.botId,
      sessionId: ctx.sessionId,
      origin: "http",
      idempotencyKey: "key-second question",
      input: { parts: [{ type: "text", text: "second question" }] },
    });
    await ctx.server.coordinator.executeRun(predecessor.id, inline);
    await beforeReplay(hookStore!, predecessor.id);
    releaseReplay();
    await successorExecution;
    return { ctx, successor: await finished(ctx.server, successorId) };
  }

  it("rebuilds a replayed Run that was admitted the moment the Run before it finished", async () => {
    const cli = createFakeClaude({
      onCall: (index) => (index === 2 ? PARTIAL_THEN_CRASH : undefined),
    });

    const { ctx, successor } = await raceSuccessorAgainstFinish(cli, async () => {});

    expect([
      resumeTarget(cli.calls[3]),
      cli.calls[3]!.prompt.includes("first question"),
      successor.status,
      successor.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
    ]).toEqual([undefined, true, "completed", "rebuilt", "vendor-2"]);
  }, 60_000);

  it("keeps a refused vendor session gone when the finish before it replays during the rebuild", async () => {
    const cli = createFakeClaude({
      onCall: (index) =>
        index === 2
          ? { lines: [], stderr: `${UNKNOWN_SESSION}: vendor-1`, exitCode: 1 }
          : index === 3
            ? PARTIAL_THEN_CRASH
            : undefined,
    });
    let afterReplayedFinish: unknown;

    const { ctx, successor } = await raceSuccessorAgainstFinish(
      cli,
      async (store, predecessorId) => {
        await store.finishRun(store.finishes.find((input) => input.runId === predecessorId)!);
        afterReplayedFinish = store.getEngineSession("sess-resume", "claude-code");
      },
    );

    expect([
      cli.calls.map((call) => resumeTarget(call)),
      afterReplayedFinish,
      successor.status,
      successor.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
    ]).toEqual([
      [undefined, "vendor-1", "vendor-1", undefined, undefined],
      null,
      "completed",
      "rebuilt",
      "vendor-2",
    ]);
  }, 60_000);
});

describe("leave the successor's vendor session alone", () => {
  it("makes no vendor call and keeps the successor's session when an interrupted Run plans late", async () => {
    let holdNextProbe = false;
    let probeHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      probeHeld = resolve;
    });
    let releaseProbe!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const cli = createFakeClaude({
      onReadinessProbe: async () => {
        if (holdNextProbe) {
          holdNextProbe = false;
          probeHeld();
          await released;
        }
      },
    });
    const ctx = await startResumeServer(cli);
    const { run: stale } = await ctx.server.coordinator.admitOnly({
      botId: ctx.botId,
      sessionId: ctx.sessionId,
      origin: "http",
      idempotencyKey: "key-stale question",
      input: { parts: [{ type: "text", text: "stale question" }] },
    });
    holdNextProbe = true;
    const staleExecution = ctx.server.coordinator.executeRun(stale.id, {
      runStep: (_name, fn) => fn(),
      async awaitApproval() {
        throw new Error("no approvals in this test");
      },
      async resolveApproval() {},
    });
    await held;
    await finalizeInterruptedUncertainStep(
      { store: ctx.server.store },
      { run: stale, effectId: "effect-1", detail: "Host effect outcome is uncertain." },
    );
    await ask(ctx, "second question");

    releaseProbe();
    await staleExecution;

    const staleRun = ctx.server.store.getRun(stale.id);
    expect([
      cli.calls.map((call) => [resumeTarget(call), call.prompt]),
      staleRun?.status,
      staleRun?.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "claude-code")?.vendorSessionId,
    ]).toEqual([
      [[undefined, "Previous conversation:\nUser: stale question\n\nsecond question"]],
      "interrupted",
      null,
      "vendor-1",
    ]);
  }, 60_000);
});
