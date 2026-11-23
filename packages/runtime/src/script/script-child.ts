import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Wasmer } from "@wasmer/sdk/node";
import { QUICKJS_GUEST_PIN } from "./guest-pin";
import { buildGuestProgram } from "./guest-prelude";

interface ChildInit {
  readonly script: string;
  readonly seed: number;
  readonly now: number;
  readonly guestArtifactPath?: string;
}

class GuestStartError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
}

async function readVerifiedGuest(path: string): Promise<Uint8Array> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new GuestStartError(
      "script.guest_missing",
      `QuickJS guest artifact "${path}" is missing or unreadable; registry fallback is disabled.`,
      { cause: error },
    );
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== QUICKJS_GUEST_PIN.digest) {
    throw new GuestStartError(
      "script.guest_digest_mismatch",
      `QuickJS guest artifact "${path}" digest mismatch: expected ${QUICKJS_GUEST_PIN.digest}, got ${actual}; registry fallback is disabled.`,
    );
  }
  return bytes;
}

function emit(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function run(): Promise<void> {
  const lines = readLines(Bun.stdin.stream());
  const first = await lines.next();
  if (first.done) {
    return;
  }
  const init = (JSON.parse(first.value) as { init: ChildInit }).init;
  const artifactPath = init.guestArtifactPath ?? QUICKJS_GUEST_PIN.artifactPath;
  const bytes = await readVerifiedGuest(artifactPath);

  const client = await Wasmer.create({
    cache: { directory: join(dirname(artifactPath), "cache") },
  });
  const pkg = await client.packages.load(bytes);
  const sandbox = await client.sandboxes.create({
    packages: [pkg],
    network: { mode: "disabled" },
    env: {},
  });
  await sandbox.fs.writeText("/workspace/guest.mjs", buildGuestProgram(init));
  const guest = await sandbox
    .command(pkg.command(QUICKJS_GUEST_PIN.commandName), ["/workspace/guest.mjs"])
    .spawn({ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  emit({ ready: true });

  void (async () => {
    for await (const line of guest.stderr!.lines()) {
      process.stderr.write(`${line}\n`);
    }
  })();
  void (async () => {
    for await (const line of lines) {
      await guest.stdin!.write(`${line}\n`);
    }
    await guest.stdin!.close();
  })();
  for await (const line of guest.stdout!.lines()) {
    process.stdout.write(`${line}\n`);
  }
  await guest.wait({ check: false });
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const code = error instanceof GuestStartError ? error.code : "script.guest_start_failed";
  emit({
    fatal: { code, message: error instanceof Error ? error.message : String(error) },
  });
  process.exit(1);
}
