import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { CapabilityCatalog, defineCapability, type Capability, type Run } from "@der/domain";
import { createFixtureCapabilities, type FixtureCall } from "../../src/capabilities/fixture";
import type { RunningServer } from "../../src/main";

const GUEST_DIGEST = "sha256:0795ae56bbe46ac61429c42ade4f8ad69b393ff6b88f372f8298cff233d03d2c";

function sha256Of(path: string): string | undefined {
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    return undefined;
  }
}

export async function ensureScriptGuest(): Promise<string> {
  const dir = join(tmpdir(), "der-script-guests");
  const path = join(dir, "quickjs-0.15.1.webc");
  if (sha256Of(path) === GUEST_DIGEST) {
    return path;
  }
  const response = await fetch(
    `https://cdn.wasmer.io/webcimages/${GUEST_DIGEST.slice("sha256:".length)}.webc`,
  );
  if (!response.ok) {
    throw new Error(`guest download failed: HTTP ${response.status}`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  if (sha256Of(path) !== GUEST_DIGEST) {
    throw new Error("downloaded guest does not match the pinned digest");
  }
  return path;
}

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
