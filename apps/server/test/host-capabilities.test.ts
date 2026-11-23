import { afterEach, describe, expect, it } from "bun:test";
import {
  CapabilityCatalog,
  DomainError,
  type Engine,
  type Sandbox,
  type SandboxResult,
} from "@der/domain";
import type { SkillCatalog } from "@der/runtime/context";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { openSqliteMemory } from "@der/storage/memory";
import { openSqliteRoutines } from "@der/storage/routines";
import { parseServerConfig } from "#config";
import { createHostCapabilities } from "#capabilities/index";
import { createHttpApp } from "#http/index";
import { createDirectRoutineScheduleClient } from "#workflows/index";

const NOW = new Date("2026-11-23T00:00:00.000Z");

const fixtureEngine: Engine = {
  kind: "fixture",
  run: async function* () {},
  diagnose: async () => ({
    engine: "fixture",
    interactive: "ready",
    unattended: "ready",
    isolationVerified: true,
    reasons: [],
  }),
};

const skills: SkillCatalog = {
  loadCatalog: async () => ({
    skills: [
      {
        id: "ops-brief",
        name: "ops-brief",
        description: "Summarize alerts.",
        relativePath: "ops-brief/SKILL.md",
      },
    ],
    rejected: [],
  }),
  listSkills: async () => [
    {
      id: "ops-brief",
      name: "ops-brief",
      description: "Summarize alerts.",
      relativePath: "ops-brief/SKILL.md",
    },
  ],
  readSkillBody: async () => "Read open alerts.",
} as unknown as SkillCatalog;

const sandboxResult: SandboxResult = {
  exitCode: 0,
  stdout: "hi\n",
  stderr: "",
  timedOut: false,
  durationMs: 3,
};
const sandbox: Sandbox = { execute: async () => sandboxResult };

const stores: SqliteStore[] = [];

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

function setup() {
  const store = openSqliteStore({ filename: ":memory:" });
  stores.push(store);
  const memory = openSqliteMemory({ database: store.database });
  const routines = openSqliteRoutines({ database: store.database });
  const engines = new Map([["fixture" as const, fixtureEngine]]);
  const routineSchedule = createDirectRoutineScheduleClient({
    routines,
    engines,
    now: () => NOW,
    admitRun: async () => {
      throw new Error("no run admitted in this test");
    },
  });

  for (const name of ["a", "b"]) {
    store.createBot({
      id: `bot-${name}`,
      name: `Bot ${name}`,
      persona: "Concise",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
    });
    store.createSession({ id: `sess-${name}`, botId: `bot-${name}`, title: `Session ${name}` });
  }

  const catalog = new CapabilityCatalog();
  for (const capability of createHostCapabilities({
    bots: store,
    sessions: store,
    memory,
    routines,
    routineSchedule,
    skills,
    sandboxes: { docker: sandbox, wasmer: sandbox },
  })) {
    catalog.add(capability);
  }

  const app = createHttpApp({
    bots: store,
    sessions: store,
    runs: store,
    approvals: store,
    memory,
    routines,
    skills,
    catalog,
    workflow: {
      admit: async () => {
        throw new Error("not used");
      },
      decide: async () => {
        throw new Error("not used");
      },
    },
    routineSchedule,
    engines,
    config: parseServerConfig({ allowedOrigins: ["http://127.0.0.1:5173"] }),
    now: () => NOW,
  });

  return { store, catalog, app };
}

describe("bot scope of host capabilities", () => {
  it("scope: memory.read returns the calling bot's memory and rejects an input naming another bot", async () => {
    const { catalog } = setup();
    await catalog.invoke("memory.write", { markdown: "alpha notes" }, { botId: "bot-a" });
    await catalog.invoke("memory.write", { markdown: "beta notes" }, { botId: "bot-b" });

    const read = (await catalog.invoke("memory.read", {}, { botId: "bot-a" })) as {
      memory: { botId: string; markdown: string; version: number };
    };
    expect({
      botId: read.memory.botId,
      markdown: read.memory.markdown,
      version: read.memory.version,
    }).toEqual({ botId: "bot-a", markdown: "alpha notes", version: 1 });

    await expect(
      catalog.invoke("memory.read", { botId: "bot-b" }, { botId: "bot-a" }),
    ).rejects.toThrow();
  });

  it("scope: sessions.messages and sessions.list never reach another bot's sessions", async () => {
    const { catalog } = setup();

    const listed = (await catalog.invoke("sessions.list", {}, { botId: "bot-a" })) as {
      sessions: { id: string }[];
    };
    expect(listed.sessions.map((entry) => entry.id)).toEqual(["sess-a"]);

    const error = await catalog
      .invoke("sessions.messages", { sessionId: "sess-b" }, { botId: "bot-a" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("session.not_found");
  });

  it("scope: routines.create refuses another bot's session and routines.update refuses another bot's routine", async () => {
    const { catalog } = setup();
    const created = (await catalog.invoke(
      "routines.create",
      { sessionId: "sess-b", name: "Beta", cron: "0 9 * * *", prompt: "Check" },
      { botId: "bot-b" },
    )) as { routine: { id: string } };

    const crossSession = await catalog
      .invoke(
        "routines.create",
        { sessionId: "sess-b", name: "Hijack", cron: "0 9 * * *", prompt: "Check" },
        { botId: "bot-a" },
      )
      .catch((caught: unknown) => caught);
    expect((crossSession as DomainError).code).toBe("session.not_found");

    const crossUpdate = await catalog
      .invoke(
        "routines.update",
        { routineId: created.routine.id, enabled: false },
        { botId: "bot-a" },
      )
      .catch((caught: unknown) => caught);
    expect((crossUpdate as DomainError).code).toBe("routine.not_found");
  });

  it("scope: a call that carries no bot is refused", async () => {
    const { catalog } = setup();
    const error = await catalog.invoke("memory.read", {}, {}).catch((caught: unknown) => caught);
    expect((error as DomainError).code).toBe("capability.bot_scope_missing");
  });
});

describe("excluded surface of host capabilities", () => {
  it("excluded: ids and policies are exactly the host set with no bot lifecycle or approval decision", () => {
    const { catalog } = setup();
    expect(
      catalog.list().map((entry) => `${entry.id} ${entry.effect} ${entry.requiresApproval}`),
    ).toEqual([
      "memory.read read false",
      "memory.write write true",
      "routines.create write true",
      "routines.list read false",
      "routines.update write true",
      "sandbox.docker write true",
      "sandbox.wasmer write true",
      "sessions.list read false",
      "sessions.messages read false",
      "skills.list read false",
      "skills.read read false",
    ]);
  });

  it("excluded: sandbox.docker returns the sandbox result unchanged", async () => {
    const { catalog } = setup();
    const result = await catalog.invoke(
      "sandbox.docker",
      { command: "echo", args: ["hi"], timeoutMs: 1000, network: "none" },
      { botId: "bot-a" },
    );
    expect(result).toEqual(sandboxResult);
  });
});

describe("routines capabilities share the HTTP port", () => {
  it("routines: a routine created and then updated through the catalog is listed by GET /api/bots/:botId/routines", async () => {
    const { catalog, app } = setup();
    const created = (await catalog.invoke(
      "routines.create",
      { sessionId: "sess-a", name: "Daily", cron: "0 9 * * *", prompt: "Check status" },
      { botId: "bot-a" },
    )) as { routine: { id: string; engine: string; enabled: boolean } };
    expect(created.routine.engine).toBe("fixture");

    await catalog.invoke(
      "routines.update",
      { routineId: created.routine.id, name: "Morning" },
      { botId: "bot-a" },
    );

    const res = await app.fetch(new Request("http://localhost/api/bots/bot-a/routines"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      routines: { id: string; botId: string; sessionId: string; name: string; cron: string }[];
    };
    expect(
      body.routines.map(({ id, botId, sessionId, name, cron }) => ({
        id,
        botId,
        sessionId,
        name,
        cron,
      })),
    ).toEqual([
      {
        id: created.routine.id,
        botId: "bot-a",
        sessionId: "sess-a",
        name: "Morning",
        cron: "0 9 * * *",
      },
    ]);

    const listed = (await catalog.invoke("routines.list", {}, { botId: "bot-b" })) as {
      routines: unknown[];
    };
    expect(listed.routines).toEqual([]);
  });
});
