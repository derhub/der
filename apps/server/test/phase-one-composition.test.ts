import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROBLEM_DETAILS_MEDIA_TYPE,
  type Approval,
  type Bot,
  type EffectIdentity,
  type Engine,
  type EngineReadiness,
  type MemoryRecord,
  type Routine,
  type Run,
  type RunAdmission,
  type Skill,
  type ToolDescriptor,
  type ToolResult,
  type Tools,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { CommandExecOptions, CommandRunner, CommandSpawnHandle } from "@der/runtime/sandbox";
import { parseServerConfig } from "../src/config";
import { buildEngineHostTools, startServer } from "../src/main";
import { createDirectWorkflow, UncertainEffectError } from "../src/workflows/index";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("validate Phase 1 startup configuration", () => {
  it("defaults to loopback host, loopback Restate endpoints, and all official engines", () => {
    const config = parseServerConfig(undefined, {});
    expect(config.host).toBe("127.0.0.1");
    expect(config.restateHost).toBe("127.0.0.1");
    expect(config.restateIngressUrl).toBe("http://127.0.0.1:8080");
    expect(config.restateAdminUrl).toBe("http://127.0.0.1:9070");
    expect(config.restateMode).toBe("restate");
    expect(config.enabledEngines).toEqual(["codex", "claude-code", "antigravity"]);
    expect(config.dockerUser).toBe("1000:1000");
  });

  it.each([
    {
      name: "root docker user",
      env: { DER_DOCKER_USER: "root" },
      message: /non-root/i,
    },
    {
      name: "uid 0 docker user",
      env: { DER_DOCKER_USER: "0:1000" },
      message: /non-root/i,
    },
    {
      name: "host docker egress network",
      env: { DER_DOCKER_EGRESS_NETWORK: "host" },
      message: /host|bridge/i,
    },
    {
      name: "bridge docker egress network",
      env: { DER_DOCKER_EGRESS_NETWORK: "bridge" },
      message: /host|bridge/i,
    },
    {
      name: "docker egress network without proxy URL",
      env: { DER_DOCKER_EGRESS_NETWORK: "der-egress-codex" },
      message: /DER_DOCKER_EGRESS_PROXY_URL/,
    },
    {
      name: "malformed docker egress proxy URL",
      env: {
        DER_DOCKER_EGRESS_NETWORK: "der-egress-codex",
        DER_DOCKER_EGRESS_PROXY_URL: "not-a-url",
      },
      message: /proxy URL/i,
    },
    {
      name: "malformed allowed origin",
      env: { DER_ALLOWED_ORIGINS: "http://127.0.0.1:3000/trailing" },
      message: /origin/i,
    },
    {
      name: "invalid restate mode",
      env: { DER_RESTATE_MODE: "invalid" },
      message: /DER_RESTATE_MODE/,
    },
    {
      name: "home assistant URL without token",
      env: { DER_HOME_ASSISTANT_URL: "http://127.0.0.1:8123" },
      message: /DER_HOME_ASSISTANT_TOKEN/,
    },
    {
      name: "malformed MCP servers JSON",
      env: { DER_MCP_SERVERS_JSON: "{not-json" },
      message: /DER_MCP_SERVERS_JSON/,
    },
  ])("rejects invalid startup setting: $name", ({ env, message }) => {
    expect(() => parseServerConfig(undefined, env)).toThrow(message);
  });
});

describe("serve Phase 1 memory, skills, routines, engines, tools, and shared commands", () => {
  it("exposes versioned bot memory with Markdown projection, safe skill catalog, routine lifecycle, and redacted official engine readiness", async () => {
    const tempDb = createTempDatabase("der-phase1-");
    const memoryDir = join(tempDb.dir, "memory");
    const skillsDir = join(tempDb.dir, "skills");
    const workspaceDir = join(tempDb.dir, "workspaces");

    mkdirSync(join(skillsDir, "daily-brief"), { recursive: true });
    writeFileSync(
      join(skillsDir, "daily-brief", "SKILL.md"),
      [
        "---",
        "name: daily-brief",
        "description: Summarize daily operational status.",
        "---",
        "",
        "Collect open alerts and produce a concise briefing.",
      ].join("\n"),
      "utf8",
    );

    const stubRunner: CommandRunner = {
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
          return { exitCode: 1, stdout: "", stderr: "no such volume" };
        }
        return { exitCode: 127, stdout: "", stderr: "command not found" };
      },
      async spawn() {
        throw new Error("spawn not expected during doctor probe");
      },
    };

    const server = startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen: 0,
        restateMode: "direct",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: memoryDir,
        skillsRootDir: skillsDir,
        workspaceRootDir: workspaceDir,
        dockerHost: "unix:///run/der-rootless/docker.sock",
        seedFixture: true,
        enabledEngines: ["codex", "claude-code", "antigravity", "fixture"],
      },
      commandRunner: stubRunner,
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const botId = server.seededFixture!.bot.id;
    const sessionId = server.seededFixture!.session.id;

    const enginesRes = await fetch(`${server.url}/api/engines`);
    expect(enginesRes.status).toBe(200);
    const enginesPayload = (await enginesRes.json()) as { engines: EngineReadiness[] };
    expect(enginesPayload.engines.map((entry) => entry.engine).sort()).toEqual([
      "antigravity",
      "claude-code",
      "codex",
      "fixture",
    ]);
    for (const readiness of enginesPayload.engines) {
      compiledParsers.engineReadiness.parse(readiness);
      if (readiness.engine !== "fixture") {
        expect(readiness.unattended).not.toBe("ready");
      }
    }

    const toolsRes = await fetch(`${server.url}/api/tools`);
    expect(toolsRes.status).toBe(200);
    const toolsPayload = (await toolsRes.json()) as { tools: ToolDescriptor[] };
    expect(toolsPayload.tools.map((entry) => entry.id)).toEqual([
      "docker.execute",
      "fixture.apply",
      "fixture.uncertain",
      "wasmer.execute",
    ]);

    const deniedTool = await server.tools.invoke({
      effect: {
        runId: "run_unapproved",
        operationKind: "docker",
        operationId: "docker.execute",
        canonicalArguments: { command: "echo", args: ["hi"], timeoutMs: 1000, network: "none" },
        attemptId: "att-1",
      },
    });
    expect(deniedTool.ok).toBe(false);
    expect(deniedTool.outcome).toEqual({ denied: true, code: "tool.approval_required" });

    const unrecognizedTool = await server.tools.invoke({
      effect: {
        runId: "run_unapproved",
        operationKind: "mcp",
        operationId: "unknown.rm_rf",
        canonicalArguments: {},
        attemptId: "att-1",
      },
    });
    expect(unrecognizedTool.ok).toBe(false);
    expect(unrecognizedTool.outcome).toEqual({
      denied: true,
      code: "tool.unrecognized_operation",
    });

    const skillsRes = await fetch(`${server.url}/api/skills`);
    expect(skillsRes.status).toBe(200);
    const skillsBody = (await skillsRes.json()) as { skills: Skill[]; rejected: unknown[] };
    expect(skillsBody.skills).toHaveLength(1);
    expect(skillsBody.skills[0]).toMatchObject({
      id: "daily-brief",
      name: "daily-brief",
      description: "Summarize daily operational status.",
      relativePath: "daily-brief/SKILL.md",
    });
    expect(JSON.stringify(skillsBody)).not.toContain(tempDb.dir);

    const skillDetailRes = await fetch(`${server.url}/api/skills/daily-brief`);
    expect(skillDetailRes.status).toBe(200);
    const skillDetail = (await skillDetailRes.json()) as { skill: Skill; body: string };
    expect(skillDetail.body).toContain("Collect open alerts");

    const emptyMemoryRes = await fetch(`${server.url}/api/bots/${botId}/memory`);
    expect(emptyMemoryRes.status).toBe(200);
    expect(await emptyMemoryRes.json()).toEqual({ memory: null, versions: [] });

    const writeMemoryRes = await fetch(`${server.url}/api/bots/${botId}/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "# Memory\n- Prefer UTC timestamps.\n",
        expectedVersion: 0,
      }),
    });
    expect(writeMemoryRes.status).toBe(200);
    const written = (await writeMemoryRes.json()) as { memory: MemoryRecord };
    expect(written.memory.version).toBe(1);
    expect(readFileSync(join(memoryDir, `${botId}.md`), "utf8")).toBe(
      "# Memory\n- Prefer UTC timestamps.\n",
    );

    const conflictMemoryRes = await fetch(`${server.url}/api/bots/${botId}/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "# Stale\n",
        expectedVersion: 0,
      }),
    });
    expect(conflictMemoryRes.status).toBe(409);
    expect(conflictMemoryRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await conflictMemoryRes.json()).code).toBe(
      "memory.version_conflict",
    );

    const readMemoryRes = await fetch(`${server.url}/api/bots/${botId}/memory?version=1`);
    expect(readMemoryRes.status).toBe(200);
    const readMemoryBody = (await readMemoryRes.json()) as {
      memory: MemoryRecord;
      versions: { version: number; updatedAt: string }[];
    };
    expect(readMemoryBody.memory.markdown).toBe("# Memory\n- Prefer UTC timestamps.\n");
    expect(readMemoryBody.versions.map((entry) => entry.version)).toEqual([1]);

    const createRoutineRes = await fetch(`${server.url}/api/bots/${botId}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        name: "Hourly Fixture Check",
        cron: "0 * * * *",
        enabled: true,
        engine: "fixture",
        prompt: "direct: Hourly status ok",
      }),
    });
    expect(createRoutineRes.status).toBe(201);
    const createdRoutine = (await createRoutineRes.json()) as {
      routine: Routine;
      nextSlot: string | null;
    };
    expect(createdRoutine.routine.revision).toBe(1);
    expect(createdRoutine.nextSlot).not.toBeNull();

    const listRoutinesRes = await fetch(`${server.url}/api/bots/${botId}/routines`);
    expect(listRoutinesRes.status).toBe(200);
    expect(
      ((await listRoutinesRes.json()) as { routines: Routine[] }).routines.map((r) => r.id),
    ).toEqual([createdRoutine.routine.id]);

    const patchRoutineRes = await fetch(`${server.url}/api/routines/${createdRoutine.routine.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Disabled Check",
        enabled: false,
        expectedRevision: 1,
      }),
    });
    expect(patchRoutineRes.status).toBe(200);
    const patchedRoutine = (await patchRoutineRes.json()) as {
      routine: Routine;
      nextSlot: string | null;
    };
    expect(patchedRoutine.routine.revision).toBe(2);
    expect(patchedRoutine.routine.enabled).toBe(false);
    expect(patchedRoutine.nextSlot).toBeNull();

    const stalePatchRes = await fetch(`${server.url}/api/routines/${createdRoutine.routine.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Stale Revision",
        expectedRevision: 1,
      }),
    });
    expect(stalePatchRes.status).toBe(409);
    expect(compiledParsers.problemDetails.parse(await stalePatchRes.json()).code).toBe(
      "routine.revision_conflict",
    );

    const ineligibleBotRes = await fetch(`${server.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex Bot",
        defaultEngine: "codex",
        allowedEngines: ["codex"],
      }),
    });
    const codexBot = (await ineligibleBotRes.json()) as Bot;
    const codexSessionRes = await fetch(`${server.url}/api/bots/${codexBot.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Codex Session" }),
    });
    const codexSession = (await codexSessionRes.json()) as { id: string };

    const ineligibleRoutineRes = await fetch(`${server.url}/api/bots/${codexBot.id}/routines`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: codexSession.id,
        name: "Blocked Codex Schedule",
        cron: "*/15 * * * *",
        enabled: true,
        engine: "codex",
        prompt: "Check repo",
      }),
    });
    expect(ineligibleRoutineRes.status).toBe(409);
    expect(compiledParsers.problemDetails.parse(await ineligibleRoutineRes.json()).code).toBe(
      "routine.engine_ineligible",
    );

    expect(server.commands.listBots().length).toBeGreaterThanOrEqual(2);
    expect((await server.commands.readMemory(botId))?.version).toBe(1);
    expect((await server.commands.listSkills()).map((entry) => entry.id)).toEqual(["daily-brief"]);
  });

  it("rejects cross-origin referer, cross-site fetch metadata, and non-JSON mutations with RFC 9457 Problem Details", async () => {
    const tempDb = createTempDatabase("der-csrf-");
    const server = startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen: 0,
        restateMode: "direct",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: join(tempDb.dir, "memory"),
        skillsRootDir: join(tempDb.dir, "skills"),
        workspaceRootDir: join(tempDb.dir, "workspaces"),
        enabledEngines: ["fixture"],
      },
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const badReferer = await fetch(`${server.url}/api/bots`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: "https://attacker.example/form",
      },
      body: JSON.stringify({
        name: "Blocked",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      }),
    });
    expect(badReferer.status).toBe(403);
    expect(badReferer.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await badReferer.json()).code).toBe(
      "http.origin_forbidden",
    );

    const crossSite = await fetch(`${server.url}/api/bots`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        name: "Blocked",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      }),
    });
    expect(crossSite.status).toBe(403);
    expect(compiledParsers.problemDetails.parse(await crossSite.json()).code).toBe(
      "http.origin_forbidden",
    );

    const nonJson = await fetch(`${server.url}/api/bots`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: "name=Blocked",
    });
    expect(nonJson.status).toBe(415);
    expect(nonJson.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await nonJson.json()).code).toBe(
      "http.unsupported_media_type",
    );
  });

  it("probes shadow-home auth artifacts accurately for authenticated and empty volumes, dispatches production wasmer.execute via der-wasmer-runner, and wires durable permission broker into engine runs", async () => {
    const tempDb = createTempDatabase("der-prod-wiring-");
    const workspaceDir = mkdtempSync("/tmp/der-prod-workspace-");
    const allowedRoDir = join(workspaceDir, "ro");
    mkdirSync(allowedRoDir, { recursive: true });
    cleanups.push(() => rmSync(workspaceDir, { recursive: true, force: true }));

    let shadowHomeAuthenticated = false;
    const dockerRunCalls: Array<{
      readonly args: readonly string[];
      readonly options?: CommandExecOptions;
    }> = [];
    let observedAcpPermissionOutcome: unknown;

    const createFakeAcpPermissionSpawn = (): CommandSpawnHandle => {
      const queue: string[] = [];
      let notify: (() => void) | undefined;
      let closed = false;
      let exitResolver: ((code: number) => void) | undefined;
      const exited = new Promise<number>((resolve) => {
        exitResolver = resolve;
      });
      let pendingPromptId: unknown;
      let permissionRequestId: number | undefined;
      let buffer = "";

      const push = (msg: Record<string, unknown>) => {
        queue.push(`${JSON.stringify(msg)}\n`);
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
        const msg = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          result?: Record<string, unknown>;
        };
        if (msg.method === "initialize") {
          push({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: false } },
          });
          return;
        }
        if (msg.method === "session/new") {
          push({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp-prod-sess-1" } });
          return;
        }
        if (msg.method === "session/prompt") {
          pendingPromptId = msg.id;
          permissionRequestId = 7001;
          push({
            jsonrpc: "2.0",
            id: permissionRequestId,
            method: "session/request_permission",
            params: {
              sessionId: "acp-prod-sess-1",
              toolCall: {
                toolCallId: "tc-prod-1",
                title: "Edit file",
                kind: "edit",
                rawInput: { path: "/workspace/note.txt" },
              },
              options: [
                { optionId: "allow-once-1", name: "Allow once", kind: "allow_once" },
                { optionId: "reject-once-1", name: "Reject once", kind: "reject_once" },
              ],
            },
          });
          return;
        }
        if (msg.id === permissionRequestId && msg.result) {
          observedAcpPermissionOutcome = msg.result["outcome"];
          push({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "acp-prod-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Brokered permission approved." },
              },
            },
          });
          if (pendingPromptId !== undefined) {
            push({
              jsonrpc: "2.0",
              id: pendingPromptId,
              result: { stopReason: "end_turn" },
            });
            pendingPromptId = undefined;
          }
        }
      };

      return {
        pid: 31337,
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
                handleLine(line);
              }
              idx = buffer.indexOf("\n");
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
      async exec(command, args, options) {
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
        if (command === "docker" && args[0] === "volume" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        if (command === "docker" && args[0] === "run") {
          dockerRunCalls.push({ args: [...args], ...(options ? { options } : {}) });
          if (args.includes("der-wasmer-runner:latest")) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                exitCode: 0,
                stdout: "wasmer-container-ok\n",
                stderr: "",
                timedOut: false,
                durationMs: 5,
              }),
              stderr: "",
            };
          }
          if (args.includes("sh") && args.includes("-lc")) {
            return shadowHomeAuthenticated
              ? { exitCode: 0, stdout: "", stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "container-agy-1\n", stderr: "" };
        }
        if (command === "docker" && args[0] === "rm") {
          return { exitCode: 0, stdout: "", stderr: "" };
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
        return createFakeAcpPermissionSpawn();
      },
    };

    const server = startServer({
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
      commandRunner: runner,
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const unauthReports = await server.commands.diagnoseEngines();
    expect(unauthReports[0]).toMatchObject({
      engine: "antigravity",
      interactive: "login_required",
      isolationVerified: true,
    });

    shadowHomeAuthenticated = true;
    const authReports = await server.commands.diagnoseEngines();
    expect(authReports[0]).toMatchObject({
      engine: "antigravity",
      interactive: "ready",
      unattended: "unverified",
      isolationVerified: true,
    });

    const bot = server.store.createBot({
      id: "bot-agy",
      name: "Antigravity Bot",
      persona: "Production wired test bot.",
      defaultEngine: "antigravity",
      allowedEngines: ["antigravity"],
    });
    const session = server.store.createSession({
      id: "sess-agy",
      botId: bot.id,
      title: "Live Broker Session",
      engine: "antigravity",
    });

    const admitRes = await fetch(`${server.url}/api/sessions/${session.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "agy-broker-key-1",
      },
      body: JSON.stringify({
        input: { parts: [{ type: "text", text: "Update note.txt" }] },
      }),
    });
    expect(admitRes.status).toBe(202);
    const admission = (await admitRes.json()) as RunAdmission;

    const pendingApproval = await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run; approval: Approval | null };
      return body.approval && body.approval.decision.status === "pending" ? body.approval : false;
    });
    expect(pendingApproval.effect.operationKind).toBe("engine-permission");
    expect(pendingApproval.effect.operationId).toBe("antigravity:edit:Edit file");

    const approveRes = await fetch(`${server.url}/api/approvals/${pendingApproval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: bot.id,
        sessionId: session.id,
        runId: admission.run.id,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(approveRes.status).toBe(200);

    const finishedRun = await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run };
      return body.run.status === "completed" ? body.run : false;
    });
    expect(finishedRun.status).toBe("completed");
    expect(observedAcpPermissionOutcome).toEqual({
      outcome: "selected",
      optionId: "allow-once-1",
    });

    const wasmerEffect = {
      runId: admission.run.id,
      operationKind: "wasmer" as const,
      operationId: "wasmer.execute",
      canonicalArguments: {
        command: "bash",
        args: ["-c", "echo hi"],
        readonlyPaths: [allowedRoDir],
        timeoutMs: 2000,
        network: "none",
      },
      attemptId: "wasmer-att-1",
    };
    const wasmerApproval = await server.store.requestApproval({
      botId: bot.id,
      sessionId: session.id,
      runId: admission.run.id,
      effect: wasmerEffect,
      prompt: "Run bash in wasmer?",
      awakeable: "awk-wasmer-1",
      deadline: "2099-01-01T00:00:00.000Z",
    });
    await server.store.decide({
      approvalId: wasmerApproval.approval.id,
      botId: bot.id,
      sessionId: session.id,
      runId: admission.run.id,
      status: "approved",
      actor: "operator",
      decidedAt: "2026-11-22T00:00:00.000Z",
    });

    const wasmerToolResult = await server.tools.invoke({ effect: wasmerEffect });
    expect(wasmerToolResult.ok).toBe(true);
    expect(wasmerToolResult.outcome).toMatchObject({
      exitCode: 0,
      stdout: "wasmer-container-ok\n",
    });

    const wasmerContainerCall = dockerRunCalls.find((call) =>
      call.args.includes("der-wasmer-runner:latest"),
    );
    expect(wasmerContainerCall?.args).toContain("--network=none");
    expect(wasmerContainerCall?.args).toContain("--read-only");
    expect(wasmerContainerCall?.args).toContain("--cap-drop=ALL");
    expect(wasmerContainerCall?.args).toContain("--security-opt=no-new-privileges:true");
  });

  it("reuses recorded outcome on replay of a completed approved engine host-tool call and interrupts without re-execution on a crashed started effect", async () => {
    const tempDb = createTempDatabase("der-host-tool-replay-");
    const server = startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen: 0,
        restateMode: "direct",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: join(tempDb.dir, "memory"),
        skillsRootDir: join(tempDb.dir, "skills"),
        workspaceRootDir: join(tempDb.dir, "workspaces"),
        enabledEngines: ["fixture"],
        seedFixture: true,
      },
    });
    cleanups.push(async () => {
      await server.close();
      tempDb.cleanup();
    });

    const bot = server.seededFixture!.bot;
    const session = server.seededFixture!.session;

    let completedInvokeCount = 0;
    const recordingTools: Tools = {
      async list(): Promise<readonly ToolDescriptor[]> {
        return [
          {
            kind: "mcp",
            id: "mcp.side_effect",
            name: "Side Effect Tool",
            description: "Applies an external side effect.",
            requiresApproval: true,
            inputSchema: { type: "object" },
          },
        ];
      },
      async invoke(operation): Promise<ToolResult> {
        completedInvokeCount += 1;
        return {
          ok: true,
          isError: false,
          outcome: {
            applied: true,
            invocation: completedInvokeCount,
            args: operation.effect.canonicalArguments,
          },
        };
      },
    };

    const replayAdmission = await server.store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "http",
      idempotencyKey: "host-tool-replay-completed",
      engine: "fixture",
      input: { parts: [{ type: "text", text: "apply lamp" }] },
    });
    const replayRun = await server.store.markRunRunning(replayAdmission.run.id);

    const directWf = createDirectWorkflow({
      store: server.store,
      engines: new Map(),
      tools: recordingTools,
      approvalTimeoutMs: 10_000,
    });
    cleanups.push(() => directWf.close());

    const makeBroker = (run: Run) => ({
      async requestApproval(req: {
        readonly effect: EffectIdentity;
        readonly prompt: string;
        readonly signal: AbortSignal;
      }) {
        return directWf.awaitApproval!({ run, effect: req.effect, prompt: req.prompt }, req.signal);
      },
    });

    const attempt1Tools = await buildEngineHostTools({
      run: replayRun,
      store: server.store,
      tools: recordingTools,
      approvalBroker: makeBroker(replayRun),
    });
    const firstCallPromise = attempt1Tools[0]!.execute!({ target: "lamp-1" });

    const pendingApproval = await waitUntil(async () => {
      const latest = server.store.getLatestApprovalForRun(replayRun.id);
      return latest && latest.decision.status === "pending" ? latest : false;
    });
    await directWf.decide({
      approvalId: pendingApproval.id,
      botId: bot.id,
      sessionId: session.id,
      runId: replayRun.id,
      status: "approved",
      actor: "operator",
      decidedAt: "2026-11-22T00:00:00.000Z",
    });

    const firstResult = (await firstCallPromise) as ToolResult;
    expect(firstResult).toEqual({
      ok: true,
      isError: false,
      outcome: { applied: true, invocation: 1, args: { target: "lamp-1" } },
    });
    expect(completedInvokeCount).toBe(1);
    expect(server.store.getEffect(pendingApproval.effect)?.status).toBe("completed");

    const attempt2Tools = await buildEngineHostTools({
      run: replayRun,
      store: server.store,
      tools: recordingTools,
      approvalBroker: makeBroker(replayRun),
    });
    const replayedResult = (await attempt2Tools[0]!.execute!({ target: "lamp-1" })) as ToolResult;
    expect(replayedResult).toEqual(firstResult);
    expect(completedInvokeCount).toBe(1);

    await server.store.finishRun({
      runId: replayRun.id,
      status: "completed",
      terminalEvent: {
        chunkKey: `${replayRun.id}:terminal`,
        chunk: { type: "RUN_FINISHED", threadId: session.id, runId: replayRun.id },
      },
    });

    let crashedInvokeCount = 0;
    const crashedTools: Tools = {
      async list(): Promise<readonly ToolDescriptor[]> {
        return recordingTools.list!();
      },
      async invoke(): Promise<ToolResult> {
        crashedInvokeCount += 1;
        return { ok: true, isError: false, outcome: { shouldNeverRun: true } };
      },
    };

    let caughtEngineToolError: unknown;
    const replayEngine: Engine = {
      kind: "fixture",
      async *run(run) {
        const hostTools = await buildEngineHostTools({
          run,
          store: server.store,
          tools: crashedTools,
          approvalBroker: makeBroker(run),
        });
        try {
          await hostTools[0]!.execute!({ target: "lamp-crashed" });
        } catch (error) {
          caughtEngineToolError = error;
        }
        yield {
          type: "completed",
          finalMessage: { parts: [{ type: "text", text: "should not overwrite interrupted" }] },
        };
      },
    };

    const crashWf = createDirectWorkflow({
      store: server.store,
      engines: new Map<Engine["kind"], Engine>([["fixture", replayEngine]]),
      tools: crashedTools,
      approvalTimeoutMs: 10_000,
    });
    cleanups.push(() => crashWf.close());

    const crashedAdmission = await server.store.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "http",
      idempotencyKey: "host-tool-replay-crashed-started",
      engine: "fixture",
      input: { parts: [{ type: "text", text: "apply crashed lamp" }] },
    });
    const crashedRun = crashedAdmission.run;

    const probeTools = await buildEngineHostTools({
      run: crashedRun,
      store: server.store,
      tools: crashedTools,
      approvalBroker: {
        async requestApproval(req) {
          const requested = await server.store.requestApproval({
            botId: bot.id,
            sessionId: session.id,
            runId: crashedRun.id,
            effect: req.effect,
            prompt: req.prompt,
            awakeable: "awk-crashed-started",
            deadline: "2099-01-01T00:00:00.000Z",
          });
          await server.store.decide({
            approvalId: requested.approval.id,
            botId: bot.id,
            sessionId: session.id,
            runId: crashedRun.id,
            status: "approved",
            actor: "operator",
            decidedAt: "2026-11-22T00:00:00.000Z",
          });
          const begun = await server.store.beginEffect(req.effect, {
            approvalId: requested.approval.id,
          });
          expect(begun.kind).toBe("started");
          return {
            status: "denied",
            approvalId: requested.approval.id,
            effect: req.effect,
          };
        },
      },
    });
    await probeTools[0]!.execute!({ target: "lamp-crashed" });
    const seededApproval = server.store.getLatestApprovalForRun(crashedRun.id)!;
    expect(server.store.getEffect(seededApproval.effect)?.status).toBe("started");

    await crashWf.admit({
      botId: bot.id,
      sessionId: session.id,
      origin: "http",
      idempotencyKey: "host-tool-replay-crashed-started",
      engine: "fixture",
      input: { parts: [{ type: "text", text: "apply crashed lamp" }] },
    });

    const interruptedRun = await waitUntil(async () => {
      const current = server.store.getRun(crashedRun.id);
      return current && current.status === "interrupted" ? current : false;
    });
    expect(interruptedRun.status).toBe("interrupted");
    expect(caughtEngineToolError).toBeInstanceOf(UncertainEffectError);
    expect(crashedInvokeCount).toBe(0);
    expect(server.store.getEffect(seededApproval.effect)?.status).toBe("unknown");
  });
});
