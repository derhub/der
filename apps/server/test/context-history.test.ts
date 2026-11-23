import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunAdmission } from "@der/domain";
import type { CommandRunner, CommandSpawnHandle } from "@der/runtime/sandbox";
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

describe("load a long session's history into a Run", () => {
  it("gives the engine the newest message of a 250-message session", async () => {
    const tempDb = createTempDatabase("der-context-history-");
    const workspaceDir = join(tempDb.dir, "workspaces");
    mkdirSync(workspaceDir, { recursive: true });
    const prompts: string[] = [];
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
      commandRunner: createRunner(prompts),
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const bot = server.store.createBot({
      id: "bot-history",
      name: "History Bot",
      persona: "Reads long history.",
      defaultEngine: "antigravity",
      allowedEngines: ["antigravity"],
    });
    const session = server.store.createSession({
      id: "sess-history",
      botId: bot.id,
      title: "Long",
      engine: "antigravity",
    });
    const insert = server.store.database.db.query(
      `INSERT INTO messages (id, bot_id, session_id, ordinal, role, parts_json, run_id, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, NULL, '2026-01-01T00:00:00.000Z')`,
    );
    for (let ordinal = 1; ordinal <= 249; ordinal += 1) {
      insert.run(
        `seed-${ordinal}`,
        bot.id,
        session.id,
        ordinal,
        JSON.stringify([{ type: "text", text: `seed ${ordinal}` }]),
      );
    }

    const admitRes = await fetch(`${server.url}/api/sessions/${session.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "history-key-1" },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "newest message 250" }] } }),
    });
    expect(admitRes.status).toBe(202);
    const admission = (await admitRes.json()) as RunAdmission;
    expect(admission.initialMessage.ordinal).toBe(250);

    await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run };
      return body.run.status === "completed" ? body.run : false;
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("newest message 250");
  });
});
