import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROBLEM_DETAILS_MEDIA_TYPE,
  type Bot,
  type EngineReadiness,
  type MemoryRecord,
  type Routine,
  type Skill,
  type ToolDescriptor,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { CommandRunner } from "@der/runtime/sandbox";
import { parseServerConfig } from "../src/config";
import { startServer } from "../src/main";
import { createTempDatabase } from "./fixtures/restate-harness";

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
});
