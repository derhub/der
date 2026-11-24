import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExecuteResult, UtcTimestamp } from "@der/domain";
import { formatUtcTimestamp } from "@der/domain";
import { openSqliteScriptStore, openSqliteStore } from "@der/storage";
import { scriptStoreContract, type ScriptStoreHarness } from "./script-store-contract";

async function openSqliteHarness(): Promise<ScriptStoreHarness> {
  return (await openSqliteFixture()).harness;
}

async function openSqliteFixture() {
  const dir = mkdtempSync(join(tmpdir(), "der-script-store-"));
  const filename = join(dir, "der.sqlite");
  let nowMs = Date.parse("2026-11-24T10:00:00.000Z");
  const now = () => new Date(nowMs);
  const opened = [] as { close(): void }[];
  const open = () => {
    const store = openSqliteStore({ filename, now });
    opened.push(store);
    return store;
  };

  const base = open();
  const bot = base.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "Test bot.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = base.createSession({ id: "sess-1", botId: bot.id, title: "Session" });
  let runs = 0;

  const harness: ScriptStoreHarness = {
    store: openSqliteScriptStore({ database: base.database }),
    reopen: () => {
      base.close();
      return openSqliteScriptStore({ database: open().database });
    },
    async newRun() {
      runs += 1;
      const { run } = await base.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "web",
        idempotencyKey: `req-${runs}`,
        input: { parts: [{ type: "text", text: "go" }] },
      });
      return { runId: run.id, botId: bot.id };
    },
    advance(ms) {
      nowMs += ms;
    },
    now: (): UtcTimestamp => formatUtcTimestamp(now()),
    dispose() {
      for (const store of opened) {
        try {
          store.close();
        } catch {
          // already closed by reopen
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return { harness, base, session };
}

describe("SQLite script store", () => {
  scriptStoreContract(openSqliteHarness);
});

describe("SQLite script store events and Approvals", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
  });

  async function startExecution() {
    const fixture = await openSqliteFixture();
    disposers.push(() => fixture.harness.dispose());
    const { runId, botId } = await fixture.harness.newRun();
    const execution = fixture.harness.store.acquire({ runId, botId, source: "return 1", seed: 1 });
    const events = () =>
      fixture.base.database.db
        .query<{ session_id: string; kind: string; state: string; payload_json: string }, []>(
          "SELECT session_id, kind, state, payload_json FROM session_events",
        )
        .all();
    return { ...fixture, runId, botId, execution, events };
  }

  const finished: ExecuteResult = { ok: true, result: 3, logs: [], truncated: false };

  it("inserts one script.finished event when a detached execution finishes, and none for a repeated finish", async () => {
    const { harness, execution, events, session } = await startExecution();
    harness.store.detach(execution.id);

    harness.store.finish(execution.id, { status: "completed", result: finished });
    harness.store.finish(execution.id, { status: "failed", result: finished });

    expect(events().map((row) => ({ ...row, payload_json: JSON.parse(row.payload_json) }))).toEqual(
      [
        {
          session_id: session.id,
          kind: "script.finished",
          state: "pending",
          payload_json: {
            event: "script.finished",
            executionId: execution.id,
            status: "completed",
            result: finished,
          },
        },
      ],
    );
  });

  it("inserts no event when an execution that was never detached finishes", async () => {
    const { harness, execution, events } = await startExecution();

    harness.store.finish(execution.id, { status: "completed", result: finished });

    expect(events()).toEqual([]);
  });

  it("leaves the Run status unchanged when an Approval is requested for a detached execution", async () => {
    const { harness, base, execution, runId, botId, session } = await startExecution();
    harness.store.detach(execution.id);
    const before = base.getRun(runId)?.status;

    await base.requestApproval({
      id: "appr-detached",
      botId,
      sessionId: session.id,
      runId,
      effect: {
        runId,
        operationKind: "capability",
        operationId: "notes.publish",
        canonicalArguments: { text: "x" },
        attemptId: `${execution.id}:1`,
      },
      awakeable: `script:${execution.id}`,
      prompt: "publish",
      deadline: "2026-11-24T11:00:00.000Z",
    });

    expect([before, base.getRun(runId)?.status]).toEqual(["queued", "queued"]);
  });

  it("returns an attended Run to running when its execution detaches while an Approval waits", async () => {
    const { harness, base, execution, runId, botId, session } = await startExecution();
    await base.requestApproval({
      id: "appr-attended",
      botId,
      sessionId: session.id,
      runId,
      effect: {
        runId,
        operationKind: "capability",
        operationId: "notes.publish",
        canonicalArguments: { text: "x" },
        attemptId: `${execution.id}:1`,
      },
      awakeable: `script:${execution.id}`,
      prompt: "publish",
      deadline: "2026-11-24T11:00:00.000Z",
    });
    const waiting = base.getRun(runId)?.status;

    harness.store.detach(execution.id);

    expect([waiting, base.getRun(runId)?.status]).toEqual(["waiting_approval", "running"]);
  });
});
