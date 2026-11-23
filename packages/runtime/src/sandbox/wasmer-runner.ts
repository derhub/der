import { compiledParsers } from "@der/domain/compiled";
import { createSdkWasmerDriver, createWasmerSandbox, WASMER_RUNNER_CONTRACT } from "./index";

async function readRequestPayload(): Promise<string> {
  const flagIndex = process.argv.indexOf("--request-json");
  if (flagIndex !== -1 && process.argv[flagIndex + 1] !== undefined) {
    return process.argv[flagIndex + 1]!;
  }
  return new Response(Bun.stdin.stream()).text();
}

function resolveAllowedRoots(): readonly string[] {
  const raw = process.env["DER_WASMER_ALLOWED_ROOTS"];
  if (!raw || raw.trim().length === 0) {
    return ["/work"];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main(): Promise<void> {
  const rawInput = (await readRequestPayload()).trim();
  if (rawInput.length === 0) {
    throw new Error("Wasmer runner requires a SandboxRequest JSON payload on stdin.");
  }

  const request = compiledParsers.sandboxRequest.parse(JSON.parse(rawInput));
  const driver = createSdkWasmerDriver({
    cacheDirectory: `${WASMER_RUNNER_CONTRACT.guestRoot}/cache`,
  });

  const sandbox = createWasmerSandbox({
    driver,
    guestPins: WASMER_RUNNER_CONTRACT.guests,
    allowedHostRoots: resolveAllowedRoots(),
  });

  const result = await sandbox.execute(request);
  if (sandbox.activeSandboxCount() !== 0) {
    throw new Error(`Wasmer sandbox leaked ${sandbox.activeSandboxCount()} active instance(s).`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  });
}
