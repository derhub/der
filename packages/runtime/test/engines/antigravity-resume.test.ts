import { describe, expect, it } from "bun:test";
import type { EngineEvent, EngineReadiness, Run } from "@der/domain";
import { createAntigravityEngine, type EngineRunInput } from "@der/runtime/engines";
import type {
  SandboxCapabilities,
  SandboxHandle,
  SandboxProvider,
  SpawnHandle,
} from "@tanstack/ai-sandbox";

const UNKNOWN_TRAJECTORY_ERROR =
  "Failed to send user message: not_found: trajectory not found: 00000000-0000-4000-8000-000000000000: not found";

const readiness: EngineReadiness = {
  engine: "antigravity",
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
  engine: "antigravity",
  status: "running",
  routineId: null,
  checkpoint: null,
  usage: null,
  contextMode: null,
  createdAt: "2026-11-23T10:00:00Z",
  updatedAt: "2026-11-23T10:00:00Z",
  finishedAt: null,
};

interface FakeAgy {
  readonly provider: SandboxProvider;
  readonly loadedSessionIds: string[];
  readonly prompts: string[];
}

/** Stands in for `agy acp`: the only external process. */
function fakeAgy(behavior: {
  readonly loadFails?: boolean;
  readonly promptError?: string;
  readonly thought?: string;
}): FakeAgy {
  const loadedSessionIds: string[] = [];
  const prompts: string[] = [];
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

  const handle = (line: string) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { sessionId?: string; prompt?: Array<{ text: string }> };
    };
    if (message.method === "initialize") {
      push({
        id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      });
    } else if (message.method === "session/load") {
      loadedSessionIds.push(message.params?.sessionId ?? "");
      if (behavior.loadFails) {
        push({ id: message.id, error: { code: -32000, message: "cannot load" } });
      } else {
        push({ id: message.id, result: { sessionId: message.params?.sessionId } });
      }
    } else if (message.method === "session/new") {
      push({ id: message.id, result: { sessionId: "acp-session-new" } });
    } else if (message.method === "session/prompt") {
      prompts.push(message.params?.prompt?.[0]?.text ?? "");
      if (behavior.thought !== undefined) {
        push({
          method: "session/update",
          params: {
            sessionId: message.params?.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: behavior.thought },
            },
          },
        });
      }
      if (behavior.promptError !== undefined) {
        push({ id: message.id, error: { code: -32603, message: behavior.promptError } });
        return;
      }
      push({
        method: "session/update",
        params: {
          sessionId: message.params?.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Second answer." },
          },
        },
      });
      push({ id: message.id, result: { stopReason: "end_turn" } });
    }
  };

  const spawned: SpawnHandle = {
    pid: 3003,
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
        closed = true;
        notify?.();
        exit(0);
      },
    },
    async wait() {
      return exited;
    },
    async kill() {
      closed = true;
      notify?.();
      exit(137);
    },
  };

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
  const sandbox = (id: string): SandboxHandle => ({
    id,
    provider: "docker",
    workspaceRoot: "/workspace",
    capabilities,
    fs: {
      async read() {
        return "";
      },
      async readBytes() {
        return new Uint8Array();
      },
      async write() {},
      async list() {
        return [];
      },
      async mkdir() {},
      async remove() {},
      async rename() {},
      async exists() {
        return false;
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
      async spawn() {
        return spawned;
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
      return sandbox(input.id ?? "fake-container");
    },
    async resume() {
      return null;
    },
    async destroy() {},
  };
  return { provider, loadedSessionIds, prompts };
}

async function runEngine(agy: FakeAgy, input: EngineRunInput): Promise<EngineEvent[]> {
  const engine = createAntigravityEngine({
    model: "gemini-4-neon-low",
    sandboxProvider: agy.provider,
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

const resumedInput: EngineRunInput = {
  messages: [{ role: "user", content: "second question" }],
  systemPrompts: ["You are the base persona."],
  resumeSessionId: "vendor-1",
};

describe("resume an Antigravity session", () => {
  it("prompts the vendor session with the one user message and no system prompts", async () => {
    const agy = fakeAgy({});

    const events = await runEngine(agy, resumedInput);

    expect([agy.loadedSessionIds, agy.prompts, events.at(-1)]).toEqual([
      ["vendor-1"],
      ["second question"],
      {
        type: "completed",
        vendorSessionId: "vendor-1",
        finalMessage: { parts: [{ type: "text", text: "Second answer." }] },
      },
    ]);
  });

  it("keeps the system prompts on a fresh session", async () => {
    const agy = fakeAgy({});

    await runEngine(agy, {
      messages: [{ role: "user", content: "first question" }],
      systemPrompts: ["You are the base persona."],
    });

    expect(agy.prompts).toEqual(["You are the base persona.\n\nfirst question"]);
  });
});

describe("detect an Antigravity session the agent rejects", () => {
  it("reports engine.resume_unavailable when the agent loads an unknown id and then refuses the prompt", async () => {
    const agy = fakeAgy({ promptError: UNKNOWN_TRAJECTORY_ERROR });

    const events = await runEngine(agy, {
      ...resumedInput,
      resumeSessionId: "00000000-0000-4000-8000-000000000000",
    });

    expect(events.at(-1)).toEqual({
      type: "failed",
      code: "engine.resume_unavailable",
      detail: `Unable to resume session "00000000-0000-4000-8000-000000000000": ${UNKNOWN_TRAJECTORY_ERROR}`,
    });
  });

  it.each([
    { case: "a quota error", promptError: "quota exceeded" },
    { case: "an error that mentions a session", promptError: "session token expired, run /login" },
    { case: "an error that mentions a thread", promptError: "thread pool exhausted" },
  ])("keeps $case on the first prompt as a plain run error", async ({ promptError }) => {
    const agy = fakeAgy({ promptError });

    const events = await runEngine(agy, resumedInput);

    expect(events.at(-1)).toEqual({
      type: "failed",
      code: "engine.run_error",
      detail: promptError,
    });
  });

  it("sends no prompt and reports engine.resume_unavailable when the agent cannot load the session", async () => {
    const agy = fakeAgy({ loadFails: true });

    const events = await runEngine(agy, resumedInput);

    expect([agy.loadedSessionIds, agy.prompts, events.at(-1)]).toEqual([
      ["vendor-1"],
      [],
      {
        type: "failed",
        code: "engine.resume_unavailable",
        detail:
          'Unable to resume session "vendor-1": session/load failed; refused the fresh-session fallback',
      },
    ]);
  });
});

describe("keep the run events of a resumed Antigravity turn that fails", () => {
  it("yields the start, session and reasoning chunks before a quota error", async () => {
    const agy = fakeAgy({ thought: "checking the quota", promptError: "quota exceeded" });

    const events = await runEngine(agy, resumedInput);

    expect(
      events.map((event) => {
        if (event.type !== "chunk") {
          return event.type === "failed" ? event.code : event.type;
        }
        const chunk = event.chunk as Record<string, unknown>;
        return chunk["name"] ?? chunk["type"];
      }),
    ).toEqual([
      "RUN_STARTED",
      "sandbox.starting",
      "sandbox.created",
      "antigravity.session-id",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "engine.run_error",
    ]);
  });
});
