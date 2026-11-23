import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { ExecuteResult } from "@der/domain";
import { openSqliteScriptRuns, openSqliteStore, type SqliteStore } from "../src/index";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function openFixture() {
  const dir = mkdtempSync(join(tmpdir(), "der-script-runs-"));
  tempDirs.push(dir);
  const store: SqliteStore = openSqliteStore({ filename: join(dir, "der.sqlite") });
  const bot = store.createBot({
    id: "bot-1",
    name: "Bot",
    persona: "Test bot.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({ id: "sess-1", botId: bot.id, title: "Session" });
  const { run } = await store.admit({
    botId: bot.id,
    sessionId: session.id,
    origin: "web",
    idempotencyKey: "req-1",
    input: { parts: [{ type: "text", text: "go" }] },
  });
  const scriptRuns = openSqliteScriptRuns({ database: store.database });
  return { store, scriptRuns, bot, session, run };
}

const done: ExecuteResult = { ok: true, result: 3, logs: ["a"], truncated: false };

describe("acquire a script run", () => {
  it("creates occurrence 1 in running status with the source digest", async () => {
    const { scriptRuns, run, bot } = await openFixture();

    const { scriptRun, created } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    expect(created).toBe(true);
    expect(scriptRun).toEqual({
      id: scriptRun.id,
      runId: run.id,
      botId: bot.id,
      digest: "486d9affb60dbb0063b03d8e23a6ccf6364ce203dc3a9f56f20e750eb41ecade",
      occurrence: 1,
      source: "return 1",
      status: "running",
      result: null,
      deliveredAt: null,
    });
    expect(scriptRun.id).toMatch(/^sr_/);
  });

  it("returns the same undelivered script run for the same source in the same run", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const first = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    const second = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    expect(second.created).toBe(false);
    expect(second.scriptRun.id).toBe(first.scriptRun.id);
  });

  it("creates occurrence 2 once the first result was delivered", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const first = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });
    await scriptRuns.finish(first.scriptRun.id, "completed", done);
    await scriptRuns.markDelivered(first.scriptRun.id);

    const second = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    expect(second.created).toBe(true);
    expect(second.scriptRun.occurrence).toBe(2);
    expect(second.scriptRun.id).not.toBe(first.scriptRun.id);
  });

  it("keeps different sources apart", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const one = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 1" });

    const two = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "return 2" });

    expect(two.created).toBe(true);
    expect(two.scriptRun.digest).not.toBe(one.scriptRun.digest);
    expect(two.scriptRun.occurrence).toBe(1);
  });
});

describe("finish a script run", () => {
  it("stores the result and keeps the first terminal outcome", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    await scriptRuns.finish(scriptRun.id, "completed", done);
    const second = await scriptRuns.finish(scriptRun.id, "failed", {
      ok: false,
      error: { kind: "script", message: "late" },
      logs: [],
    });

    expect(second.status).toBe("completed");
    expect(second.result).toEqual(done);
    expect(scriptRuns.get(scriptRun.id)?.result).toEqual(done);
  });

  it("does not mark a running script run delivered", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });

    const marked = await scriptRuns.markDelivered(scriptRun.id);

    expect(marked.deliveredAt).toBeNull();
  });

  it("lists only unfinished script runs of the owning run", async () => {
    const { scriptRuns, run, bot } = await openFixture();
    const open = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "a" });
    const closed = await scriptRuns.acquire({ runId: run.id, botId: bot.id, source: "b" });
    await scriptRuns.finish(closed.scriptRun.id, "cancelled", {
      ok: false,
      error: { kind: "cancelled", message: "x" },
      logs: [],
    });
    await scriptRuns.setStatus(open.scriptRun.id, "waiting_approval");

    expect(scriptRuns.listUnfinished(run.id).map((entry) => [entry.id, entry.status])).toEqual([
      [open.scriptRun.id, "waiting_approval"],
    ]);
  });
});

describe("pending approvals of a script run", () => {
  it("returns only approvals whose attempt belongs to the script run", async () => {
    const { store, scriptRuns, run, bot, session } = await openFixture();
    const { scriptRun } = await scriptRuns.acquire({
      runId: run.id,
      botId: bot.id,
      source: "return 1",
    });
    const request = (attemptId: string, operationId: string) =>
      store.requestApproval({
        botId: bot.id,
        sessionId: session.id,
        runId: run.id,
        effect: {
          runId: run.id,
          operationKind: "capability",
          operationId,
          canonicalArguments: {},
          attemptId,
        },
        prompt: "ok?",
        awakeable: `awk-${attemptId}`,
        deadline: "2099-01-01T00:00:00.000Z",
      });
    const mine = await request(`${scriptRun.id}:1`, "notes.append");
    await request("sr_other:1", "notes.append");

    expect(scriptRuns.listPendingApprovals(scriptRun.id).map((entry) => entry.id)).toEqual([
      mine.approval.id,
    ]);
  });
});
