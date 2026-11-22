import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox, SandboxRequest, SandboxResult } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { Wasmer } from "@wasmer/sdk/node";
import { SandboxControlError } from "./errors";
import {
  validateWasmerDirectoryGrants,
  validateWasmerGuestPin,
  WASMER_RUNNER_CONTRACT,
  type WasmerDirectoryGrant,
  type WasmerGuestKind,
  type WasmerGuestPin,
} from "./wasmer-contract";

export interface WasmerLaunchConfig {
  readonly guestPin: WasmerGuestPin;
  readonly networkMode: "disabled";
  readonly directoryGrants: readonly WasmerDirectoryGrant[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface WasmerRunInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export interface WasmerRunOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface WasmerGuestInstance {
  run(input: WasmerRunInput): Promise<WasmerRunOutput>;
  close(): Promise<void>;
}

export interface WasmerDriver {
  createInstance(config: WasmerLaunchConfig): Promise<WasmerGuestInstance>;
}

export interface WasmerSandboxConfig {
  readonly driver?: WasmerDriver;
  readonly guestPins?: Readonly<Record<WasmerGuestKind, WasmerGuestPin>>;
  readonly allowedHostRoots: readonly string[];
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => number;
}

export interface ManagedWasmerSandbox extends Sandbox {
  activeSandboxCount(): number;
}

const DEFAULT_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  return decoder.decode(bytes.subarray(0, maxBytes));
}

async function copyDirectoryToSandbox(
  hostDir: string,
  guestDir: string,
  writeFileFn: (path: string, contents: Uint8Array) => Promise<void>,
  mkdirFn: (path: string) => Promise<void>,
): Promise<void> {
  await mkdirFn(guestDir);
  const entries = await readdir(hostDir, { withFileTypes: true });
  for (const entry of entries) {
    const hostChild = join(hostDir, entry.name);
    const guestChild = `${guestDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await copyDirectoryToSandbox(hostChild, guestChild, writeFileFn, mkdirFn);
    } else if (entry.isFile()) {
      const content = await readFile(hostChild);
      await writeFileFn(guestChild, new Uint8Array(content));
    }
  }
}

async function syncWritableDirectoryBack(
  guestDir: string,
  hostDir: string,
  readDirFn: (
    path: string,
  ) => Promise<readonly { readonly name: string; readonly kind: "file" | "directory" }[]>,
  readFileFn: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  await mkdir(hostDir, { recursive: true });
  const entries = await readDirFn(guestDir);
  for (const entry of entries) {
    const guestChild = `${guestDir}/${entry.name}`;
    const hostChild = join(hostDir, entry.name);
    if (entry.kind === "directory") {
      await syncWritableDirectoryBack(guestChild, hostChild, readDirFn, readFileFn);
    } else {
      const data = await readFileFn(guestChild);
      await writeFile(hostChild, data);
    }
  }
}

export function createSdkWasmerDriver(options?: {
  readonly cacheDirectory?: string;
}): WasmerDriver {
  return {
    async createInstance(config: WasmerLaunchConfig): Promise<WasmerGuestInstance> {
      const client = await Wasmer.create({
        outputBytes: config.maxOutputBytes,
        cache:
          options?.cacheDirectory !== undefined
            ? { directory: options.cacheDirectory, readOnly: true }
            : "memory",
      });

      let guestSource: Uint8Array | string = config.guestPin.packageRef;
      try {
        const artifactBytes = await readFile(config.guestPin.artifactPath);
        guestSource = new Uint8Array(artifactBytes);
      } catch {
        guestSource = config.guestPin.packageRef;
      }

      const pkg = await client.packages.load(guestSource);
      const sandbox = await client.sandboxes.create({
        packages: [pkg],
        env: config.env,
        network: { mode: "disabled" },
      });

      for (const grant of config.directoryGrants) {
        await copyDirectoryToSandbox(
          grant.hostPath,
          grant.guestPath,
          (path, contents) => sandbox.fs.writeFile(path, contents),
          (path) => sandbox.fs.mkdir(path, { recursive: true }),
        );
      }

      return {
        async run(input: WasmerRunInput): Promise<WasmerRunOutput> {
          const cmd = sandbox.command(
            pkg.command(config.guestPin.commandName),
            input.args,
            input.cwd !== undefined ? { cwd: input.cwd } : undefined,
          );
          const output = await cmd.run({
            timeoutMs: config.timeoutMs,
            outputBytes: config.maxOutputBytes,
            check: false,
          });

          for (const grant of config.directoryGrants) {
            if (grant.access === "readwrite") {
              await syncWritableDirectoryBack(
                grant.guestPath,
                grant.hostPath,
                (path) => sandbox.fs.readDir(path),
                (path) => sandbox.fs.readFile(path),
              );
            }
          }

          return {
            exitCode: output.reason === "timeout" ? 124 : output.exitCode,
            stdout: output.stdout.text(),
            stderr: output.stderr.text(),
            timedOut: output.reason === "timeout",
          };
        },
        async close(): Promise<void> {
          try {
            await sandbox.close();
          } finally {
            await client.close();
          }
        },
      };
    },
  };
}

function resolveGuestKind(command: string): WasmerGuestKind {
  if (command === "bash" || command === "python") {
    return command;
  }
  throw new SandboxControlError(
    "wasmer.unsupported_guest",
    `Unsupported Wasmer guest "${command}". Only pinned "bash" and "python" guests are permitted.`,
  );
}

export function createWasmerSandbox(config: WasmerSandboxConfig): ManagedWasmerSandbox {
  const driver = config.driver ?? createSdkWasmerDriver();
  const guestPins = config.guestPins ?? WASMER_RUNNER_CONTRACT.guests;
  const maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const now = config.now ?? (() => Date.now());

  validateWasmerGuestPin(guestPins.bash);
  validateWasmerGuestPin(guestPins.python);

  let activeCount = 0;

  return {
    activeSandboxCount(): number {
      return activeCount;
    },

    async execute(rawRequest: SandboxRequest): Promise<SandboxResult> {
      const request = compiledParsers.sandboxRequest.parse(rawRequest);

      if (request.network !== "none") {
        throw new SandboxControlError(
          "wasmer.network_forbidden",
          `Wasmer runner requires network="none", received "${request.network}".`,
        );
      }

      const guestKind = resolveGuestKind(request.command);
      const guestPin = guestPins[guestKind];
      validateWasmerGuestPin(guestPin);

      const directoryGrants = validateWasmerDirectoryGrants(
        {
          ...(request.readonlyPaths !== undefined ? { readonlyPaths: request.readonlyPaths } : {}),
          ...(request.writablePaths !== undefined ? { writablePaths: request.writablePaths } : {}),
        },
        { allowedHostRoots: config.allowedHostRoots },
      );

      const boundedTimeoutMs = Math.min(request.timeoutMs, maxTimeoutMs);
      const startedAt = now();
      const instance = await driver.createInstance({
        guestPin,
        networkMode: "disabled",
        directoryGrants,
        env: request.env ?? {},
        timeoutMs: boundedTimeoutMs,
        maxOutputBytes,
      });
      activeCount += 1;

      try {
        const output = await instance.run({
          command: guestPin.commandName,
          args: request.args,
          ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        });
        const durationMs = Math.max(0, now() - startedAt);
        return compiledParsers.sandboxResult.parse({
          exitCode: output.exitCode,
          stdout: truncateUtf8(output.stdout, maxOutputBytes),
          stderr: truncateUtf8(output.stderr, maxOutputBytes),
          timedOut: output.timedOut,
          durationMs,
        });
      } finally {
        try {
          await instance.close();
        } finally {
          activeCount = Math.max(0, activeCount - 1);
        }
      }
    },
  };
}
