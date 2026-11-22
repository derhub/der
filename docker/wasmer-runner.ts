import { compiledParsers } from "../packages/domain/src/compiled/index";
import {
  createSdkWasmerDriver,
  createWasmerSandbox,
  WASMER_RUNNER_CONTRACT,
  type WasmerDriver,
  type WasmerGuestKind,
  type WasmerGuestPin,
} from "../packages/runtime/src/sandbox/index";

const VERIFIED_GUEST_PINS: Readonly<Record<WasmerGuestKind, WasmerGuestPin>> = {
  bash: {
    guest: "bash",
    packageRef: "wasmer/bash@1.0.25",
    version: "1.0.25",
    digest: "sha256:059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
    commandName: "bash",
    artifactPath: `${WASMER_RUNNER_CONTRACT.guestRoot}/bash-1.0.25.webc`,
    abi: "wasix",
  },
  python: {
    guest: "python",
    packageRef: "python/python@3.13.20",
    version: "3.13.20",
    digest: "sha256:a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7",
    commandName: "python",
    artifactPath: `${WASMER_RUNNER_CONTRACT.guestRoot}/python-3.13.20.webc`,
    abi: "wasix",
  },
};

function toWorkspaceGuestPath(guestPath: string): string {
  return guestPath.startsWith("/workspace/") || guestPath === "/workspace"
    ? guestPath
    : `/workspace${guestPath.startsWith("/") ? "" : "/"}${guestPath}`;
}

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
  const baseDriver = createSdkWasmerDriver({
    cacheDirectory: `${WASMER_RUNNER_CONTRACT.guestRoot}/cache`,
  });
  const driver: WasmerDriver = {
    createInstance(config) {
      return baseDriver.createInstance({
        ...config,
        directoryGrants: config.directoryGrants.map((grant) => ({
          ...grant,
          guestPath: toWorkspaceGuestPath(grant.guestPath),
        })),
      });
    },
  };

  const sandbox = createWasmerSandbox({
    driver,
    guestPins: VERIFIED_GUEST_PINS,
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
