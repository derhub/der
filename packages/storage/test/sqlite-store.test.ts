import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { DomainError, type RunEvent } from "@der/domain";
import {
  canonicalizeJson,
  fingerprintJson,
  openSqliteStore,
  type SqliteStore,
  type StorageMigration,
} from "../src/index";

const tempDirs: string[] = [];

function createTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "der-storage-"));
  tempDirs.push(dir);
  return join(dir, "der.sqlite");
}

function makeFixedClock(iso: string): { now: () => Date; advanceMs: (ms: number) => void } {
  let current = Date.parse(iso);
  return {
    now: () => new Date(current),
    advanceMs: (ms: number) => {
      current += ms;
    },
  };
}

function seedFixture(store: SqliteStore) {
  const bot = store.createBot({
    id: "bot-fixture",
    name: "Fixture Bot",
    persona: "Deterministic test coworker.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture", "codex"],
  });
  const session = store.createSession({
    id: "sess-fixture",
    botId: bot.id,
    title: "Fixture Session",
  });
  const binding = store.upsertChannelBinding({
    id: "bind-fixture",
    integration: "fixture",
    externalChatId: "chat-fixture-1",
    externalActorId: "actor-fixture-1",
    botId: bot.id,
    sessionId: session.id,
    enabled: true,
  });
  return { bot, session, binding };
}

async function expectDomainRejection(
  action: () => Promise<unknown>,
  expected: { readonly status: number; readonly code: string },
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect(caught).toMatchObject(expected);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("configure SQLite WAL, foreign keys, busy timeout, and migration seam", () => {
  it("enables WAL mode, foreign keys, busy timeout, and applies extra migrations idempotently", () => {
    const dbPath = createTempDbPath();
    const extraMigration: StorageMigration = {
      version: "002-memory-seam-test",
      sql: "CREATE TABLE seam_probe (id TEXT PRIMARY KEY);",
    };

    const store = openSqliteStore({
      filename: dbPath,
      busyTimeoutMs: 4200,
      extraMigrations: [extraMigration],
    });

    try {
      expect(store.database.journalMode()).toBe("wal");
      expect(store.database.foreignKeysEnabled()).toBe(true);
      expect(store.database.busyTimeout()).toBe(4200);

      const applied = store.database.db
        .query<{ version: string }, []>(
          "SELECT version FROM schema_migrations ORDER BY version ASC",
        )
        .all();
      expect(applied.map((row) => row.version)).toEqual(["001-core", "002-memory-seam-test"]);
    } finally {
      store.close();
    }

    const reopened = openSqliteStore({
      filename: dbPath,
      extraMigrations: [extraMigration],
    });
    try {
      const applied = reopened.database.db
        .query<{ version: string }, []>(
          "SELECT version FROM schema_migrations ORDER BY version ASC",
        )
        .all();
      expect(applied.map((row) => row.version)).toEqual(["001-core", "002-memory-seam-test"]);
    } finally {
      reopened.close();
    }
  });
});

describe("admit runs with scoped idempotency and single active run", () => {
  it("preserves array order and scalar semantics while normalizing object key order in fingerprints", async () => {
    const first = await fingerprintJson({ b: 1, a: [1, "1", true, "true", null] });
    const reorderedKeys = await fingerprintJson({ a: [1, "1", true, "true", null], b: 1 });
    const reorderedArray = await fingerprintJson({ a: ["1", 1, true, "true", null], b: 1 });
    const changedScalar = await fingerprintJson({ a: [1, 1, true, "true", null], b: 1 });

    expect(first).toBe(reorderedKeys);
    expect(first).not.toBe(reorderedArray);
    expect(first).not.toBe(changedScalar);
    expect(canonicalizeJson({ z: 1, a: [true, "true"] })).toBe('{"a":[true,"true"],"z":1}');
  });

  it("returns the original Run on exact idempotency replay even while the Run is active", async () => {
    const clock = makeFixedClock("2026-11-22T15:00:00Z");
    const store = openSqliteStore({ filename: createTempDbPath(), now: clock.now });
    try {
      const { bot, session } = seedFixture(store);

      const first = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: "req-1",
        input: {
          parts: [
            { type: "data", mimeType: "application/json", data: { b: 2, a: [1, "1"] } },
            { type: "text", text: "Run fixture" },
          ],
        },
        channelIntake: {
          integration: "fixture",
          consumer: "fixture-consumer",
          externalUpdateId: "upd-1",
          nextCursor: "cursor-1",
        },
      });

      expect(first.isDuplicate).toBe(false);
      expect(first.run.status).toBe("queued");
      expect(first.initialMessage.ordinal).toBe(1);
      expect(store.getChannelReceipt("fixture", "fixture-consumer", "upd-1")).toMatchObject({
        disposition: "admitted",
        referenceId: first.run.id,
      });
      expect(store.getChannelCursor("fixture", "fixture-consumer")?.position).toBe("cursor-1");

      const replay = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: "req-1",
        input: {
          parts: [
            { type: "data", mimeType: "application/json", data: { a: [1, "1"], b: 2 } },
            { type: "text", text: "Run fixture" },
          ],
        },
      });

      expect(replay.isDuplicate).toBe(true);
      expect(replay.run.id).toBe(first.run.id);
      expect(replay.initialMessage.id).toBe(first.initialMessage.id);
      expect(store.listMessages(session.id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects idempotency key reuse with changed payload and blocks a second active Run in the same session", async () => {
    const store = openSqliteStore({ filename: createTempDbPath() });
    try {
      const { bot, session } = seedFixture(store);
      const otherSession = store.createSession({
        id: "sess-other",
        botId: bot.id,
        title: "Second Session",
      });

      await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: "req-1",
        input: { parts: [{ type: "text", text: "First payload" }] },
      });

      await expectDomainRejection(
        () =>
          store.admit({
            botId: bot.id,
            sessionId: session.id,
            origin: "http",
            idempotencyKey: "req-1",
            input: { parts: [{ type: "text", text: "Mutated payload" }] },
          }),
        { status: 409, code: "idempotency.conflict" },
      );

      await expectDomainRejection(
        () =>
          store.admit({
            botId: bot.id,
            sessionId: session.id,
            origin: "http",
            idempotencyKey: "req-2",
            input: { parts: [{ type: "text", text: "Competing active run" }] },
          }),
        { status: 409, code: "run.active_conflict" },
      );

      const otherAdmission = await store.admit({
        botId: bot.id,
        sessionId: otherSession.id,
        origin: "http",
        idempotencyKey: "req-1",
        input: { parts: [{ type: "text", text: "Independent session" }] },
      });
      expect(otherAdmission.isDuplicate).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("append bounded run events and replay exclusively after cursor", () => {
  it("batches events, deduplicates replayed chunk keys, and replays strictly after cursor", async () => {
    const store = openSqliteStore({
      filename: createTempDbPath(),
      maxEventBatchSize: 2,
      replayPageSize: 2,
    });
    try {
      const { bot, session } = seedFixture(store);
      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: "req-stream",
        input: { parts: [{ type: "text", text: "Stream chunks" }] },
      });

      const batch = await store.appendRunEvents(run.id, [
        { chunkKey: `${run.id}:1`, chunk: { type: "RUN_STARTED", runId: run.id } },
        { chunkKey: `${run.id}:2`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "hel" } },
        { chunkKey: `${run.id}:3`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "lo" } },
        { chunkKey: `${run.id}:2`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "hel" } },
        {
          chunkKey: `${run.id}:4`,
          chunk: { type: "RUN_FINISHED", runId: run.id },
          isTerminal: true,
        },
      ]);

      expect(batch.map((event) => event.sequence)).toEqual([1, 2, 3, 2, 4]);
      expect(store.getRunStreamState(run.id)).toEqual({
        highWaterMark: 4,
        terminalSequence: 4,
        status: "queued",
      });

      const replayed: RunEvent[] = [];
      for await (const event of store.replay(run.id, 2)) {
        replayed.push(event);
      }
      expect(replayed.map((event) => event.sequence)).toEqual([3, 4]);

      await expectDomainRejection(
        () =>
          store.appendRunEvents(run.id, [
            { chunkKey: `${run.id}:5`, chunk: { type: "TEXT_MESSAGE_CONTENT", delta: "late" } },
          ]),
        { status: 409, code: "run.already_terminal" },
      );
    } finally {
      store.close();
    }
  });
});

describe("persist approvals, transactional outbox rows, and exact-operation effect certainty", () => {
  it("commits approvals and der.approval.requested outbox atomically, enforces scope/expiry/replay, and guards effect authorization", async () => {
    const clock = makeFixedClock("2026-11-22T15:00:00Z");
    const store = openSqliteStore({ filename: createTempDbPath(), now: clock.now });
    try {
      const { bot, session, binding } = seedFixture(store);
      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "http",
        idempotencyKey: "req-appr",
        input: { parts: [{ type: "text", text: "Execute host fixture" }] },
      });

      const effect = {
        runId: run.id,
        operationKind: "fixture" as const,
        operationId: "fixture.write",
        canonicalArguments: { b: 2, a: "value" },
        attemptId: "attempt-1",
      };

      const requested = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect,
        prompt: "Apply fixture write?",
        awakeable: "awk_test_1",
        deadline: "2026-11-22T15:05:00Z",
      });

      expect(requested.isDuplicate).toBe(false);
      expect(requested.approval.decision.status).toBe("pending");
      expect(requested.outboxEvents).toHaveLength(1);
      expect(requested.outboxEvents[0]?.bindingId).toBe(binding.id);
      expect(requested.outboxEvents[0]?.envelope.type).toBe("der.approval.requested");
      expect(store.getRun(run.id)?.status).toBe("waiting_approval");

      const duplicateRequest = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect: { ...effect, canonicalArguments: { a: "value", b: 2 } },
        prompt: "Apply fixture write?",
        awakeable: "awk_test_1",
        deadline: "2026-11-22T15:05:00Z",
      });
      expect(duplicateRequest.isDuplicate).toBe(true);
      expect(duplicateRequest.approval.id).toBe(requested.approval.id);

      await expectDomainRejection(
        () =>
          store.decide({
            approvalId: requested.approval.id,
            botId: bot.id,
            sessionId: "sess-wrong",
            runId: run.id,
            status: "approved",
            actor: "operator",
            decidedAt: "2026-11-22T15:01:00Z",
          }),
        { status: 409, code: "approval.scope_mismatch" },
      );

      clock.advanceMs(60_000);
      const approved = await store.decide({
        approvalId: requested.approval.id,
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        status: "approved",
        actor: "operator",
        decidedAt: "2020-01-01T00:00:00Z",
      });
      expect(approved.decision).toEqual({
        status: "approved",
        actor: "operator",
        decidedAt: "2026-11-22T15:01:00.000Z",
      });

      const replayed = await store.decide({
        approvalId: requested.approval.id,
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        status: "approved",
        actor: "operator",
        decidedAt: "2026-11-22T15:02:00Z",
      });
      expect(replayed.decision).toEqual(approved.decision);

      await expectDomainRejection(
        () =>
          store.decide({
            approvalId: requested.approval.id,
            botId: bot.id,
            sessionId: session.id,
            runId: run.id,
            status: "denied",
            actor: "operator",
            decidedAt: "2026-11-22T15:02:00Z",
          }),
        { status: 409, code: "approval.decision_conflict" },
      );

      await expectDomainRejection(
        () =>
          store.beginEffect(
            { ...effect, canonicalArguments: { a: "tampered", b: 2 } },
            { approvalId: requested.approval.id },
          ),
        { status: 409, code: "effect.authorization_mismatch" },
      );

      const started = await store.beginEffect(
        { ...effect, canonicalArguments: { a: "value", b: 2 } },
        { approvalId: requested.approval.id },
      );
      expect(started.kind).toBe("started");

      const ambiguous = await store.beginEffect(effect, { approvalId: requested.approval.id });
      expect(ambiguous.kind).toBe("ambiguous");

      const completedRecord = await store.completeEffect(started.effect.id, { applied: true });
      expect(completedRecord.status).toBe("completed");
      expect(completedRecord.outcome).toEqual({ applied: true });

      const reused = await store.beginEffect(effect, { approvalId: requested.approval.id });
      expect(reused.kind).toBe("completed");
      expect(reused.effect.outcome).toEqual({ applied: true });
    } finally {
      store.close();
    }
  });

  it("expires a pending approval at deadline and emits der.chat.replied and der.routine.finished outbox rows atomically", async () => {
    const clock = makeFixedClock("2026-11-22T16:00:00Z");
    const store = openSqliteStore({ filename: createTempDbPath(), now: clock.now });
    try {
      const { bot, session, binding } = seedFixture(store);
      const otherSession = store.createSession({
        id: "sess-bot-binding",
        botId: bot.id,
        title: "Second Session",
      });
      const botLevelBinding = store.upsertChannelBinding({
        id: "bind-other-session",
        integration: "fixture",
        externalChatId: "chat-fixture-2",
        externalActorId: "actor-fixture-2",
        botId: bot.id,
        sessionId: otherSession.id,
        enabled: true,
      });
      const routine = store.createRoutine({
        id: "rt-1",
        botId: bot.id,
        sessionId: session.id,
        name: "Hourly fixture check",
        cron: "0 * * * *",
        enabled: true,
        engine: "fixture",
        prompt: "Check system state",
      });

      const { run } = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "routine",
        idempotencyKey: "rt-1:2026-11-22T16:00:00Z",
        routineId: routine.id,
        routineSlot: "2026-11-22T16:00:00Z",
        input: { parts: [{ type: "text", text: "Check system state" }] },
      });

      const requested = await store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect: {
          runId: run.id,
          operationKind: "fixture",
          operationId: "fixture.expire",
          canonicalArguments: { step: 1 },
          attemptId: "attempt-1",
        },
        prompt: "Approve before timeout?",
        awakeable: "awk_expire_1",
        deadline: "2026-11-22T16:01:00Z",
      });

      clock.advanceMs(2 * 60_000);
      let expiredError: unknown;
      try {
        await store.decide({
          approvalId: requested.approval.id,
          botId: bot.id,
          sessionId: session.id,
          runId: run.id,
          status: "approved",
          actor: "operator",
          decidedAt: "2026-11-22T16:00:30Z",
        });
      } catch (error) {
        expiredError = error;
      }
      expect(expiredError).toBeInstanceOf(DomainError);
      expect(expiredError).toMatchObject({ status: 409, code: "approval.expired" });
      expect(store.getApproval(requested.approval.id)?.decision.status).toBe("expired");

      const finished = await store.finishRun({
        runId: run.id,
        status: "completed",
        terminalEvent: {
          chunkKey: `${run.id}:terminal`,
          chunk: { type: "RUN_FINISHED", runId: run.id },
        },
        finalMessageParts: [{ type: "text", text: "Completed after expiry." }],
        detail: "Routine finished cleanly.",
      });

      expect(finished.run.status).toBe("completed");
      expect(finished.finalMessage?.ordinal).toBe(2);
      const chatOutbox = finished.outboxEvents.filter(
        (event) => event.envelope.type === "der.chat.replied",
      );
      const routineOutbox = finished.outboxEvents.filter(
        (event) => event.envelope.type === "der.routine.finished",
      );
      expect(chatOutbox.map((event) => event.bindingId)).toEqual([binding.id]);
      expect(routineOutbox.map((event) => event.bindingId)).toEqual([
        binding.id,
        botLevelBinding.id,
      ]);

      const firstOutbox = chatOutbox[0];
      expect(firstOutbox).toBeDefined();
      if (firstOutbox) {
        const retrying = await store.recordOutboxDelivery(firstOutbox.id, {
          status: "retryable",
          retryAfterMs: 10_000,
          detail: "Temporary timeout",
        });
        expect(retrying.state).toBe("retrying");
        expect(retrying.attempts).toBe(1);
        expect(store.listDueOutboxEvents("2026-11-22T16:02:05Z").map((e) => e.id)).not.toContain(
          firstOutbox.id,
        );
        expect(store.listDueOutboxEvents("2026-11-22T16:02:15Z").map((e) => e.id)).toContain(
          firstOutbox.id,
        );

        const delivered = await store.recordOutboxDelivery(firstOutbox.id, {
          status: "delivered",
          externalMessageId: "ext-msg-1",
          deliveredAt: "2026-11-22T16:02:15Z",
        });
        expect(delivered.state).toBe("delivered");
        expect(delivered.attempts).toBe(2);
      }
    } finally {
      store.close();
    }
  });
});
