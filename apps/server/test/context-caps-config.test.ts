import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunAdmission } from "@der/domain";
import type { CommandRunner, CommandSpawnHandle } from "@der/runtime/sandbox";
import { parseServerConfig } from "#config";
import { startServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function createPromptRecordingSpawn(prompts: string[]): CommandSpawnHandle {
  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let exitResolver: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    exitResolver = resolve;
  });
  let buffer = "";

  const push = (message: Record<string, unknown>) => {
    queue.push(`${JSON.stringify(message)}\n`);
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
    exitResolver?.(code);
  };

  const handleLine = (line: string) => {
    const message = JSON.parse(line) as { id?: number | string; method?: string };
    if (message.method === "initialize") {
      push({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: false } },
      });
    } else if (message.method === "session/new") {
      push({ jsonrpc: "2.0", id: message.id, result: { sessionId: "acp-history-1" } });
    } else if (message.method === "session/prompt") {
      prompts.push(line);
      push({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  };

  return {
    pid: 31338,
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
            handleLine(line);
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
}

function createRunner(prompts: string[]): CommandRunner {
  return {
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
        return { exitCode: 0, stdout: "container-history-1\n", stderr: "" };
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
      return createPromptRecordingSpawn(prompts);
    },
  };
}

describe("cap memory and the skill catalog in a Run's prompt", () => {
  it("defaults the memory cap to 24,000 bytes and the catalog cap to 8,000", () => {
    const config = parseServerConfig(undefined, {});

    expect(config.memoryPromptMaxBytes).toBe(24_000);
    expect(config.skillCatalogMaxBytes).toBe(8_000);
  });

  it("reads both caps from the environment", () => {
    const config = parseServerConfig(undefined, {
      DER_MEMORY_PROMPT_MAX_BYTES: "500",
      DER_SKILL_CATALOG_MAX_BYTES: "700",
    });

    expect(config.memoryPromptMaxBytes).toBe(500);
    expect(config.skillCatalogMaxBytes).toBe(700);
  });

  it("gives the engine a memory cut to the configured cap", async () => {
    const tempDb = createTempDatabase("der-context-caps-");
    const workspaceDir = join(tempDb.dir, "workspaces");
    mkdirSync(workspaceDir, { recursive: true });
    const prompts: string[] = [];
    const server = await startServer({
      config: parseServerConfig(
        {
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
        { DER_MEMORY_PROMPT_MAX_BYTES: "300" },
      ),
      commandRunner: createRunner(prompts),
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const bot = server.store.createBot({
      id: "bot-caps",
      name: "Caps Bot",
      persona: "Has a big memory.",
      defaultEngine: "antigravity",
      allowedEngines: ["antigravity"],
    });
    const session = server.store.createSession({
      id: "sess-caps",
      botId: bot.id,
      title: "Caps",
      engine: "antigravity",
    });
    await server.memory.write({
      botId: bot.id,
      markdown: Array.from({ length: 200 }, (_, index) => `memory-line-${index}`).join("\n"),
    });

    const admitRes = await fetch(`${server.url}/api/sessions/${session.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "caps-key-1" },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "hello" }] } }),
    });
    const admission = (await admitRes.json()) as RunAdmission;
    await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run };
      return body.run.status === "completed" ? body.run : false;
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("memory-line-0");
    expect(prompts[0]).toContain("available through the memory capability");
    expect(prompts[0]).not.toContain("memory-line-199");
  });
});
