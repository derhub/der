import { afterEach, describe, expect, it } from "bun:test";
import {
  PROBLEM_DETAILS_MEDIA_TYPE,
  SSE_CACHE_CONTROL,
  SSE_CONTENT_TYPE,
  type Approval,
  type Bot,
  type Message,
  type Run,
  type RunAdmission,
  type Session,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { startServer, type RunningServer } from "../src/main";
import { createFixtureTools } from "../src/workflows/index";
import {
  collectSseFrames,
  createTempDatabase,
  waitUntil,
  type TempDatabaseHandle,
} from "./fixtures/restate-harness";

const cleanups: (() => Promise<void> | void)[] = [];

function startVerticalSliceServer(options?: {
  readonly approvalTimeoutMs?: number;
  readonly seedFixture?: boolean;
}) {
  const tempDb: TempDatabaseHandle = createTempDatabase("der-vertical-");
  const tools = createFixtureTools();
  const running: RunningServer = startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateHost: "127.0.0.1",
      restateListen: 0,
      restateMode: "direct",
      databasePath: tempDb.dbPath,
      approvalTimeoutMs: options?.approvalTimeoutMs ?? 5_000,
      ssePollIntervalMs: 15,
      sseKeepAliveMs: 2_000,
      seedFixture: options?.seedFixture ?? true,
    },
    tools,
  });

  cleanups.push(async () => {
    await running.close();
    tempDb.cleanup();
  });

  return { server: running, tools, tempDb };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("serve operator bot, session, health, engine, and origin checks", () => {
  it("serves healthz, redacted engine readiness, bots, sessions, history, and rejects disallowed origins with strict Problem Details", async () => {
    const { server } = startVerticalSliceServer({ seedFixture: false });

    const healthRes = await fetch(`${server.url}/healthz`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { status: string; timestamp: string };
    expect(health.status).toBe("ok");
    expect(compiledParsers.utcTimestamp.safeParse(health.timestamp).success).toBe(true);

    const enginesRes = await fetch(`${server.url}/api/engines`);
    expect(enginesRes.status).toBe(200);
    const enginesBody = (await enginesRes.json()) as { engines: unknown[] };
    expect(enginesBody.engines).toHaveLength(1);
    expect(compiledParsers.engineReadiness.parse(enginesBody.engines[0])).toEqual({
      engine: "fixture",
      interactive: "ready",
      unattended: "ready",
      isolationVerified: true,
      reasons: [],
    });

    const forbiddenRes = await fetch(`${server.url}/api/bots`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({
        name: "Blocked",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      }),
    });
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    const forbiddenProblem = compiledParsers.problemDetails.parse(await forbiddenRes.json());
    expect(forbiddenProblem.code).toBe("http.origin_forbidden");

    const createBotRes = await fetch(`${server.url}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ops Bot",
        persona: "Concise.",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      }),
    });
    expect(createBotRes.status).toBe(201);
    const bot = compiledParsers.bot.parse((await createBotRes.json()) as Bot);

    const patchBotRes = await fetch(`${server.url}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: "Updated persona." }),
    });
    expect(patchBotRes.status).toBe(200);
    expect(((await patchBotRes.json()) as Bot).persona).toBe("Updated persona.");

    const createSessionRes = await fetch(`${server.url}/api/bots/${bot.id}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Primary" }),
    });
    expect(createSessionRes.status).toBe(201);
    const session = compiledParsers.session.parse((await createSessionRes.json()) as Session);

    const listSessionsRes = await fetch(`${server.url}/api/bots/${bot.id}/sessions`);
    expect(listSessionsRes.status).toBe(200);
    expect(
      ((await listSessionsRes.json()) as { sessions: Session[] }).sessions.map((s) => s.id),
    ).toEqual([session.id]);

    const directRunRes = await fetch(`${server.url}/api/sessions/${session.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "direct-key-1",
      },
      body: JSON.stringify({
        input: { parts: [{ type: "text", text: "direct: Hello from fixture." }] },
      }),
    });
    expect(directRunRes.status).toBe(202);
    const admission = (await directRunRes.json()) as RunAdmission;

    await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run };
      return body.run.status === "completed" ? body.run : false;
    });

    const historyRes = await fetch(`${server.url}/api/sessions/${session.id}/messages`);
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as { messages: Message[] };
    expect(history.messages.map((m) => [m.ordinal, m.role])).toEqual([
      [1, "user"],
      [2, "assistant"],
    ]);
  });
});

describe("enforce exact approval scope, decision replay, key conflicts, and SSE resume through HTTP 204", () => {
  it("runs a fixture approval end to end, enforces scope and key conflicts, and streams SSE with cursor resume and terminal 204", async () => {
    const { server, tools } = startVerticalSliceServer({ seedFixture: true });
    const sessionId = server.seededFixture!.session.id;
    const botId = server.seededFixture!.bot.id;

    const missingKeyRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "lamp-1" }] } }),
    });
    expect(missingKeyRes.status).toBe(400);
    expect(missingKeyRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await missingKeyRes.json()).code).toBe(
      "http.missing_idempotency_key",
    );

    const admitRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "slice-key-1",
      },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "lamp-1" }] } }),
    });
    expect(admitRes.status).toBe(202);
    const admission = compiledParsers.runAdmission.parse(await admitRes.json());
    const runId = admission.run.id;

    const replayAdmitRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "slice-key-1",
      },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "lamp-1" }] } }),
    });
    expect(replayAdmitRes.status).toBe(202);
    const replayAdmission = compiledParsers.runAdmission.parse(await replayAdmitRes.json());
    expect(replayAdmission.run.id).toBe(runId);
    expect(replayAdmission.isDuplicate).toBe(true);

    const keyConflictRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "slice-key-1",
      },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "lamp-different" }] } }),
    });
    expect(keyConflictRes.status).toBe(409);
    expect(keyConflictRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await keyConflictRes.json()).code).toBe(
      "idempotency.conflict",
    );

    const activeConflictRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "slice-key-2",
      },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "lamp-2" }] } }),
    });
    expect(activeConflictRes.status).toBe(409);
    expect(compiledParsers.problemDetails.parse(await activeConflictRes.json()).code).toBe(
      "run.active_conflict",
    );

    const waitingState = await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${runId}`);
      const body = (await res.json()) as { run: Run; approval: Approval | null };
      return body.run.status === "waiting_approval" && body.approval ? body : false;
    });

    const approval = waitingState.approval!;
    expect(approval.decision.status).toBe("pending");
    expect(
      server.store
        .listOutboxEvents({ eventId: `approval:${approval.id}` })
        .map((row) => row.envelope.type),
    ).toEqual(["der.approval.requested"]);

    const invalidCursorRes = await fetch(`${server.url}/api/runs/${runId}/events?after=1%0D%0A`);
    expect(invalidCursorRes.status).toBe(400);
    expect(invalidCursorRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await invalidCursorRes.json()).code).toBe(
      "sse.cursor_invalid",
    );

    const invalidHeaderCursorRes = await fetch(`${server.url}/api/runs/${runId}/events?after=1`, {
      headers: { "last-event-id": "01" },
    });
    expect(invalidHeaderCursorRes.status).toBe(400);
    expect(compiledParsers.problemDetails.parse(await invalidHeaderCursorRes.json()).code).toBe(
      "sse.cursor_invalid",
    );

    const outOfRangeRes = await fetch(`${server.url}/api/runs/${runId}/events?after=999`);
    expect(outOfRangeRes.status).toBe(400);
    expect(compiledParsers.problemDetails.parse(await outOfRangeRes.json()).code).toBe(
      "sse.cursor_out_of_range",
    );

    const firstStreamAbort = new AbortController();
    const firstStreamRes = await fetch(`${server.url}/api/runs/${runId}/events`, {
      signal: firstStreamAbort.signal,
    });
    expect(firstStreamRes.status).toBe(200);
    expect(firstStreamRes.headers.get("content-type")).toBe(SSE_CONTENT_TYPE);
    expect(firstStreamRes.headers.get("cache-control")).toBe(SSE_CACHE_CONTROL);
    const partialFrames = await collectSseFrames(firstStreamRes, {
      maxFrames: 2,
      abortController: firstStreamAbort,
    });
    expect(partialFrames).toHaveLength(2);
    expect(partialFrames.map((frame) => (frame.kind === "event" ? frame.id : null))).toEqual([
      "1",
      "2",
    ]);

    const wrongScopeRes = await fetch(`${server.url}/api/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        sessionId: "sess-other",
        runId,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(wrongScopeRes.status).toBe(409);
    expect(wrongScopeRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await wrongScopeRes.json()).code).toBe(
      "approval.scope_mismatch",
    );

    const approveRes = await fetch(`${server.url}/api/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        sessionId,
        runId,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(approveRes.status).toBe(200);
    const approvedBody = (await approveRes.json()) as { approval: Approval };
    expect(approvedBody.approval.decision.status).toBe("approved");

    const replayApproveRes = await fetch(`${server.url}/api/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        sessionId,
        runId,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(replayApproveRes.status).toBe(200);
    expect(((await replayApproveRes.json()) as { approval: Approval }).approval.decision).toEqual(
      approvedBody.approval.decision,
    );

    const conflictDecisionRes = await fetch(`${server.url}/api/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        sessionId,
        runId,
        status: "denied",
        actor: "operator",
      }),
    });
    expect(conflictDecisionRes.status).toBe(409);
    expect(compiledParsers.problemDetails.parse(await conflictDecisionRes.json()).code).toBe(
      "approval.decision_conflict",
    );

    const resumedStreamRes = await fetch(`${server.url}/api/runs/${runId}/events?after=0`, {
      headers: { "last-event-id": "2" },
    });
    expect(resumedStreamRes.status).toBe(200);
    const remainingFrames = await collectSseFrames(resumedStreamRes);
    const remainingIds = remainingFrames
      .filter((frame) => frame.kind === "event")
      .map((frame) => Number(frame.id));
    expect(remainingIds[0]).toBe(3);
    const terminalId = remainingIds[remainingIds.length - 1]!;
    const lastEvent = remainingFrames[remainingFrames.length - 1];
    expect(lastEvent?.kind === "event" ? JSON.parse(lastEvent.data) : null).toMatchObject({
      type: "RUN_FINISHED",
      runId,
    });

    const terminalReconnectRes = await fetch(`${server.url}/api/runs/${runId}/events`, {
      headers: { "last-event-id": String(terminalId) },
    });
    expect(terminalReconnectRes.status).toBe(204);

    expect(tools.applied).toHaveLength(1);
    expect(tools.applied[0]?.operationId).toBe("fixture.apply");
    expect(
      server.store
        .listOutboxEvents({ eventId: `chat.replied:${runId}` })
        .map((row) => row.envelope.type),
    ).toEqual(["der.chat.replied"]);
  });

  it("expires a timed-out approval and interrupts runs on uncertain effects", async () => {
    const { server, tools } = startVerticalSliceServer({
      approvalTimeoutMs: 120,
      seedFixture: true,
    });
    const sessionId = server.seededFixture!.session.id;
    const botId = server.seededFixture!.bot.id;

    const timeoutRunRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "timeout-key-1",
      },
      body: JSON.stringify({ input: { parts: [{ type: "text", text: "lamp-timeout" }] } }),
    });
    expect(timeoutRunRes.status).toBe(202);
    const timeoutAdmission = (await timeoutRunRes.json()) as RunAdmission;

    const expiredState = await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${timeoutAdmission.run.id}`);
      const body = (await res.json()) as { run: Run; approval: Approval | null };
      return body.run.status === "cancelled" && body.approval?.decision.status === "expired"
        ? body
        : false;
    });

    const lateDecisionRes = await fetch(
      `${server.url}/api/approvals/${expiredState.approval!.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botId,
          sessionId,
          runId: timeoutAdmission.run.id,
          status: "approved",
          actor: "operator",
        }),
      },
    );
    expect(lateDecisionRes.status).toBe(409);
    expect(compiledParsers.problemDetails.parse(await lateDecisionRes.json()).code).toBe(
      "approval.expired",
    );
    expect(tools.applied).toHaveLength(0);

    const uncertainServer = startVerticalSliceServer({
      approvalTimeoutMs: 5_000,
      seedFixture: true,
    });
    const uncertainSessionId = uncertainServer.server.seededFixture!.session.id;
    const uncertainBotId = uncertainServer.server.seededFixture!.bot.id;

    const uncertainRes = await fetch(
      `${uncertainServer.server.url}/api/sessions/${uncertainSessionId}/runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "uncertain-key-1",
        },
        body: JSON.stringify({ input: { parts: [{ type: "text", text: "uncertain:valve-1" }] } }),
      },
    );
    expect(uncertainRes.status).toBe(202);
    const uncertainAdmission = (await uncertainRes.json()) as RunAdmission;

    const pendingUncertain = await waitUntil(async () => {
      const res = await fetch(
        `${uncertainServer.server.url}/api/runs/${uncertainAdmission.run.id}`,
      );
      const body = (await res.json()) as { run: Run; approval: Approval | null };
      return body.run.status === "waiting_approval" && body.approval ? body : false;
    });

    const approveUncertainRes = await fetch(
      `${uncertainServer.server.url}/api/approvals/${pendingUncertain.approval!.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botId: uncertainBotId,
          sessionId: uncertainSessionId,
          runId: uncertainAdmission.run.id,
          status: "approved",
          actor: "operator",
        }),
      },
    );
    expect(approveUncertainRes.status).toBe(200);

    const interruptedRun = await waitUntil(async () => {
      const res = await fetch(
        `${uncertainServer.server.url}/api/runs/${uncertainAdmission.run.id}`,
      );
      const body = (await res.json()) as { run: Run };
      return body.run.status === "interrupted" ? body.run : false;
    });
    expect(interruptedRun.status).toBe("interrupted");
    expect(uncertainServer.server.store.getEffect(pendingUncertain.approval!.effect)?.status).toBe(
      "unknown",
    );
  });
});
