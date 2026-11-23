import * as z from "zod";
import { CapabilityCatalog, defineCapability, type Capability, type Run } from "@der/domain";
import { createFixtureCapabilities, type FixtureCall } from "#capabilities/fixture";
import type { RunningServer } from "#main";

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
  const { scriptRun } = await server.scriptRunStore.acquire({
    runId: owner.run.id,
    botId: owner.botId,
    source,
  });
  await server.scriptRuns!.submit(scriptRun.id);
  return scriptRun;
}
