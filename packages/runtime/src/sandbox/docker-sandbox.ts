import type { Sandbox, SandboxRequest, SandboxResult } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import {
  createExecBackedGit,
  UnsupportedCapabilityError,
  type ExecResult,
  type ProcessOptions,
  type SandboxCapabilities,
  type SandboxCreateInput,
  type SandboxDestroyInput,
  type SandboxFs,
  type SandboxFsOptions,
  type SandboxHandle,
  type SandboxProcess,
  type SandboxProvider,
  type SandboxResumeInput,
  type SpawnHandle,
} from "@tanstack/ai-sandbox";
import {
  buildDockerRunArgs,
  probeDockerEgressNetwork,
  probeDockerIsolation,
  type DockerContainerSpec,
  type DockerMountSpec,
  type DockerNetworkPolicy,
  type DockerResourceLimits,
  type EngineShadowHomeSpec,
  type OfficialEngineKind,
  type RealPathResolver,
} from "./docker-policy";
import { SandboxControlError } from "./errors";
import { bunCommandRunner, type CommandRunner } from "./process-runner";

export interface HardenedDockerProviderConfig {
  readonly dockerHost: string;
  readonly dockerBinary?: string;
  readonly image: string;
  readonly engine: OfficialEngineKind;
  readonly user: string;
  readonly workspaceHostPath: string;
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly workspaceContainerPath?: string;
  readonly shadowHome: EngineShadowHomeSpec;
  readonly network: DockerNetworkPolicy;
  readonly limits: DockerResourceLimits;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraMounts?: readonly DockerMountSpec[];
  readonly readOnlyRootfs?: boolean;
  readonly runner?: CommandRunner;
  readonly verifyIsolationOnCreate?: boolean;
  readonly resolveRealPath?: RealPathResolver;
}

const HARDENED_DOCKER_CAPABILITIES: SandboxCapabilities = {
  fs: true,
  exec: true,
  env: true,
  ports: false,
  backgroundProcesses: true,
  writableStdin: true,
  killableProcesses: true,
  snapshots: false,
  networkPolicy: true,
  durableFilesystem: false,
  fork: false,
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizeContainerSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : crypto.randomUUID().slice(0, 12);
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Sandbox operation aborted.");
  }
}

function createDockerHandle(input: {
  readonly containerId: string;
  readonly workspaceRoot: string;
  readonly dockerBinary: string;
  readonly dockerHost: string;
  readonly runner: CommandRunner;
  readonly initialEnv: Readonly<Record<string, string>>;
}): SandboxHandle {
  const mutableEnv: Record<string, string> = { ...input.initialEnv };
  const hostEnv = { DOCKER_HOST: input.dockerHost };

  const buildExecPrefix = (options?: ProcessOptions, interactive?: boolean): string[] => {
    const args: string[] = ["exec"];
    if (interactive) {
      args.push("-i");
    }
    const cwd = options?.cwd ?? input.workspaceRoot;
    args.push("-w", cwd);
    const merged = { ...mutableEnv, ...options?.env };
    for (const [key, value] of Object.entries(merged)) {
      if (key === "DOCKER_HOST") {
        continue;
      }
      args.push("-e", `${key}=${value}`);
    }
    args.push(input.containerId);
    return args;
  };

  const sandboxProcess: SandboxProcess = {
    async exec(command: string, options?: ProcessOptions): Promise<ExecResult> {
      checkAborted(options?.signal);
      const args = [...buildExecPrefix(options, false), "sh", "-lc", command];
      const result = await input.runner.exec(input.dockerBinary, args, {
        env: hostEnv,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },

    async spawn(command: string, options?: ProcessOptions): Promise<SpawnHandle> {
      checkAborted(options?.signal);
      const args = [...buildExecPrefix(options, true), "sh", "-lc", command];
      const handle = await input.runner.spawn(input.dockerBinary, args, {
        env: hostEnv,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
      return {
        pid: handle.pid,
        stdout: handle.stdout,
        stderr: handle.stderr,
        stdin: handle.stdin,
        wait: handle.wait,
        kill: handle.kill,
      };
    },
  };

  const runFsExec = async (command: string, options?: SandboxFsOptions): Promise<ExecResult> => {
    checkAborted(options?.signal);
    const result = await sandboxProcess.exec(
      command,
      options?.signal !== undefined ? { signal: options.signal } : undefined,
    );
    if (result.exitCode !== 0) {
      throw new SandboxControlError(
        "docker.exec_failed",
        `Container filesystem command failed (exit ${result.exitCode}): ${result.stderr.trim() || command}`,
      );
    }
    return result;
  };

  const fs: SandboxFs = {
    async read(path: string, options?: SandboxFsOptions): Promise<string> {
      const result = await runFsExec(`cat -- ${shellQuote(path)}`, options);
      return result.stdout;
    },
    async readBytes(path: string, options?: SandboxFsOptions): Promise<Uint8Array> {
      const result = await runFsExec(`base64 -- ${shellQuote(path)}`, options);
      const compact = result.stdout.replace(/\s+/g, "");
      const binary = atob(compact);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    },
    async write(
      path: string,
      data: string | Uint8Array,
      options?: SandboxFsOptions,
    ): Promise<void> {
      checkAborted(options?.signal);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      const encoded = btoa(binary);
      const args = [
        ...buildExecPrefix(undefined, true),
        "sh",
        "-lc",
        `mkdir -p "$(dirname -- ${shellQuote(path)})" && base64 -d > ${shellQuote(path)}`,
      ];
      const result = await input.runner.exec(input.dockerBinary, args, {
        env: hostEnv,
        stdin: encoded,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (result.exitCode !== 0) {
        throw new SandboxControlError(
          "docker.exec_failed",
          `Failed writing "${path}" inside container (exit ${result.exitCode}): ${result.stderr.trim()}`,
        );
      }
    },
    async list(
      path: string,
      options?: SandboxFsOptions,
    ): Promise<Array<{ name: string; path: string; type: "file" | "dir" }>> {
      const result = await runFsExec(
        `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'`,
        options,
      );
      const base = path.endsWith("/") ? path.slice(0, -1) : path;
      const entries: Array<{ name: string; path: string; type: "file" | "dir" }> = [];
      for (const line of result.stdout.split("\n")) {
        if (!line) {
          continue;
        }
        const [kind, name] = line.split("\t");
        if (!name) {
          continue;
        }
        entries.push({
          name,
          path: `${base}/${name}`,
          type: kind === "d" ? "dir" : "file",
        });
      }
      return entries;
    },
    async mkdir(path: string, options?: SandboxFsOptions): Promise<void> {
      await runFsExec(`mkdir -p -- ${shellQuote(path)}`, options);
    },
    async remove(path: string, options?: SandboxFsOptions): Promise<void> {
      await runFsExec(`rm -rf -- ${shellQuote(path)}`, options);
    },
    async rename(from: string, to: string, options?: SandboxFsOptions): Promise<void> {
      await runFsExec(`mv -- ${shellQuote(from)} ${shellQuote(to)}`, options);
    },
    async exists(path: string, options?: SandboxFsOptions): Promise<boolean> {
      checkAborted(options?.signal);
      const result = await sandboxProcess.exec(
        `test -e ${shellQuote(path)}`,
        options?.signal !== undefined ? { signal: options.signal } : undefined,
      );
      return result.exitCode === 0;
    },
  };

  return {
    id: input.containerId,
    provider: "docker",
    workspaceRoot: input.workspaceRoot,
    capabilities: HARDENED_DOCKER_CAPABILITIES,
    fs,
    git: createExecBackedGit(sandboxProcess, input.workspaceRoot),
    process: sandboxProcess,
    ports: {
      async connect() {
        throw new UnsupportedCapabilityError("docker", "ports");
      },
    },
    env: {
      async set(vars: Record<string, string>) {
        for (const [key, value] of Object.entries(vars)) {
          if (key !== "DOCKER_HOST") {
            mutableEnv[key] = value;
          }
        }
      },
    },
    async destroy() {
      await input.runner.exec(input.dockerBinary, ["rm", "-f", input.containerId], {
        env: hostEnv,
      });
    },
  };
}

export function createHardenedDockerProvider(
  config: HardenedDockerProviderConfig,
): SandboxProvider {
  const runner = config.runner ?? bunCommandRunner;
  const dockerBinary = config.dockerBinary ?? "docker";
  const workspaceRoot = config.workspaceContainerPath ?? "/workspace";
  const hostEnv = { DOCKER_HOST: config.dockerHost };

  const lockedProxyEnv: Readonly<Record<string, string>> =
    config.network.mode === "scoped_egress" &&
    typeof config.network.egressProxyUrl === "string" &&
    config.network.egressProxyUrl.trim().length > 0
      ? {
          HTTP_PROXY: config.network.egressProxyUrl.trim(),
          HTTPS_PROXY: config.network.egressProxyUrl.trim(),
          http_proxy: config.network.egressProxyUrl.trim(),
          https_proxy: config.network.egressProxyUrl.trim(),
        }
      : {};

  return {
    name: "docker",
    capabilities(): SandboxCapabilities {
      return { ...HARDENED_DOCKER_CAPABILITIES };
    },
    async create(input: SandboxCreateInput): Promise<SandboxHandle> {
      const containerName = `der-${config.engine}-${sanitizeContainerSegment(
        input.id ?? crypto.randomUUID(),
      )}`;
      const mergedEnv: Record<string, string> = {
        ...config.env,
        ...input.env,
      };
      if (config.verifyIsolationOnCreate !== false) {
        const probe = await probeDockerIsolation({
          dockerHost: config.dockerHost,
          dockerBinary,
          runner,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        if (!probe.isolationVerified) {
          throw new SandboxControlError(
            "docker.isolation_unverified",
            `Hardened Docker isolation check failed: ${probe.reasons.join("; ")}`,
          );
        }
      }

      if (config.network.mode === "scoped_egress") {
        const egressProbe = await probeDockerEgressNetwork({
          dockerHost: config.dockerHost,
          networkName: config.network.networkName,
          engine: config.engine,
          allowedHosts: config.network.allowedHosts,
          egressProxyUrl: config.network.egressProxyUrl,
          dockerBinary,
          runner,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        if (!egressProbe.verified) {
          throw new SandboxControlError(
            "docker.egress_network_unverified",
            `Hardened Docker egress network check failed: ${egressProbe.reasons.join("; ")}`,
          );
        }
      }

      const spec: DockerContainerSpec = {
        containerName,
        image: config.image,
        engine: config.engine,
        user: config.user,
        workspaceMount: {
          source: config.workspaceHostPath,
          target: workspaceRoot,
          readonly: false,
        },
        allowedWorkspaceRoots: config.allowedWorkspaceRoots ?? [config.workspaceHostPath],
        shadowHome: config.shadowHome,
        network: config.network,
        limits: config.limits,
        dockerHost: config.dockerHost,
        env: mergedEnv,
        ...(config.extraMounts !== undefined ? { extraMounts: config.extraMounts } : {}),
        ...(config.readOnlyRootfs !== undefined ? { readOnlyRootfs: config.readOnlyRootfs } : {}),
        ...(config.resolveRealPath !== undefined
          ? { resolveRealPath: config.resolveRealPath }
          : {}),
      };

      const runArgs = buildDockerRunArgs(spec, {
        detach: true,
        command: ["sleep", "infinity"],
      });

      const started = await runner.exec(dockerBinary, runArgs, {
        env: hostEnv,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      if (started.exitCode !== 0) {
        throw new SandboxControlError(
          "docker.launch_failed",
          `Failed to start hardened container "${containerName}" (exit ${started.exitCode}): ${started.stderr.trim()}`,
        );
      }

      const containerId = started.stdout.trim() || containerName;
      return createDockerHandle({
        containerId,
        workspaceRoot,
        dockerBinary,
        dockerHost: config.dockerHost,
        runner,
        initialEnv: {
          ...config.shadowHome.envOverrides,
          ...mergedEnv,
          ...lockedProxyEnv,
        },
      });
    },

    async resume(input: SandboxResumeInput): Promise<SandboxHandle | null> {
      const inspected = await runner.exec(
        dockerBinary,
        ["inspect", "-f", "{{.State.Running}}", input.id],
        {
          env: hostEnv,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
      );
      if (inspected.exitCode !== 0 || inspected.stdout.trim() !== "true") {
        return null;
      }
      return createDockerHandle({
        containerId: input.id,
        workspaceRoot,
        dockerBinary,
        dockerHost: config.dockerHost,
        runner,
        initialEnv: {
          ...config.shadowHome.envOverrides,
          ...config.env,
          ...lockedProxyEnv,
        },
      });
    },

    async destroy(input: SandboxDestroyInput): Promise<void> {
      await runner.exec(dockerBinary, ["rm", "-f", input.id], {
        env: hostEnv,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    },
  };
}

export interface DockerSandboxConfig {
  readonly dockerHost: string;
  readonly dockerBinary?: string;
  readonly image: string;
  readonly engine: OfficialEngineKind;
  readonly user: string;
  readonly workspaceHostPath: string;
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly shadowHome: EngineShadowHomeSpec;
  readonly egressNetwork?: {
    readonly networkName: string;
    readonly allowedHosts: readonly string[];
    readonly egressProxyUrl: string;
  };
  readonly limits: DockerResourceLimits;
  readonly runner?: CommandRunner;
  readonly now?: () => number;
  readonly resolveRealPath?: RealPathResolver;
}

export function createDockerSandbox(config: DockerSandboxConfig): Sandbox {
  const runner = config.runner ?? bunCommandRunner;
  const dockerBinary = config.dockerBinary ?? "docker";
  const now = config.now ?? (() => Date.now());
  const hostEnv = { DOCKER_HOST: config.dockerHost };

  return {
    async execute(rawRequest: SandboxRequest): Promise<SandboxResult> {
      const request = compiledParsers.sandboxRequest.parse(rawRequest);
      const probe = await probeDockerIsolation({
        dockerHost: config.dockerHost,
        dockerBinary,
        runner,
      });
      if (!probe.isolationVerified) {
        throw new SandboxControlError(
          "docker.isolation_unverified",
          `Hardened Docker isolation check failed: ${probe.reasons.join("; ")}`,
        );
      }

      const network: DockerNetworkPolicy =
        request.network === "none"
          ? { mode: "none" }
          : config.egressNetwork !== undefined
            ? {
                mode: "scoped_egress",
                networkName: config.egressNetwork.networkName,
                allowedHosts: config.egressNetwork.allowedHosts,
                egressProxyUrl: config.egressNetwork.egressProxyUrl,
              }
            : (() => {
                throw new SandboxControlError(
                  "docker.host_network_forbidden",
                  "scoped_egress requested without a configured egress network.",
                );
              })();

      if (network.mode === "scoped_egress") {
        const egressProbe = await probeDockerEgressNetwork({
          dockerHost: config.dockerHost,
          networkName: network.networkName,
          engine: config.engine,
          allowedHosts: network.allowedHosts,
          egressProxyUrl: network.egressProxyUrl,
          dockerBinary,
          runner,
        });
        if (!egressProbe.verified) {
          throw new SandboxControlError(
            "docker.egress_network_unverified",
            `Hardened Docker egress network check failed: ${egressProbe.reasons.join("; ")}`,
          );
        }
      }

      const extraMounts: DockerMountSpec[] = [
        ...(request.readonlyPaths ?? []).map((hostPath, idx): DockerMountSpec => ({
          type: "bind",
          source: hostPath,
          target: `/mnt/ro-${idx}`,
          readonly: true,
        })),
        ...(request.writablePaths ?? []).map((hostPath, idx): DockerMountSpec => ({
          type: "bind",
          source: hostPath,
          target: `/mnt/rw-${idx}`,
          readonly: false,
        })),
      ];

      const containerName = `der-oneshot-${sanitizeContainerSegment(crypto.randomUUID())}`;
      const args = buildDockerRunArgs(
        {
          containerName,
          image: config.image,
          engine: config.engine,
          user: config.user,
          workspaceMount: {
            source: config.workspaceHostPath,
            target: request.cwd ?? "/workspace",
            readonly: false,
          },
          allowedWorkspaceRoots: config.allowedWorkspaceRoots ?? [config.workspaceHostPath],
          shadowHome: config.shadowHome,
          network,
          limits: config.limits,
          dockerHost: config.dockerHost,
          ...(request.env !== undefined ? { env: request.env } : {}),
          ...(extraMounts.length > 0 ? { extraMounts } : {}),
          readOnlyRootfs: true,
          ...(config.resolveRealPath !== undefined
            ? { resolveRealPath: config.resolveRealPath }
            : {}),
        },
        {
          removeOnExit: true,
          command: [request.command, ...request.args],
        },
      );

      const startedAt = now();
      const result = await runner.exec(dockerBinary, args, {
        env: hostEnv,
        timeoutMs: request.timeoutMs,
      });
      if (result.timedOut) {
        await runner
          .exec(dockerBinary, ["rm", "-f", containerName], { env: hostEnv })
          .catch(() => {});
      }
      const durationMs = Math.max(0, now() - startedAt);
      return compiledParsers.sandboxResult.parse({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut === true,
        durationMs,
      });
    },
  };
}
