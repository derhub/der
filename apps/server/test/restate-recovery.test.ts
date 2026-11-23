import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  PROBLEM_DETAILS_MEDIA_TYPE,
  type Approval,
  type Run,
  type RunAdmission,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { startServer, type RunningServer } from "../src/main";
import {
  allocateLocalTcpNumber,
  collectSseFrames,
  createTempDatabase,
  ensureLocalRestate,
  registerRestateDeployment,
  waitUntil,
  type LocalRestateHandle,
  type TempDatabaseHandle,
} from "./fixtures/restate-harness";
import { createFixtureHost, ensureScriptGuest } from "./fixtures/script-host";

let restateHandle: LocalRestateHandle | undefined;
let guestArtifactPath = "";
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  restateHandle = await ensureLocalRestate();
  guestArtifactPath = await ensureScriptGuest();
}, 120_000);

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

afterAll(async () => {
  await restateHandle?.stop();
}, 15_000);

describe("recover a pending approval across Bun deployment replacement with Restate running", () => {
  it("preserves pending approval, resumes after Bun server replacement, applies one effect, and finishes SSE through 204", async () => {
    const restate = restateHandle!;
    const tempDb: TempDatabaseHandle = createTempDatabase("der-restate-recovery-");
    cleanups.push(() => tempDb.cleanup());

    const sharedRestateListen = await allocateLocalTcpNumber();
    const fixtureFirst = createFixtureHost();
    let serverFirst: RunningServer | undefined = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen: sharedRestateListen,
        restateIngressUrl: restate.ingressUrl,
        restateAdminUrl: restate.adminUrl,
        restateMode: "restate",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        enabledEngines: ["fixture"],
        approvalTimeoutMs: 60_000,
        ssePollIntervalMs: 20,
        sseKeepAliveMs: 5_000,
        seedFixture: true,
        scriptGuestArtifactPath: guestArtifactPath,
      },
      catalog: fixtureFirst.catalog,
    });
    cleanups.push(async () => {
      if (serverFirst) {
        const toClose = serverFirst;
        serverFirst = undefined;
        await toClose.close();
      }
    });

    await registerRestateDeployment(restate.adminUrl, serverFirst.restateUrl!, { force: true });

    const sessionId = serverFirst.seededFixture!.session.id;
    const botId = serverFirst.seededFixture!.bot.id;

    const admitRes = await fetch(`${serverFirst.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "recovery-key-1",
      },
      body: JSON.stringify({
        input: { parts: [{ type: "text", text: "lamp-recovery" }] },
      }),
    });
    expect(admitRes.status).toBe(202);
    const admission = compiledParsers.runAdmission.parse((await admitRes.json()) as RunAdmission);
    const runId = admission.run.id;

    const conflictRes = await fetch(`${serverFirst.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "recovery-key-1",
      },
      body: JSON.stringify({
        input: { parts: [{ type: "text", text: "lamp-mutated" }] },
      }),
    });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await conflictRes.json()).code).toBe(
      "idempotency.conflict",
    );

    const waitingBeforeRestart = await waitUntil(
      async () => {
        const res = await fetch(`${serverFirst!.url}/api/runs/${runId}`);
        const body = (await res.json()) as { run: Run; approval: Approval | null };
        return body.run.status === "waiting_approval" && body.approval ? body : false;
      },
      { timeoutMs: 15_000, label: "waiting_approval before Bun restart" },
    );

    const approval = waitingBeforeRestart.approval!;
    expect(approval.decision.status).toBe("pending");
    expect(fixtureFirst.applied).toHaveLength(0);
    expect(
      serverFirst.store
        .listOutboxEvents({ eventId: `approval:${approval.id}` })
        .map((row) => row.envelope.type),
    ).toEqual(["der.approval.requested"]);

    const preRestartAbort = new AbortController();
    const preRestartSse = await fetch(`${serverFirst.url}/api/runs/${runId}/events`, {
      signal: preRestartAbort.signal,
    });
    expect(preRestartSse.status).toBe(200);
    const preRestartFrames = await collectSseFrames(preRestartSse, {
      maxFrames: 2,
      abortController: preRestartAbort,
    });
    expect(preRestartFrames.map((frame) => (frame.kind === "event" ? frame.id : null))).toEqual([
      "1",
      "2",
    ]);

    const firstServerToClose = serverFirst;
    serverFirst = undefined;
    await firstServerToClose.close();

    const fixtureReplacement = createFixtureHost();
    const serverReplacement = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen: sharedRestateListen,
        restateIngressUrl: restate.ingressUrl,
        restateAdminUrl: restate.adminUrl,
        restateMode: "restate",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        enabledEngines: ["fixture"],
        approvalTimeoutMs: 60_000,
        ssePollIntervalMs: 20,
        sseKeepAliveMs: 5_000,
        seedFixture: false,
        scriptGuestArtifactPath: guestArtifactPath,
      },
      catalog: fixtureReplacement.catalog,
    });
    cleanups.push(() => serverReplacement.close());

    await registerRestateDeployment(restate.adminUrl, serverReplacement.restateUrl!, {
      force: true,
    });

    const lookupAfterRestart = await fetch(`${serverReplacement.url}/api/runs/${runId}`);
    expect(lookupAfterRestart.status).toBe(200);
    const persistedAfterRestart = (await lookupAfterRestart.json()) as {
      run: Run;
      approval: Approval | null;
    };
    expect(persistedAfterRestart.run.status).toBe("waiting_approval");
    expect(persistedAfterRestart.approval?.id).toBe(approval.id);

    const decisionRes = await fetch(
      `${serverReplacement.url}/api/approvals/${approval.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botId,
          sessionId,
          runId,
          status: "approved",
          actor: "operator",
        }),
      },
    );
    expect(decisionRes.status).toBe(200);
    const decisionBody = (await decisionRes.json()) as { approval: Approval };
    expect(decisionBody.approval.decision.status).toBe("approved");

    const replayDecisionRes = await fetch(
      `${serverReplacement.url}/api/approvals/${approval.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botId,
          sessionId,
          runId,
          status: "approved",
          actor: "operator",
        }),
      },
    );
    expect(replayDecisionRes.status).toBe(200);

    const conflictingDecisionRes = await fetch(
      `${serverReplacement.url}/api/approvals/${approval.id}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          botId,
          sessionId,
          runId,
          status: "denied",
          actor: "operator",
        }),
      },
    );
    expect(conflictingDecisionRes.status).toBe(409);
    expect(conflictingDecisionRes.headers.get("content-type")).toBe(PROBLEM_DETAILS_MEDIA_TYPE);
    expect(compiledParsers.problemDetails.parse(await conflictingDecisionRes.json()).code).toBe(
      "approval.decision_conflict",
    );

    const completedRun = await waitUntil(
      async () => {
        const res = await fetch(`${serverReplacement.url}/api/runs/${runId}`);
        const body = (await res.json()) as { run: Run };
        return body.run.status === "completed" ? body.run : false;
      },
      { timeoutMs: 15_000, label: "resumed run completion after Bun replacement" },
    );

    expect(completedRun.status).toBe("completed");
    expect(fixtureFirst.applied).toHaveLength(0);
    expect(fixtureReplacement.applied).toHaveLength(1);
    expect(fixtureReplacement.applied[0]).toMatchObject({
      runId,
      operationId: "fixture.apply",
      attemptId: approval.effect.attemptId,
      canonicalArguments: { target: "lamp-recovery", mode: "apply" },
    });

    const effectRecord = serverReplacement.store.getEffect({
      ...approval.effect,
      operationKind: "capability",
    });
    expect(effectRecord?.status).toBe("completed");
    expect(
      serverReplacement.store
        .listOutboxEvents({ eventId: `chat.replied:${runId}` })
        .map((row) => row.envelope.type),
    ).toEqual(["der.chat.replied"]);

    const resumedSse = await fetch(`${serverReplacement.url}/api/runs/${runId}/events`, {
      headers: { "last-event-id": "2" },
    });
    expect(resumedSse.status).toBe(200);
    const resumedFrames = await collectSseFrames(resumedSse);
    const ids = resumedFrames
      .filter((frame) => frame.kind === "event")
      .map((frame) => Number(frame.id));
    expect(ids[0]).toBe(3);
    const terminalId = ids[ids.length - 1]!;

    const terminalRes = await fetch(`${serverReplacement.url}/api/runs/${runId}/events`, {
      headers: { "last-event-id": String(terminalId) },
    });
    expect(terminalRes.status).toBe(204);
  }, 45_000);

  it("interrupts a Restate-driven Run without re-execution when an approved effect outcome is uncertain", async () => {
    const restate = restateHandle!;
    const tempDb: TempDatabaseHandle = createTempDatabase("der-restate-uncertain-");
    cleanups.push(() => tempDb.cleanup());

    const restateListen = await allocateLocalTcpNumber();
    const server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateHost: "127.0.0.1",
        restateListen,
        restateIngressUrl: restate.ingressUrl,
        restateAdminUrl: restate.adminUrl,
        restateMode: "restate",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        enabledEngines: ["fixture"],
        approvalTimeoutMs: 60_000,
        ssePollIntervalMs: 20,
        sseKeepAliveMs: 5_000,
        seedFixture: true,
        scriptGuestArtifactPath: guestArtifactPath,
      },
    });
    cleanups.push(() => server.close());

    await registerRestateDeployment(restate.adminUrl, server.restateUrl!, { force: true });

    const sessionId = server.seededFixture!.session.id;
    const botId = server.seededFixture!.bot.id;

    const admitRes = await fetch(`${server.url}/api/sessions/${sessionId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "uncertain-restate-1",
      },
      body: JSON.stringify({
        input: { parts: [{ type: "text", text: "uncertain:relay-1" }] },
      }),
    });
    expect(admitRes.status).toBe(202);
    const admission = compiledParsers.runAdmission.parse((await admitRes.json()) as RunAdmission);

    const waiting = await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run; approval: Approval | null };
      return body.run.status === "waiting_approval" && body.approval ? body : false;
    });

    const approveRes = await fetch(`${server.url}/api/approvals/${waiting.approval!.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId,
        sessionId,
        runId: admission.run.id,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(approveRes.status).toBe(200);

    const interrupted = await waitUntil(async () => {
      const res = await fetch(`${server.url}/api/runs/${admission.run.id}`);
      const body = (await res.json()) as { run: Run };
      return body.run.status === "interrupted" ? body.run : false;
    });

    expect(interrupted.status).toBe("interrupted");
    expect(
      server.store.getEffect({ ...waiting.approval!.effect, operationKind: "capability" })?.status,
    ).toBe("unknown");
  }, 45_000);
});
