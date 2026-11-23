import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "@der/domain";
import type { CommandRunner, CommandSpawnHandle } from "@der/runtime/sandbox";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

/**
 * Stands in for `agy acp`, the only external process. Like the recorded CLI, `session/load`
 * echoes any id; a prompt to an id it never created fails with the trajectory error, optionally
 * after streaming `staleText`.
 */
function createFakeAgy(options: { readonly staleText?: string } = {}) {
  const known = new Set<string>();
  const prompts: { readonly sessionId: string; readonly text: string }[] = [];
  let created = 0;

  const spawnAcp = (): CommandSpawnHandle => {
    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let closed = false;
    let buffer = "";
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });
    const push = (message: Record<string, unknown>) => {
      queue.push(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      notify?.();
      notify = undefined;
    };
    const finish = (code: number) => {
      if (closed) {
        return;
      }
      closed = true;
      notify?.();
      notify = undefined;
      exit(code);
    };
    const textChunk = (sessionId: string, text: string) =>
      push({
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });

    const handle = (line: string) => {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: { sessionId?: string; prompt?: Array<{ text?: string }> };
      };
      if (message.method === "initialize") {
        push({
          id: message.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (message.method === "session/load") {
        push({ id: message.id, result: { sessionId: message.params?.sessionId } });
      } else if (message.method === "session/new") {
        created += 1;
        const sessionId = `acp-${created}`;
        known.add(sessionId);
        push({ id: message.id, result: { sessionId } });
      } else if (message.method === "session/prompt") {
        const sessionId = message.params?.sessionId ?? "";
        prompts.push({
          sessionId,
          text: (message.params?.prompt ?? []).map((part) => part.text ?? "").join(""),
        });
        if (!known.has(sessionId)) {
          if (options.staleText !== undefined) {
            textChunk(sessionId, options.staleText);
          }
          push({
            id: message.id,
            error: {
              code: -32603,
              message: `Failed to send user message: not_found: trajectory not found: ${sessionId}: not found`,
            },
          });
          return;
        }
        textChunk(sessionId, `answer from ${sessionId}`);
        push({ id: message.id, result: { stopReason: "end_turn" } });
      }
    };

    return {
      pid: 31339,
      stdout: (async function* () {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!;
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
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.length > 0) {
              handle(line);
            }
            index = buffer.indexOf("\n");
          }
        },
        async end() {
          finish(0);
        },
      },
      async wait() {
        return exited;
      },
      async kill() {
        finish(137);
      },
    };
  };

  const runner: CommandRunner = {
    async exec(command, args) {
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
        if (args.includes("sh") && args.includes("-lc")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "container-agy-1\n", stderr: "" };
      }
      if (command === "agy" && args[0] === "--version") {
        return { exitCode: 0, stdout: "1.5.9\n", stderr: "" };
      }
      if (command === "agy" && args[0] === "acp") {
        return { exitCode: 0, stdout: "Usage: agy acp --stdio\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async spawn() {
      return spawnAcp();
    },
  };

  return { prompts, runner, forget: (id: string) => known.delete(id) };
}

type FakeAgy = ReturnType<typeof createFakeAgy>;

async function startAgyServer(agy: FakeAgy) {
  const tempDb = createTempDatabase("der-agy-rejection-");
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
      enabledEngines: ["antigravity"],
    },
    commandRunner: agy.runner,
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  const bot = server.store.createBot({
    id: "bot-agy",
    name: "Agy Bot",
    persona: "Terse.",
    defaultEngine: "antigravity",
    allowedEngines: ["antigravity"],
  });
  const session = server.store.createSession({
    id: "sess-agy",
    botId: bot.id,
    title: "Agy",
    engine: "antigravity",
  });
  return { server, botId: bot.id, sessionId: session.id };
}

async function askAndSettle(
  ctx: { server: RunningServer; botId: string; sessionId: string },
  text: string,
): Promise<Run> {
  const { run } = await ctx.server.coordinator.admit({
    botId: ctx.botId,
    sessionId: ctx.sessionId,
    origin: "http",
    idempotencyKey: `key-${text}`,
    input: { parts: [{ type: "text", text }] },
  });
  return waitUntil(
    async () => {
      const current = ctx.server.store.getRun(run.id);
      return current !== undefined && current.status !== "queued" && current.status !== "running"
        ? current
        : undefined;
    },
    { timeoutMs: 20_000, label: `run ${run.id} settled` },
  );
}

function assistantTexts(ctx: { server: RunningServer; sessionId: string }): string[] {
  return ctx.server.store
    .listMessages(ctx.sessionId)
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
}

describe("rebuild when Antigravity rejects a resumed trajectory on the first prompt", () => {
  it("finishes rebuilt on a new trajectory when the prompt fails before any content", async () => {
    const agy = createFakeAgy();
    const ctx = await startAgyServer(agy);
    await askAndSettle(ctx, "first question");
    agy.forget("acp-1");

    const second = await askAndSettle(ctx, "second question");

    expect([
      agy.prompts.map((prompt) => prompt.sessionId),
      second.status,
      second.contextMode,
      ctx.server.store.getEngineSession(ctx.sessionId, "antigravity")?.vendorSessionId,
      assistantTexts(ctx),
    ]).toEqual([
      ["acp-1", "acp-1", "acp-2"],
      "completed",
      "rebuilt",
      "acp-2",
      ["answer from acp-1", "answer from acp-2"],
    ]);
  }, 60_000);

  it("fails the Run without a rebuild once the resumed attempt has streamed content", async () => {
    const agy = createFakeAgy({ staleText: "STALE ATTEMPT TEXT" });
    const ctx = await startAgyServer(agy);
    await askAndSettle(ctx, "first question");
    agy.forget("acp-1");

    const second = await askAndSettle(ctx, "second question");

    expect([
      agy.prompts.map((prompt) => prompt.sessionId),
      second.status,
      assistantTexts(ctx),
    ]).toEqual([["acp-1", "acp-1"], "failed", ["answer from acp-1"]]);
  }, 60_000);
});
