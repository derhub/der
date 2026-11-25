import { afterEach, describe, expect, it } from "bun:test";
import {
  formatUtcTimestamp,
  type Engine,
  type EngineEvent,
  type EngineKind,
  type Run,
} from "@der/domain";
import { parseServerConfig } from "#config";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";
import {
  admitOwningRun,
  createNoteHost,
  submitScript,
  type NoteHost,
} from "./fixtures/script-host";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function createRecordingEngine(started: Run[]): Engine {
  return {
    kind: "fixture",
    async diagnose() {
      return {
        engine: "fixture",
        interactive: "ready",
        unattended: "ready",
        isolationVerified: true,
        reasons: [],
      };
    },
    async *run(run: Run): AsyncIterable<EngineEvent> {
      started.push(run);
      yield { type: "failed", code: "engine.unexpected", detail: "no engine may run" };
    },
  };
}

async function startDirectServer(options: { readonly withNotes: boolean }) {
  const tempDb = createTempDatabase("der-script-routines-");
  const host: NoteHost = createNoteHost();
  const engineRuns: Run[] = [];
  const server: RunningServer = await startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateMode: "direct",
      databasePath: tempDb.dbPath,
      memoryProjectionDir: `${tempDb.dir}/memory`,
      skillsRootDir: `${tempDb.dir}/skills`,
      workspaceRootDir: `${tempDb.dir}/workspaces`,
      enabledEngines: ["fixture"],
      approvalTimeoutMs: 30_000,
      seedFixture: true,
    },
    engines: new Map<EngineKind, Engine>([["fixture", createRecordingEngine(engineRuns)]]),
    ...(options.withNotes ? { catalog: host.catalog } : {}),
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return {
    server,
    host,
    engineRuns,
    botId: server.seededFixture!.bot.id,
    sessionId: server.seededFixture!.session.id,
  };
}

async function createScriptRoutine(
  server: RunningServer,
  target: { readonly botId: string; readonly sessionId: string },
  script: string,
  routineId = "rt-script",
) {
  return server.routineSchedule.configure(routineId, {
    kind: "create",
    botId: target.botId,
    sessionId: target.sessionId,
    name: "Nightly",
    cron: "0 3 * * *",
    enabled: true,
    engine: "script",
    script,
  });
}

async function fire(server: RunningServer, routineId: string, day: string) {
  return server.routineSchedule.tick(routineId, {
    revision: 1,
    scheduledSlot: `${day}T03:00:00.000Z`,
    nowOverride: `${day}T03:00:30.000Z`,
  });
}

async function postJson(server: RunningServer, path: string, body: unknown, method = "POST") {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function chunkTypes(server: RunningServer, runId: string): unknown[] {
  return server.store.readRunEventsAfter(runId, 0).map((event) => {
    const chunk = event.chunk as { type: string };
    return chunk.type;
  });
}

describe("routine target: prompt or script, never both", () => {
  it.each([
    {
      name: "both prompt and script",
      body: { name: "x", cron: "0 3 * * *", prompt: "p", script: "return 1" },
    },
    { name: "neither prompt nor script", body: { name: "x", cron: "0 3 * * *" } },
    {
      name: "a script with a chat engine",
      body: { name: "x", cron: "0 3 * * *", script: "return 1", engine: "codex" },
    },
    {
      name: "a prompt with engine script",
      body: { name: "x", cron: "0 3 * * *", prompt: "p", engine: "script" },
    },
  ])("rejects a routine with $name over HTTP", async ({ body }) => {
    const { server, botId, sessionId } = await startDirectServer({ withNotes: true });

    const response = await postJson(server, `/api/bots/${botId}/routines`, { sessionId, ...body });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("routine.invalid_input");
    expect(server.routines.listRoutines(botId)).toEqual([]);
  });

  it("creates a script routine over HTTP and refuses to turn it into a prompt routine", async () => {
    const { server, botId, sessionId } = await startDirectServer({ withNotes: true });

    const created = await postJson(server, `/api/bots/${botId}/routines`, {
      id: "rt-http",
      sessionId,
      name: "Nightly",
      cron: "0 3 * * *",
      script: "return 1",
    });
    const patched = await postJson(server, "/api/routines/rt-http", { prompt: "hello" }, "PATCH");

    expect(created.status).toBe(201);
    expect(((await created.json()) as { routine: unknown }).routine).toMatchObject({
      id: "rt-http",
      engine: "script",
      prompt: null,
      script: "return 1",
    });
    expect(patched.status).toBe(400);
    expect(((await patched.json()) as { code: string }).code).toBe("routine.target_conflict");
  });
});

describe("routine target: script is not a chat engine", () => {
  it("rejects engine script on a bot, a session, a run request and the server config", async () => {
    const { server, botId, sessionId } = await startDirectServer({ withNotes: true });

    const bot = await postJson(server, "/api/bots", {
      name: "Scripted",
      persona: "p",
      defaultEngine: "script",
      allowedEngines: ["script"],
    });
    const session = await postJson(server, `/api/bots/${botId}/sessions`, {
      botId,
      title: "s",
      engine: "script",
    });
    const run = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-script-1" },
      body: JSON.stringify({
        origin: "routine",
        routineId: "rt-any",
        engine: "script",
        input: { parts: [{ type: "text", text: "go" }] },
      }),
    });

    expect([bot.status, session.status, run.status]).toEqual([400, 400, 400]);
    expect(() => parseServerConfig({}, { DER_ENABLED_ENGINES: "script" })).toThrow();
    const engines = (await (await fetch(`${server.url}/api/engines`)).json()) as {
      engines: { engine: string }[];
    };
    expect(engines.engines.map((entry) => entry.engine)).toEqual(["fixture"]);
  });
});

describe("a script routine fires", () => {
  it("completes one script run with the result, a rendered execute call and no engine call", async () => {
    const { server, engineRuns, botId, sessionId } = await startDirectServer({ withNotes: true });
    await createScriptRoutine(
      server,
      { botId, sessionId },
      `return await step.run("notes.read", { key: "a" });`,
    );

    const tick = await fire(server, "rt-script", "2026-06-01");
    const run = await waitUntil(
      () => {
        const current = server.store.getRun(tick.runId!);
        return current?.status === "completed" ? current : false;
      },
      { timeoutMs: 20_000, label: "script routine run" },
    );

    expect(tick.disposition).toBe("admitted");
    expect(tick.slot).toBe("2026-06-01T03:00:00.000Z");
    expect(run).toMatchObject({ engine: "script", origin: "routine", routineId: "rt-script" });
    expect(
      server.routines.listSlots("rt-script").map((slot) => ({
        slot: slot.slot,
        disposition: slot.disposition,
        runId: slot.runId,
      })),
    ).toEqual([{ slot: "2026-06-01T03:00:00.000Z", disposition: "admitted", runId: run.id }]);
    expect(engineRuns).toEqual([]);
    expect(chunkTypes(server, run.id)).toEqual([
      "RUN_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const events = server.store.readRunEventsAfter(run.id, 0).map((event) => event.chunk);
    expect(events[1]).toMatchObject({ type: "TOOL_CALL_START", toolCallName: "execute" });
    expect(JSON.parse((events[2] as { delta: string }).delta)).toEqual({
      script: `return await step.run("notes.read", { key: "a" });`,
    });
    expect(JSON.parse((events[4] as { content: string }).content)).toEqual({
      ok: true,
      result: { value: "value-a" },
      logs: [],
      truncated: false,
    });
    expect(
      server.store.listMessages(sessionId).map((message) => ({
        role: message.role,
        parts: message.parts,
      })),
    ).toEqual([
      { role: "user", parts: [{ type: "text", text: 'Run script routine "Nightly"' }] },
      { role: "assistant", parts: [{ type: "text", text: 'Script result: {"value":"value-a"}' }] },
    ]);
  }, 60_000);

  it("fails the run with the script error and starts no engine", async () => {
    const { server, engineRuns, botId, sessionId } = await startDirectServer({ withNotes: true });
    await createScriptRoutine(server, { botId, sessionId }, `throw new Error("boom");`);

    const tick = await fire(server, "rt-script", "2026-06-01");
    const run = await waitUntil(
      () => {
        const current = server.store.getRun(tick.runId!);
        return current?.status === "failed" ? current : false;
      },
      { timeoutMs: 20_000, label: "failed script routine run" },
    );

    const terminal = server.store.readRunEventsAfter(run.id, 0).at(-1)?.chunk;
    expect(terminal).toMatchObject({ type: "RUN_ERROR", code: "script.script" });
    expect(engineRuns).toEqual([]);
  }, 60_000);
});

describe("approval on a routine script", () => {
  it("parks every firing on one pending approval and completes it with one effect once approved", async () => {
    const { server, host, botId, sessionId } = await startDirectServer({ withNotes: true });
    await createScriptRoutine(
      server,
      { botId, sessionId },
      `return await step.run("notes.publish", { text: "release" });`,
    );
    const decide = (
      approval: { readonly id: string },
      runId: string,
      status: "approved" | "denied",
    ) =>
      server.commands.decideApproval({
        approvalId: approval.id,
        botId,
        sessionId,
        runId,
        status,
        actor: "operator",
        decidedAt: formatUtcTimestamp(new Date()),
      });
    const pendingApproval = (runId: string) =>
      waitUntil(
        () => {
          const approval = server.store.getLatestApprovalForRun(runId);
          return approval?.decision.status === "pending" ? approval : false;
        },
        { timeoutMs: 20_000, label: "pending approval" },
      );

    const first = await fire(server, "rt-script", "2026-06-01");
    const firstApproval = await pendingApproval(first.runId!);

    expect(server.store.getRun(first.runId!)?.status).toBe("waiting_approval");
    expect(firstApproval.effect).toMatchObject({
      operationKind: "capability",
      operationId: "notes.publish",
      canonicalArguments: { text: "release" },
    });
    expect(host.published).toEqual([]);

    const whileWaiting = await fire(server, "rt-script", "2026-06-02");
    expect(whileWaiting.disposition).toBe("skipped_active_run");

    await decide(firstApproval, first.runId!, "approved");
    await waitUntil(
      () => (server.store.getRun(first.runId!)?.status === "completed" ? true : false),
      { timeoutMs: 20_000, label: "approved script routine run" },
    );
    expect(host.published).toEqual(["release"]);
    expect(
      server.store.getEffect({ ...firstApproval.effect, operationKind: "capability" })?.status,
    ).toBe("completed");

    const second = await fire(server, "rt-script", "2026-06-03");
    const secondApproval = await pendingApproval(second.runId!);
    expect(secondApproval.id).not.toBe(firstApproval.id);
    expect(server.store.getRun(second.runId!)?.status).toBe("waiting_approval");
    expect(host.published).toEqual(["release"]);
  }, 60_000);
});

describe("resume a direct Script routine after a server restart", () => {
  it("keeps the routine attached to the same execution and records one effect", async () => {
    const database = createTempDatabase("der-script-routine-restart-");
    const host = createNoteHost();
    const config = {
      host: "127.0.0.1",
      port: 0,
      restateMode: "direct" as const,
      databasePath: database.dbPath,
      enabledEngines: ["fixture" as const],
      memoryProjectionDir: `${database.dir}/memory`,
      skillsRootDir: `${database.dir}/skills`,
      workspaceRootDir: `${database.dir}/workspaces`,
    };
    const options = { config, catalog: host.catalog };
    const first = await startServer({ ...options, config: { ...config, seedFixture: true } });
    let server: RunningServer | undefined = first;
    cleanups.push(async () => {
      await server?.close();
      database.cleanup();
    });
    await createScriptRoutine(
      first,
      {
        botId: first.seededFixture!.bot.id,
        sessionId: first.seededFixture!.session.id,
      },
      'return await step.run("notes.publish", { text: "release" });',
    );
    const { runId } = await fire(first, "rt-script", "2026-06-01");
    const pending = await waitUntil(
      () => {
        const [approval] = first.store.listPendingApprovalsForRun(runId!);
        return approval ?? false;
      },
      { timeoutMs: 3000, label: "first routine Approval" },
    );
    await first.close();
    server = undefined;

    const reopened = await startServer(options);
    server = reopened;
    await reopened.commands.decideApproval({
      approvalId: pending.id,
      botId: pending.botId,
      sessionId: pending.sessionId,
      runId: pending.runId,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    await waitUntil(() => reopened.store.getRun(pending.runId)?.status === "completed", {
      timeoutMs: 3000,
      label: "resumed routine Run completed",
    });
    expect(host.published).toEqual(["release"]);
    expect(reopened.store.listPendingApprovalsForRun(pending.runId)).toEqual([]);
    expect(
      reopened.store.getEffect({ ...pending.effect, operationKind: "capability" })?.status,
    ).toBe("completed");
  });
});

describe("a script schedules a routine for an agent", () => {
  it("returns the routine from the routines endpoint once the create is approved", async () => {
    const { server, botId, sessionId } = await startDirectServer({ withNotes: false });
    const owner = await admitOwningRun(server, "agent-1");
    const scriptRun = await submitScript(
      server,
      owner,
      `return await step.run("routines.create", {
        id: "rt-agent",
        sessionId: ${JSON.stringify(sessionId)},
        name: "Agent made",
        cron: "0 3 * * *",
        script: "return await step.run('routines.list', {})",
      });`,
    );

    const approval = await waitUntil(
      () => {
        const pending = server.store.getLatestApprovalForRun(owner.run.id);
        return pending?.decision.status === "pending" ? pending : false;
      },
      { timeoutMs: 20_000, label: "routines.create approval" },
    );
    expect(approval.effect.operationId).toBe("routines.create");
    expect(server.routines.listRoutines(botId)).toEqual([]);

    await server.commands.decideApproval({
      approvalId: approval.id,
      botId,
      sessionId,
      runId: owner.run.id,
      status: "approved",
      actor: "operator",
      decidedAt: formatUtcTimestamp(new Date()),
    });
    const result = await server.scriptDriver.wait(scriptRun.id, AbortSignal.timeout(30_000));

    expect(result.ok).toBe(true);
    const listed = (await (await fetch(`${server.url}/api/bots/${botId}/routines`)).json()) as {
      routines: unknown[];
    };
    expect(listed.routines).toMatchObject([
      {
        id: "rt-agent",
        botId,
        sessionId,
        name: "Agent made",
        cron: "0 3 * * *",
        enabled: true,
        engine: "script",
        prompt: null,
        script: "return await step.run('routines.list', {})",
      },
    ]);
  }, 60_000);
});
