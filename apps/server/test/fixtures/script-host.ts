import * as z from "zod";
import {
  CapabilityCatalog,
  defineCapability,
  formatUtcTimestamp,
  type Approval,
  type Capability,
  type Run,
} from "@der/domain";
import { createFixtureCapabilities, type FixtureCall } from "#capabilities/fixture";
import type { RunningServer } from "#main";
import { openSqliteScriptStore, openSqliteStore } from "@der/storage";
import { ScriptDriver, type ScriptDriverDeps } from "#scripts/script-driver";
import { createTempDatabase } from "./restate-harness";

export interface NoteHost {
  readonly catalog: CapabilityCatalog;
  readonly reads: string[];
  readonly appended: string[];
  readonly published: string[];
}

export function createNoteHost(): NoteHost {
  const reads: string[] = [];
  const appended: string[] = [];
  const published: string[] = [];
  const text = z.object({ text: z.string() });
  const capabilities: Capability[] = [
    defineCapability({
      id: "notes.read",
      description: "Read a note",
      input: z.object({ key: z.string() }),
      output: z.object({ value: z.string() }),
      effect: "read",
      approval: "none",
      async execute({ key }) {
        reads.push(key);
        return { value: `value-${key}` };
      },
    }),
    defineCapability({
      id: "notes.append",
      description: "Append a note",
      input: text,
      output: z.object({ count: z.number() }),
      effect: "write",
      approval: "none",
      async execute(input) {
        appended.push(input.text);
        return { count: appended.length };
      },
    }),
    defineCapability({
      id: "notes.publish",
      description: "Publish a note",
      input: text,
      output: z.object({ published: z.boolean() }),
      effect: "write",
      approval: "always",
      async execute(input) {
        published.push(input.text);
        return { published: true };
      },
    }),
  ] as Capability[];

  const catalog = new CapabilityCatalog();
  for (const capability of capabilities) {
    catalog.add(capability);
  }
  return { catalog, reads, appended, published };
}

export interface FixtureHost {
  readonly catalog: CapabilityCatalog;
  readonly applied: FixtureCall[];
}

export function createFixtureHost(): FixtureHost {
  const { capabilities, applied } = createFixtureCapabilities();
  const catalog = new CapabilityCatalog();
  for (const capability of capabilities) {
    catalog.add(capability);
  }
  return { catalog, applied };
}

export async function admitOwningRun(
  server: RunningServer,
  idempotencyKey: string,
): Promise<{ readonly run: Run; readonly botId: string; readonly sessionId: string }> {
  const botId = server.seededFixture!.bot.id;
  const sessionId = server.seededFixture!.session.id;
  const { run } = await server.store.admit({
    botId,
    sessionId,
    origin: "http",
    idempotencyKey,
    input: { parts: [{ type: "text", text: "script owner" }] },
  });
  return { run, botId, sessionId };
}

export async function submitScript(
  server: RunningServer,
  owner: { readonly run: Run; readonly botId: string },
  source: string,
) {
  const scriptRun = server.scriptRunStore.acquire({
    runId: owner.run.id,
    botId: owner.botId,
    source,
    seed: 1,
  });
  await server.scriptDriver.kick(scriptRun.id);
  return scriptRun;
}

export async function openScriptFixture() {
  const database = createTempDatabase("der-script-driver-");
  const host = createNoteHost();
  let time = Date.parse("2026-11-24T01:00:00Z");
  const now = () => new Date(time);
  const open = () => openSqliteStore({ filename: database.dbPath, now });
  const store = open();
  const bot = store.createBot({
    id: "bot-script",
    name: "Script",
    persona: "Test bot",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
  });
  const session = store.createSession({ id: "session-script", botId: bot.id, title: "Script" });
  const { run } = await store.admit({
    botId: bot.id,
    sessionId: session.id,
    origin: "http",
    idempotencyKey: "script-driver",
    input: { parts: [{ type: "text", text: "script" }] },
  });
  const openDriver = (
    databaseStore = store,
    limits?: Partial<ScriptDriverDeps["limits"]>,
    options: Pick<ScriptDriverDeps, "writeCancelGraceMs"> = {},
  ) => {
    const scripts = openSqliteScriptStore({ database: databaseStore.database });
    const driver = new ScriptDriver({
      store: databaseStore,
      scripts,
      bots: databaseStore,
      catalog: host.catalog,
      limits: {
        memoryBytes: 64 * 1024 * 1024,
        activeMs: 5_000,
        maxAll: 1000,
        maxInFlight: 2000,
        maxSteps: 2000,
        outputBytes: 1024 * 1024,
        ...limits,
      },
      approvalTimeoutMs: 5_000,
      sweepIntervalMs: 1000,
      now,
      ...options,
    });
    const acquire = (source: string) =>
      scripts.acquire({ runId: run.id, botId: bot.id, source, seed: 1 });
    return { scripts, driver, acquire };
  };
  const decide = (approval: Approval, status: "approved" | "denied") => ({
    approvalId: approval.id,
    botId: bot.id,
    sessionId: session.id,
    runId: run.id,
    status,
    actor: "operator",
    decidedAt: formatUtcTimestamp(now()),
  });
  return {
    database,
    host,
    store,
    run,
    open,
    openDriver,
    decide,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
