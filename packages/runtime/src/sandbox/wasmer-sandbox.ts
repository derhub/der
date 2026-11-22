import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox, SandboxRequest, SandboxResult } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { Wasmer } from "@wasmer/sdk/node";
import { probeDockerIsolation, type DockerResourceLimits } from "./docker-policy";
import { SandboxControlError } from "./errors";
import { bunCommandRunner, type CommandRunner } from "./process-runner";
import {
  validateWasmerDirectoryGrants,
  validateWasmerGuestPin,
  WASMER_RUNNER_CONTRACT,
  type WasmerDirectoryGrant,
  type WasmerGuestKind,
  type WasmerGuestPin,
  type WasmerRealPathResolver,
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
  readonly resolveRealPath?: WasmerRealPathResolver;
}

export interface DockerWasmerSandboxConfig {
  readonly dockerHost: string;
  readonly dockerBinary?: string;
  readonly image?: string;
  readonly user: string;
  readonly limits: DockerResourceLimits;
  readonly allowedHostRoots: readonly string[];
  readonly guestPins?: Readonly<Record<WasmerGuestKind, WasmerGuestPin>>;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly runner?: CommandRunner;
  readonly now?: () => number;
  readonly resolveRealPath?: WasmerRealPathResolver;
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

function isRootUserSpec(user: string): boolean {
  const trimmed = user.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const [uidPart] = trimmed.split(":");
  return !uidPart || uidPart === "root" || uidPart === "0";
}

export async function verifyWasmerArtifactBytes(pin: WasmerGuestPin): Promise<Uint8Array> {
  validateWasmerGuestPin(pin);

  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(pin.artifactPath);
  } catch (error) {
    throw new SandboxControlError(
      "wasmer.artifact_missing",
      `Verified local Wasmer artifact "${pin.artifactPath}" for guest "${pin.guest}" is missing or unreadable; registry fallback is disabled.`,
      { cause: error },
    );
  }

  const actualDigest = `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`;
  const expectedDigest = pin.digest.toLowerCase();
  if (actualDigest !== expectedDigest) {
    throw new SandboxControlError(
      "wasmer.digest_mismatch",
      `Local Wasmer artifact "${pin.artifactPath}" digest mismatch: expected ${expectedDigest}, got ${actualDigest}; registry fallback is disabled.`,
    );
  }

  return new Uint8Array(rawBytes);
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
      const verifiedArtifactBytes = await verifyWasmerArtifactBytes(config.guestPin);

      const client = await Wasmer.create({
        outputBytes: config.maxOutputBytes,
        cache:
          options?.cacheDirectory !== undefined
            ? { directory: options.cacheDirectory, readOnly: true }
            : "memory",
      });

      try {
        const pkg = await client.packages.load(verifiedArtifactBytes);
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
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
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
        {
          allowedHostRoots: config.allowedHostRoots,
          ...(config.resolveRealPath !== undefined
            ? { resolveRealPath: config.resolveRealPath }
            : {}),
        },
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

export function createDockerWasmerSandbox(config: DockerWasmerSandboxConfig): Sandbox {
  const runner = config.runner ?? bunCommandRunner;
  const dockerBinary = config.dockerBinary ?? "docker";
  const image = config.image ?? WASMER_RUNNER_CONTRACT.imageTarget;
  const guestPins = config.guestPins ?? WASMER_RUNNER_CONTRACT.guests;
  const maxTimeoutMs = config.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const now = config.now ?? (() => Date.now());
  const hostEnv = { DOCKER_HOST: config.dockerHost };

  validateWasmerGuestPin(guestPins.bash);
  validateWasmerGuestPin(guestPins.python);

  if (isRootUserSpec(config.user)) {
    throw new SandboxControlError(
      "docker.root_user_forbidden",
      `Wasmer runner container user "${config.user}" must be non-root.`,
    );
  }
  if (
    !Number.isFinite(config.limits.cpus) ||
    config.limits.cpus <= 0 ||
    !Number.isInteger(config.limits.memoryMb) ||
    config.limits.memoryMb < 64 ||
    !Number.isInteger(config.limits.pidsLimit) ||
    config.limits.pidsLimit < 16
  ) {
    throw new SandboxControlError(
      "docker.invalid_resource_limits",
      `Invalid Wasmer runner resource limits: cpus=${config.limits.cpus}, memoryMb=${config.limits.memoryMb}, pidsLimit=${config.limits.pidsLimit}.`,
    );
  }

  return {
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
        {
          allowedHostRoots: config.allowedHostRoots,
          ...(config.resolveRealPath !== undefined
            ? { resolveRealPath: config.resolveRealPath }
            : {}),
        },
      );

      const probe = await probeDockerIsolation({
        dockerHost: config.dockerHost,
        dockerBinary,
        runner,
      });
      if (!probe.isolationVerified) {
        throw new SandboxControlError(
          "docker.isolation_unverified",
          `Hardened Docker isolation check failed for Wasmer runner: ${probe.reasons.join("; ")}`,
        );
      }

      const boundedTimeoutMs = Math.min(request.timeoutMs, maxTimeoutMs);
      const containerName = `der-wasmer-${crypto.randomUUID().slice(0, 12)}`;
      const args: string[] = [
        "run",
        "--rm",
        "-i",
        "--name",
        containerName,
        "--user",
        config.user,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m",
        "--network=none",
        `--cpus=${config.limits.cpus}`,
        `--memory=${config.limits.memoryMb}m`,
        `--memory-swap=${config.limits.memoryMb}m`,
        `--pids-limit=${config.limits.pidsLimit}`,
      ];

      const containerReadonlyPaths: string[] = [];
      const containerWritablePaths: string[] = [];
      let roIndex = 0;
      let rwIndex = 0;

      for (const grant of directoryGrants) {
        if (grant.access === "readonly") {
          const target = `/work/ro-${roIndex}`;
          roIndex += 1;
          args.push("--mount", `type=bind,source=${grant.hostPath},target=${target},readonly`);
          containerReadonlyPaths.push(target);
        } else {
          const target = `/work/rw-${rwIndex}`;
          rwIndex += 1;
          args.push("--mount", `type=bind,source=${grant.hostPath},target=${target}`);
          containerWritablePaths.push(target);
        }
      }

      args.push("-e", "DER_WASMER_ALLOWED_ROOTS=/work", image);

      const containerRequest: SandboxRequest = {
        command: guestPin.commandName,
        args: request.args,
        timeoutMs: boundedTimeoutMs,
        network: "none",
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(containerReadonlyPaths.length > 0 ? { readonlyPaths: containerReadonlyPaths } : {}),
        ...(containerWritablePaths.length > 0 ? { writablePaths: containerWritablePaths } : {}),
      };

      const startedAt = now();
      const execResult = await runner.exec(dockerBinary, args, {
        env: hostEnv,
        stdin: JSON.stringify(containerRequest),
        timeoutMs: boundedTimeoutMs + 2_000,
      });

      if (execResult.timedOut) {
        await runner
          .exec(dockerBinary, ["rm", "-f", containerName], { env: hostEnv })
          .catch(() => {});
        const durationMs = Math.max(0, now() - startedAt);
        return compiledParsers.sandboxResult.parse({
          exitCode: 124,
          stdout: "",
          stderr: "Wasmer runner container timed out.",
          timedOut: true,
          durationMs,
        });
      }

      if (execResult.exitCode !== 0) {
        throw new SandboxControlError(
          "wasmer.execution_failed",
          `Wasmer runner container exited with code ${execResult.exitCode}: ${execResult.stderr.trim() || "no stderr"}`,
        );
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(execResult.stdout.trim());
      } catch (error) {
        throw new SandboxControlError(
          "wasmer.execution_failed",
          `Wasmer runner returned malformed JSON result.`,
          { cause: error },
        );
      }

      const parsed = compiledParsers.sandboxResult.parse(decoded);
      const durationMs = Math.max(parsed.durationMs, Math.max(0, now() - startedAt));
      return compiledParsers.sandboxResult.parse({
        exitCode: parsed.exitCode,
        stdout: truncateUtf8(parsed.stdout, maxOutputBytes),
        stderr: truncateUtf8(parsed.stderr, maxOutputBytes),
        timedOut: parsed.timedOut,
        durationMs,
      });
    },
  };
}
