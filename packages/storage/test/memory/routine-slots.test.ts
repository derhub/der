import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@der/domain";
import { openSqliteStore } from "@der/storage";
import { MEMORY_ROUTINE_SLOTS_MIGRATION } from "@der/storage/memory";
import { openSqliteRoutines } from "@der/storage/routines";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Routine revisions and UTC slot deduplication storage", () => {
  it("bumps revision on routine updates and enforces bot/session scope", async () => {
    const dir = createTempDir("der-routines-rev-");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 5, 1, 12, 0, tick++));
    const store = openSqliteStore({
      filename: join(dir, "der.sqlite"),
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
      now,
    });
    const routines = openSqliteRoutines({ database: store.database });

    try {
      const bot = store.createBot({
        id: "bot-rt",
        name: "Routine Bot",
        persona: "Runs checks",
        defaultEngine: "fixture",
        allowedEngines: ["fixture", "codex"],
      });
      const session = store.createSession({
        id: "sess-rt",
        botId: bot.id,
        title: "Routine Session",
      });

      const created = await routines.createRoutine({
        id: "rt-1",
        botId: bot.id,
        sessionId: session.id,
        name: "Health digest",
        cron: "*/5 * * * *",
        enabled: true,
        engine: "fixture",
        prompt: "direct:digest",
      });
      expect(created.revision).toBe(1);
      expect(routines.listRoutines(bot.id)).toEqual([created]);

      const updated = await routines.updateRoutine(created.id, {
        cron: "*/10 * * * *",
        prompt: "direct:updated-digest",
        expectedRevision: 1,
      });
      expect(updated.revision).toBe(2);
      expect(updated.cron).toBe("*/10 * * * *");
      expect(updated.prompt).toBe("direct:updated-digest");

      let staleErr: unknown;
      try {
        await routines.updateRoutine(created.id, {
          enabled: false,
          expectedRevision: 1,
        });
      } catch (error) {
        staleErr = error;
      }
      expect(staleErr).toBeInstanceOf(DomainError);
      expect((staleErr as DomainError).status).toBe(409);
      expect((staleErr as DomainError).code).toBe("routine.revision_conflict");
    } finally {
      store.close();
    }
  });

  it("deduplicates UTC slots per routine, tracks latest slot, and reports active session runs", async () => {
    const dir = createTempDir("der-routines-slots-");
    const store = openSqliteStore({
      filename: join(dir, "der.sqlite"),
      extraMigrations: [MEMORY_ROUTINE_SLOTS_MIGRATION],
    });
    const routines = openSqliteRoutines({ database: store.database });

    try {
      const bot = store.createBot({
        id: "bot-slots",
        name: "Slot Bot",
        persona: "P",
        defaultEngine: "fixture",
        allowedEngines: ["fixture"],
      });
      const session = store.createSession({
        id: "sess-slots",
        botId: bot.id,
        title: "Slot Session",
      });
      const routine = await routines.createRoutine({
        id: "rt-slots",
        botId: bot.id,
        sessionId: session.id,
        name: "Slot check",
        cron: "*/5 * * * *",
        enabled: true,
        engine: "fixture",
        prompt: "direct:slot",
      });

      expect(routines.hasActiveRun(session.id)).toBe(false);

      const admission = await store.admit({
        botId: bot.id,
        sessionId: session.id,
        origin: "routine",
        idempotencyKey: "routine:rt-slots:2026-06-01T12:00:00.000Z",
        engine: "fixture",
        input: { parts: [{ type: "text", text: "direct:slot" }] },
        routineId: routine.id,
        routineSlot: "2026-06-01T12:00:00.000Z",
      });
      expect(routines.hasActiveRun(session.id)).toBe(true);

      const first = await routines.recordSlot({
        routineId: routine.id,
        slot: "2026-06-01T12:00:00.000Z",
        revision: 1,
        disposition: "admitted",
        runId: admission.run.id,
      });
      expect(first.inserted).toBe(true);
      expect(first.slot.disposition).toBe("admitted");
      expect(first.slot.runId).toBe(admission.run.id);

      const duplicate = await routines.recordSlot({
        routineId: routine.id,
        slot: "2026-06-01T12:00:00.000Z",
        revision: 2,
        disposition: "skipped_active_run",
        runId: null,
      });
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.slot).toEqual(first.slot);

      const skipped = await routines.recordSlot({
        routineId: routine.id,
        slot: "2026-06-01T12:05:00.000Z",
        revision: 1,
        disposition: "skipped_active_run",
        runId: null,
      });
      expect(skipped.inserted).toBe(true);
      expect(routines.getLatestSlot(routine.id)).toEqual(skipped.slot);
      expect(routines.listSlots(routine.id)).toEqual([first.slot, skipped.slot]);

      const completedSlot = await routines.updateSlotDisposition(
        routine.id,
        "2026-06-01T12:00:00.000Z",
        "completed",
      );
      expect(completedSlot.disposition).toBe("completed");
      expect(completedSlot.runId).toBe(admission.run.id);
    } finally {
      store.close();
    }
  });
});
