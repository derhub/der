import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  buildDockerRunArgs,
  createDockerSandbox,
  createHardenedDockerProvider,
  DEFAULT_ENGINE_SHADOW_HOMES,
  probeDockerEgressNetwork,
  probeDockerIsolation,
  SandboxControlError,
  validateDockerContainerSpec,
  type CommandExecOptions,
  type CommandExecResult,
  type CommandRunner,
  type CommandSpawnHandle,
  type DockerContainerSpec,
} from "../../src/sandbox/index";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

function createFakeCommandRunner(handlers: {
  readonly onExec?: (
    command: string,
    args: readonly string[],
    options?: CommandExecOptions,
  ) => Promise<CommandExecResult> | CommandExecResult;
  readonly onSpawn?: (
    command: string,
    args: readonly string[],
    options?: CommandExecOptions,
  ) => Promise<CommandSpawnHandle> | CommandSpawnHandle;
}): { readonly runner: CommandRunner; readonly calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = [];
  const runner: CommandRunner = {
    async exec(command, args, options) {
      calls.push({
        command,
        args: [...args],
        ...(options?.env ? { env: { ...options.env } } : {}),
      });
      if (handlers.onExec) {
        return handlers.onExec(command, args, options);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async spawn(command, args, options) {
      calls.push({
        command,
        args: [...args],
        ...(options?.env ? { env: { ...options.env } } : {}),
      });
      if (handlers.onSpawn) {
        return handlers.onSpawn(command, args, options);
      }
      return createFakeSpawnHandle({ stdout: [], stderr: [], exitCode: 0 });
    },
  };
  return { runner, calls };
}

function createFakeSpawnHandle(input: {
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  readonly exitCode: number;
  readonly onStdinWrite?: (chunk: string) => void;
  readonly onKill?: (signal?: NodeJS.Signals | number) => void;
}): CommandSpawnHandle & {
  readonly writes: string[];
  readonly killedSignals: Array<NodeJS.Signals | number | undefined>;
} {
  const writes: string[] = [];
  const killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  return {
    pid: 4242,
    writes,
    killedSignals,
    stdout: (async function* () {
      for (const chunk of input.stdout) {
        yield chunk;
      }
    })(),
    stderr: (async function* () {
      for (const chunk of input.stderr) {
        yield chunk;
      }
    })(),
    stdin: {
      async write(data: string) {
        writes.push(data);
        input.onStdinWrite?.(data);
      },
      async end() {},
    },
    async wait() {
      return input.exitCode;
    },
    async kill(signal) {
      killedSignals.push(signal);
      input.onKill?.(signal);
    },
  };
}

const identityRealPath = (path: string): string => path;

function validContainerSpec(overrides?: Partial<DockerContainerSpec>): DockerContainerSpec {
  return {
    containerName: "der-codex-run-1",
    image: "der-engine-codex:pinned",
    engine: "codex",
    user: "1000:1000",
    workspaceMount: {
      source: "/srv/der/workspaces/sess-1",
      target: "/workspace",
      readonly: false,
    },
    shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
    network: { mode: "none" },
    limits: {
      cpus: 2,
      memoryMb: 1024,
      pidsLimit: 256,
    },
    dockerHost: "unix:///run/user/1000/docker.sock",
    resolveRealPath: identityRealPath,
    ...overrides,
  };
}

describe("validate and build hardened Docker launch controls", () => {
  it("builds hardened docker run args with non-root user, cap-drop ALL, no-new-privileges, network none, limits, workspace, and dedicated engine shadow home", () => {
    const spec = validContainerSpec();
    const args = buildDockerRunArgs(spec, { detach: true, command: ["sleep", "infinity"] });

    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "der-codex-run-1",
      "--user",
      "1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--network=none",
      "--cpus=2",
      "--memory=1024m",
      "--memory-swap=1024m",
      "--pids-limit=256",
      "--mount",
      "type=bind,source=/srv/der/workspaces/sess-1,target=/workspace",
      "--mount",
      "type=volume,source=der-home-codex,target=/home/engine",
      "-w",
      "/workspace",
      "-e",
      "HOME=/home/engine",
      "-e",
      "CODEX_HOME=/home/engine/.codex",
      "der-engine-codex:pinned",
      "sleep",
      "infinity",
    ]);
  });

  it("supports scoped egress using an explicit isolated egress network, egress proxy URL, and approved vendor endpoints", () => {
    const spec = validContainerSpec({
      engine: "claude-code",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES["claude-code"],
      network: {
        mode: "scoped_egress",
        networkName: "der-egress-claude",
        allowedHosts: ["api.anthropic.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
    });
    const args = buildDockerRunArgs(spec, { detach: true, command: ["sleep", "infinity"] });

    expect(args).toContain("--network=der-egress-claude");
    expect(args).toContain("type=volume,source=der-home-claude-code,target=/home/engine");
    expect(args).toContain("CLAUDE_CONFIG_DIR=/home/engine/.claude");
    expect(args).toContain("HTTP_PROXY=http://egress-proxy:3128");
    expect(args).toContain("HTTPS_PROXY=http://egress-proxy:3128");
  });

  it("assigns distinct named shadow-home volumes to codex, claude-code, and antigravity", () => {
    const volumeNames = [
      DEFAULT_ENGINE_SHADOW_HOMES.codex.volumeName,
      DEFAULT_ENGINE_SHADOW_HOMES["claude-code"].volumeName,
      DEFAULT_ENGINE_SHADOW_HOMES.antigravity.volumeName,
    ];
    expect(new Set(volumeNames).size).toBe(3);
  });

  it.each([
    {
      name: "root username",
      spec: validContainerSpec({ user: "root" }),
      expectedCode: "docker.root_user_forbidden",
    },
    {
      name: "uid 0",
      spec: validContainerSpec({ user: "0:1000" }),
      expectedCode: "docker.root_user_forbidden",
    },
    {
      name: "host docker socket bind mount",
      spec: validContainerSpec({
        extraMounts: [
          {
            type: "bind",
            source: "/var/run/docker.sock",
            target: "/var/run/docker.sock",
            readonly: false,
          },
        ],
      }),
      expectedCode: "docker.socket_mount_forbidden",
    },
    {
      name: "configured rootless daemon socket bind mount",
      spec: validContainerSpec({
        dockerHost: "unix:///run/user/1000/docker.sock",
        extraMounts: [
          {
            type: "bind",
            source: "/run/user/1000/docker.sock",
            target: "/tmp/sock",
            readonly: true,
          },
        ],
      }),
      expectedCode: "docker.socket_mount_forbidden",
    },
    {
      name: "host home bind mount",
      spec: validContainerSpec({
        extraMounts: [
          {
            type: "bind",
            source: "/home/alice/.codex",
            target: "/home/engine/.codex",
            readonly: true,
          },
        ],
      }),
      expectedCode: "docker.host_home_mount_forbidden",
    },
    {
      name: "host network mode in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "host",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://egress-proxy:3128",
        },
      }),
      expectedCode: "docker.host_network_forbidden",
    },
    {
      name: "default network name in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "default",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://egress-proxy:3128",
        },
      }),
      expectedCode: "docker.host_network_forbidden",
    },
    {
      name: "container network sharing in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "container:other",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://egress-proxy:3128",
        },
      }),
      expectedCode: "docker.host_network_forbidden",
    },
    {
      name: "missing egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "non-http egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "file:///etc/passwd",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "loopback IPv4 egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://127.0.0.1:3128",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "localhost egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://localhost:3128",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "loopback IPv6 egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://[::1]:3128",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "link-local IPv4 egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://169.254.169.254:3128",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "link-local IPv6 egressProxyUrl in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["api.openai.com"],
          egressProxyUrl: "http://[fe80::1]:3128",
        },
      }),
      expectedCode: "docker.egress_network_unverified",
    },
    {
      name: "empty allowedHosts in scoped egress",
      spec: validContainerSpec({
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: [],
          egressProxyUrl: "http://egress-proxy:3128",
        },
      }),
      expectedCode: "docker.egress_host_not_approved",
    },
    {
      name: "path traversal in workspace bind mount",
      spec: validContainerSpec({
        workspaceMount: {
          source: "/srv/der/workspaces/../etc/passwd",
          target: "/workspace",
          readonly: false,
        },
      }),
      expectedCode: "docker.invalid_workspace_mount",
    },
    {
      name: "extra bind mount outside workspace root",
      spec: validContainerSpec({
        extraMounts: [
          {
            type: "bind",
            source: "/etc/passwd",
            target: "/mnt/ro-0",
            readonly: true,
          },
        ],
      }),
      expectedCode: "docker.bind_path_outside_root",
    },
    {
      name: "unapproved egress host",
      spec: validContainerSpec({
        engine: "codex",
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts: ["evil.example.com"],
          egressProxyUrl: "http://egress-proxy:3128",
        },
      }),
      expectedCode: "docker.egress_host_not_approved",
    },
    {
      name: "zero CPU limit",
      spec: validContainerSpec({ limits: { cpus: 0, memoryMb: 512, pidsLimit: 128 } }),
      expectedCode: "docker.invalid_resource_limits",
    },
    {
      name: "shadow home belonging to a different engine",
      spec: validContainerSpec({
        engine: "codex",
        shadowHome: DEFAULT_ENGINE_SHADOW_HOMES["claude-code"],
      }),
      expectedCode: "docker.shadow_home_mismatch",
    },
  ])("rejects unsafe launch spec: $name", ({ spec, expectedCode }) => {
    let caught: unknown;
    try {
      validateDockerContainerSpec(spec);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxControlError);
    expect((caught as SandboxControlError).code).toBe(expectedCode);
  });
});

describe("probe rootless Docker daemon isolation readiness", () => {
  it("verifies readiness when rootless daemon reports rootless security option and memory/cpu/pids cgroup support", async () => {
    const { runner, calls } = createFakeCommandRunner({
      onExec: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ServerVersion: "29.10.0",
          SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"],
          MemoryLimit: true,
          CpuCfsQuota: true,
          PidsLimit: true,
        }),
        stderr: "",
      }),
    });

    const report = await probeDockerIsolation({
      dockerHost: "unix:///run/user/1000/docker.sock",
      runner,
    });

    expect(report).toEqual({
      isolationVerified: true,
      isRootless: true,
      daemonVersion: "29.10.0",
      securityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"],
      reasons: [],
    });
    expect(calls[0]?.env?.["DOCKER_HOST"]).toBe("unix:///run/user/1000/docker.sock");
  });

  it("fails readiness when daemon is not rootless or lacks memory/cpu/pids enforcement", async () => {
    const { runner } = createFakeCommandRunner({
      onExec: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ServerVersion: "29.10.0",
          SecurityOptions: ["name=seccomp,profile=builtin"],
          MemoryLimit: false,
          CpuCfsQuota: true,
          PidsLimit: false,
        }),
        stderr: "",
      }),
    });

    const report = await probeDockerIsolation({
      dockerHost: "unix:///var/run/docker.sock",
      runner,
    });

    expect(report.isolationVerified).toBe(false);
    expect(report.isRootless).toBe(false);
    expect(report.reasons).toContain("Docker daemon is not running in rootless mode.");
    expect(report.reasons).toContain("Docker daemon does not enforce cgroup memory limits.");
    expect(report.reasons).toContain("Docker daemon does not enforce cgroup PIDs limits.");
  });
});

describe("provide a hardened @tanstack/ai-sandbox handle and @der/domain Sandbox", () => {
  it("launches a hardened container, runs exec/spawn/fs operations, and removes the container on destroy", async () => {
    const fakeSpawn = createFakeSpawnHandle({
      stdout: ['{"jsonrpc":"2.0","id":1}\n'],
      stderr: [],
      exitCode: 0,
    });
    const { runner, calls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        if (args[0] === "run") {
          return { exitCode: 0, stdout: "container-id-123\n", stderr: "" };
        }
        if (args[0] === "exec") {
          return { exitCode: 0, stdout: "ok-output\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      onSpawn: () => fakeSpawn,
    });

    const provider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: { mode: "none" },
      limits: { cpus: 2, memoryMb: 1024, pidsLimit: 256 },
      runner,
      resolveRealPath: identityRealPath,
    });

    expect(provider.capabilities()).toMatchObject({
      fs: true,
      exec: true,
      backgroundProcesses: true,
      writableStdin: true,
      killableProcesses: true,
      networkPolicy: true,
    });

    const handle = await provider.create({ id: "sess-1" });
    expect(handle.provider).toBe("docker");
    expect(handle.workspaceRoot).toBe("/workspace");

    const execResult = await handle.process.exec("echo hi");
    expect(execResult).toEqual({ exitCode: 0, stdout: "ok-output\n", stderr: "" });

    const spawned = await handle.process.spawn("agy acp --stdio");
    await spawned.stdin.write('{"jsonrpc":"2.0"}\n');
    await spawned.stdin.end();
    const lines: string[] = [];
    for await (const chunk of spawned.stdout) {
      lines.push(chunk);
    }
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1}\n']);
    expect(fakeSpawn.writes).toEqual(['{"jsonrpc":"2.0"}\n']);
    expect(await spawned.wait()).toBe(0);

    await handle.destroy();
    const rmCall = calls.find((call) => call.args[0] === "rm");
    expect(rmCall?.args).toEqual(["rm", "-f", handle.id]);
  });

  it("refuses to create a container when isolation enforcement probe fails", async () => {
    const { runner, calls } = createFakeCommandRunner({
      onExec: () => ({
        exitCode: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock",
      }),
    });

    const provider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: { mode: "none" },
      limits: { cpus: 2, memoryMb: 1024, pidsLimit: 256 },
      runner,
      resolveRealPath: identityRealPath,
    });

    let caught: unknown;
    try {
      await provider.create({ id: "sess-blocked" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SandboxControlError);
    expect((caught as SandboxControlError).code).toBe("docker.isolation_unverified");
    expect(calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("executes a one-shot SandboxRequest through createDockerSandbox and enforces timeout cleanup", async () => {
    const { runner, calls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "hello world", stderr: "" };
      },
    });

    const sandbox = createDockerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner,
      now: () => 1000,
      resolveRealPath: identityRealPath,
    });

    const result = await sandbox.execute({
      command: "echo",
      args: ["hello world"],
      timeoutMs: 5000,
      network: "none",
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello world",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    });
    const runCall = calls.find((call) => call.args[0] === "run");
    expect(runCall?.args).toContain("--rm");
    expect(runCall?.args).toContain("--cap-drop=ALL");
    expect(runCall?.args).toContain("--security-opt=no-new-privileges:true");
    expect(runCall?.args).toContain("--network=none");
  });

  it("rejects unapproved host bind paths in createDockerSandbox readonlyPaths and writablePaths", async () => {
    const { runner, calls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const sandbox = createDockerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      allowedWorkspaceRoots: ["/srv/der/workspaces/sess-1"],
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner,
      resolveRealPath: identityRealPath,
    });

    let caughtOutside: unknown;
    try {
      await sandbox.execute({
        command: "cat",
        args: ["/mnt/ro-0/passwd"],
        readonlyPaths: ["/etc/passwd"],
        timeoutMs: 2000,
        network: "none",
      });
    } catch (error) {
      caughtOutside = error;
    }
    expect(caughtOutside).toBeInstanceOf(SandboxControlError);
    expect((caughtOutside as SandboxControlError).code).toBe("docker.bind_path_outside_root");

    let caughtTraversal: unknown;
    try {
      await sandbox.execute({
        command: "ls",
        args: ["/mnt/rw-0"],
        writablePaths: ["/srv/der/workspaces/sess-1/../../etc"],
        timeoutMs: 2000,
        network: "none",
      });
    } catch (error) {
      caughtTraversal = error;
    }
    expect(caughtTraversal).toBeInstanceOf(SandboxControlError);
    expect((caughtTraversal as SandboxControlError).code).toBe("docker.invalid_workspace_mount");
    expect(calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("verifies scoped egress network existence and internal isolation on probe and launch", async () => {
    const { runner: unisolatedRunner } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Name: "der-egress-codex",
              Driver: "bridge",
              Internal: false,
              Options: {},
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });

    const badReport = await probeDockerEgressNetwork({
      dockerHost: "unix:///run/user/1000/docker.sock",
      networkName: "der-egress-codex",
      engine: "codex",
      allowedHosts: ["api.openai.com"],
      runner: unisolatedRunner,
    });
    expect(badReport.verified).toBe(false);
    expect(badReport.reasons.join("\n")).toContain("Internal=true");
    expect(badReport.reasons.join("\n")).toContain("der.egress.allowed_hosts");

    const blockedSandbox = createDockerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      egressNetwork: {
        networkName: "der-egress-codex",
        allowedHosts: ["api.openai.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner: unisolatedRunner,
      resolveRealPath: identityRealPath,
    });

    let caughtEgress: unknown;
    try {
      await blockedSandbox.execute({
        command: "echo",
        args: ["hi"],
        timeoutMs: 2000,
        network: "scoped_egress",
      });
    } catch (error) {
      caughtEgress = error;
    }
    expect(caughtEgress).toBeInstanceOf(SandboxControlError);
    expect((caughtEgress as SandboxControlError).code).toBe("docker.egress_network_unverified");

    const { runner: isolatedRunner, calls: isolatedCalls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Name: "der-egress-codex",
              Driver: "bridge",
              Internal: true,
              Options: {},
              Labels: {
                "der.egress.allowed_hosts": "api.openai.com,auth.openai.com",
              },
              Containers: {
                cid1: {
                  Name: "egress-proxy",
                  IPv4Address: "172.22.0.2/16",
                  IPv6Address: "",
                },
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "isolated-ok", stderr: "" };
      },
    });

    const allowedSandbox = createDockerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      egressNetwork: {
        networkName: "der-egress-codex",
        allowedHosts: ["api.openai.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner: isolatedRunner,
      now: () => 1000,
      resolveRealPath: identityRealPath,
    });

    const result = await allowedSandbox.execute({
      command: "echo",
      args: ["hi"],
      timeoutMs: 2000,
      network: "scoped_egress",
    });
    expect(result.exitCode).toBe(0);
    expect(
      isolatedCalls.some((call) => call.args[0] === "network" && call.args[1] === "inspect"),
    ).toBe(true);
    const runArgs = isolatedCalls.find((call) => call.args[0] === "run")?.args;
    expect(runArgs).toContain("--network=der-egress-codex");
    expect(runArgs).toContain("HTTP_PROXY=http://egress-proxy:3128");
    expect(runArgs).toContain("HTTPS_PROXY=http://egress-proxy:3128");
  });

  it.each([
    {
      name: "missing der.egress.allowed_hosts label",
      labels: {},
      allowedHosts: ["api.openai.com"],
      expectedReason: /missing required label "der\.egress\.allowed_hosts"/,
    },
    {
      name: "unapproved host in der.egress.allowed_hosts label",
      labels: { "der.egress.allowed_hosts": "api.openai.com,evil.example.com" },
      allowedHosts: ["api.openai.com"],
      expectedReason: /permits unapproved host "evil\.example\.com"/,
    },
    {
      name: "mismatched vendor host from another engine in label",
      labels: { "der.egress.allowed_hosts": "api.openai.com,api.anthropic.com" },
      allowedHosts: ["api.openai.com"],
      expectedReason: /permits unapproved host "api\.anthropic\.com"/,
    },
    {
      name: "label missing a requested approved host",
      labels: { "der.egress.allowed_hosts": "api.openai.com" },
      allowedHosts: ["api.openai.com", "chatgpt.com"],
      expectedReason: /does not cover requested host "chatgpt\.com"/,
    },
  ])(
    "fails closed when scoped egress network has $name",
    async ({ labels, allowedHosts, expectedReason }) => {
      const { runner, calls } = createFakeCommandRunner({
        onExec: (_cmd, args) => {
          if (args[0] === "info") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                ServerVersion: "29.10.0",
                SecurityOptions: ["name=rootless"],
                MemoryLimit: true,
                CpuCfsQuota: true,
                PidsLimit: true,
              }),
              stderr: "",
            };
          }
          if (args[0] === "network" && args[1] === "inspect") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Name: "der-egress-codex",
                Driver: "bridge",
                Internal: true,
                Options: {},
                Labels: labels,
                Containers: {
                  cid1: {
                    Name: "egress-proxy",
                    IPv4Address: "172.22.0.2/16",
                    IPv6Address: "",
                  },
                },
              }),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "should-not-run", stderr: "" };
        },
      });

      const report = await probeDockerEgressNetwork({
        dockerHost: "unix:///run/user/1000/docker.sock",
        networkName: "der-egress-codex",
        engine: "codex",
        allowedHosts,
        runner,
      });
      expect(report.verified).toBe(false);
      expect(report.reasons.join("\n")).toMatch(expectedReason);

      const provider = createHardenedDockerProvider({
        dockerHost: "unix:///run/user/1000/docker.sock",
        image: "der-engine-codex:pinned",
        engine: "codex",
        user: "1000:1000",
        workspaceHostPath: "/srv/der/workspaces/sess-1",
        shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
        network: {
          mode: "scoped_egress",
          networkName: "der-egress-codex",
          allowedHosts,
          egressProxyUrl: "http://egress-proxy:3128",
        },
        limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
        runner,
        resolveRealPath: identityRealPath,
      });

      let caught: unknown;
      try {
        await provider.create({ id: "sess-egress-blocked" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SandboxControlError);
      expect((caught as SandboxControlError).code).toBe("docker.egress_network_unverified");
      expect(calls.some((call) => call.args[0] === "run")).toBe(false);
    },
  );

  it("rejects a symlink inside an allowed root pointing outside the allowed root in Docker launcher and sandbox", async () => {
    const baseDir = mkdtempSync("/tmp/der-docker-symlink-");
    tempDirs.push(baseDir);
    const allowedRoot = join(baseDir, "allowed");
    const outsideDir = join(baseDir, "outside");
    const internalSubdir = join(allowedRoot, "real-sub");
    mkdirSync(internalSubdir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const escapeLink = join(allowedRoot, "escape-link");
    symlinkSync(outsideDir, escapeLink);
    const internalLink = join(allowedRoot, "internal-link");
    symlinkSync(internalSubdir, internalLink);

    const { runner, calls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });

    let caughtBuild: unknown;
    try {
      buildDockerRunArgs({
        containerName: "der-codex-symlink",
        image: "der-engine-codex:pinned",
        engine: "codex",
        user: "1000:1000",
        workspaceMount: { source: allowedRoot, target: "/workspace", readonly: false },
        allowedWorkspaceRoots: [allowedRoot],
        extraMounts: [{ type: "bind", source: escapeLink, target: "/mnt/ro-0", readonly: true }],
        shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
        network: { mode: "none" },
        limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
        dockerHost: "unix:///run/user/1000/docker.sock",
      });
    } catch (error) {
      caughtBuild = error;
    }
    expect(caughtBuild).toBeInstanceOf(SandboxControlError);
    expect((caughtBuild as SandboxControlError).code).toBe("docker.bind_path_outside_root");

    const sandbox = createDockerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: allowedRoot,
      allowedWorkspaceRoots: [allowedRoot],
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner,
      now: () => 1000,
    });

    let caughtSandbox: unknown;
    try {
      await sandbox.execute({
        command: "ls",
        args: ["/mnt/ro-0"],
        readonlyPaths: [escapeLink],
        timeoutMs: 2000,
        network: "none",
      });
    } catch (error) {
      caughtSandbox = error;
    }
    expect(caughtSandbox).toBeInstanceOf(SandboxControlError);
    expect((caughtSandbox as SandboxControlError).code).toBe("docker.bind_path_outside_root");

    const provider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: escapeLink,
      allowedWorkspaceRoots: [allowedRoot],
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: { mode: "none" },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner,
    });

    let caughtProvider: unknown;
    try {
      await provider.create({ id: "sess-symlink-escape" });
    } catch (error) {
      caughtProvider = error;
    }
    expect(caughtProvider).toBeInstanceOf(SandboxControlError);
    expect((caughtProvider as SandboxControlError).code).toBe("docker.bind_path_outside_root");

    let caughtMissing: unknown;
    try {
      buildDockerRunArgs({
        containerName: "der-codex-missing",
        image: "der-engine-codex:pinned",
        engine: "codex",
        user: "1000:1000",
        workspaceMount: { source: allowedRoot, target: "/workspace", readonly: false },
        allowedWorkspaceRoots: [allowedRoot],
        extraMounts: [
          {
            type: "bind",
            source: join(allowedRoot, "does-not-exist"),
            target: "/mnt/ro-0",
            readonly: true,
          },
        ],
        shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
        network: { mode: "none" },
        limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
        dockerHost: "unix:///run/user/1000/docker.sock",
      });
    } catch (error) {
      caughtMissing = error;
    }
    expect(caughtMissing).toBeInstanceOf(SandboxControlError);
    expect((caughtMissing as SandboxControlError).code).toBe("docker.invalid_workspace_mount");
    expect(calls.some((call) => call.args[0] === "run")).toBe(false);

    const internalArgs = buildDockerRunArgs({
      containerName: "der-codex-internal-link",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceMount: { source: allowedRoot, target: "/workspace", readonly: false },
      allowedWorkspaceRoots: [allowedRoot],
      extraMounts: [{ type: "bind", source: internalLink, target: "/mnt/ro-0", readonly: true }],
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: { mode: "none" },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      dockerHost: "unix:///run/user/1000/docker.sock",
    });
    expect(internalArgs).toContain(
      `type=bind,source=${realpathSync(internalSubdir)},target=/mnt/ro-0,readonly`,
    );
  });

  it("revalidates canonical bind-mount containment immediately before docker run after awaited probes", async () => {
    const baseDir = mkdtempSync("/tmp/der-docker-toctou-");
    tempDirs.push(baseDir);
    const allowedRoot = join(baseDir, "allowed");
    const outsideDir = join(baseDir, "outside");
    const targetDir = join(allowedRoot, "swapped");
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const { runner: providerRunner, calls: providerCalls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          rmSync(targetDir, { recursive: true, force: true });
          symlinkSync(outsideDir, targetDir);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "should-not-run", stderr: "" };
      },
    });

    const provider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: targetDir,
      allowedWorkspaceRoots: [allowedRoot],
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: { mode: "none" },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner: providerRunner,
    });

    let caughtProvider: unknown;
    try {
      await provider.create({ id: "sess-toctou-provider" });
    } catch (error) {
      caughtProvider = error;
    }
    expect(caughtProvider).toBeInstanceOf(SandboxControlError);
    expect((caughtProvider as SandboxControlError).code).toBe("docker.bind_path_outside_root");
    expect(providerCalls.some((call) => call.args[0] === "run")).toBe(false);

    const sandboxMountDir = join(allowedRoot, "sandbox-swapped");
    mkdirSync(sandboxMountDir, { recursive: true });
    const { runner: sandboxRunner, calls: sandboxCalls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          };
        }
        if (args[0] === "network" && args[1] === "inspect") {
          rmSync(sandboxMountDir, { recursive: true, force: true });
          symlinkSync(outsideDir, sandboxMountDir);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Name: "der-egress-codex",
              Driver: "bridge",
              Internal: true,
              Options: {},
              Labels: { "der.egress.allowed_hosts": "api.openai.com" },
              Containers: {
                cid1: {
                  Name: "egress-proxy",
                  IPv4Address: "172.22.0.2/16",
                  IPv6Address: "",
                },
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "should-not-run", stderr: "" };
      },
    });

    const sandbox = createDockerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: allowedRoot,
      allowedWorkspaceRoots: [allowedRoot],
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      egressNetwork: {
        networkName: "der-egress-codex",
        allowedHosts: ["api.openai.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner: sandboxRunner,
    });

    let caughtSandbox: unknown;
    try {
      await sandbox.execute({
        command: "ls",
        args: ["/mnt/ro-0"],
        readonlyPaths: [sandboxMountDir],
        timeoutMs: 2000,
        network: "scoped_egress",
      });
    } catch (error) {
      caughtSandbox = error;
    }
    expect(caughtSandbox).toBeInstanceOf(SandboxControlError);
    expect((caughtSandbox as SandboxControlError).code).toBe("docker.bind_path_outside_root");
    expect(sandboxCalls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("always probes scoped egress when verifyIsolationOnCreate is false and enforces non-loopback proxy attachment in Containers metadata", async () => {
    const makeNetworkRunner = (containers: Record<string, unknown>) =>
      createFakeCommandRunner({
        onExec: (_cmd, args) => {
          if (args[0] === "network" && args[1] === "inspect") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                Name: "der-egress-codex",
                Driver: "bridge",
                Internal: true,
                Options: {},
                Labels: { "der.egress.allowed_hosts": "api.openai.com" },
                Containers: containers,
              }),
              stderr: "",
            };
          }
          return { exitCode: 0, stdout: "container-egress-ok\n", stderr: "" };
        },
      });

    const { runner: emptyContainersRunner, calls: emptyCalls } = makeNetworkRunner({});
    const blockedEmptyProvider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: {
        mode: "scoped_egress",
        networkName: "der-egress-codex",
        allowedHosts: ["api.openai.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner: emptyContainersRunner,
      verifyIsolationOnCreate: false,
      resolveRealPath: identityRealPath,
    });

    let caughtEmpty: unknown;
    try {
      await blockedEmptyProvider.create({ id: "sess-no-containers" });
    } catch (error) {
      caughtEmpty = error;
    }
    expect(caughtEmpty).toBeInstanceOf(SandboxControlError);
    expect((caughtEmpty as SandboxControlError).code).toBe("docker.egress_network_unverified");
    expect(emptyCalls.some((call) => call.args[0] === "info")).toBe(false);
    expect(
      emptyCalls.some((call) => call.args[0] === "network" && call.args[1] === "inspect"),
    ).toBe(true);
    expect(emptyCalls.some((call) => call.args[0] === "run")).toBe(false);

    const { runner: wrongContainerRunner } = makeNetworkRunner({
      cid1: { Name: "unrelated-sidecar", IPv4Address: "172.22.0.5/16", IPv6Address: "" },
    });
    const wrongProxyReport = await probeDockerEgressNetwork({
      dockerHost: "unix:///run/user/1000/docker.sock",
      networkName: "der-egress-codex",
      engine: "codex",
      allowedHosts: ["api.openai.com"],
      egressProxyUrl: "http://egress-proxy:3128",
      runner: wrongContainerRunner,
    });
    expect(wrongProxyReport.verified).toBe(false);
    expect(wrongProxyReport.reasons.join("\n")).toContain('Egress proxy host "egress-proxy"');

    const loopbackProxyReport = await probeDockerEgressNetwork({
      dockerHost: "unix:///run/user/1000/docker.sock",
      networkName: "der-egress-codex",
      engine: "codex",
      allowedHosts: ["api.openai.com"],
      egressProxyUrl: "http://127.0.0.1:3128",
      runner: wrongContainerRunner,
    });
    expect(loopbackProxyReport.verified).toBe(false);
    expect(loopbackProxyReport.reasons.join("\n")).toMatch(/non-loopback/i);

    const { runner: attachedRunner, calls: attachedCalls } = makeNetworkRunner({
      cid1: { Name: "egress-proxy", IPv4Address: "172.22.0.2/16", IPv6Address: "" },
    });
    const attachedProvider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: {
        mode: "scoped_egress",
        networkName: "der-egress-codex",
        allowedHosts: ["api.openai.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner: attachedRunner,
      verifyIsolationOnCreate: false,
      resolveRealPath: identityRealPath,
    });

    const handle = await attachedProvider.create({ id: "sess-attached-proxy" });
    expect(handle.id).toBe("container-egress-ok");
    expect(
      attachedCalls.some((call) => call.args[0] === "network" && call.args[1] === "inspect"),
    ).toBe(true);
    expect(attachedCalls.some((call) => call.args[0] === "run")).toBe(true);
  });

  it("fails closed when Docker network inspect omits Containers metadata for scoped egress proxy verification", async () => {
    const { runner, calls } = createFakeCommandRunner({
      onExec: (_cmd, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Name: "der-egress-codex",
              Driver: "bridge",
              Internal: true,
              Options: {},
              Labels: { "der.egress.allowed_hosts": "api.openai.com" },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "should-not-run", stderr: "" };
      },
    });

    const report = await probeDockerEgressNetwork({
      dockerHost: "unix:///run/user/1000/docker.sock",
      networkName: "der-egress-codex",
      engine: "codex",
      allowedHosts: ["api.openai.com"],
      egressProxyUrl: "http://egress-proxy:3128",
      runner,
    });
    expect(report.verified).toBe(false);
    expect(report.reasons.join("\n")).toContain("Containers");

    const provider = createHardenedDockerProvider({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-engine-codex:pinned",
      engine: "codex",
      user: "1000:1000",
      workspaceHostPath: "/srv/der/workspaces/sess-1",
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      network: {
        mode: "scoped_egress",
        networkName: "der-egress-codex",
        allowedHosts: ["api.openai.com"],
        egressProxyUrl: "http://egress-proxy:3128",
      },
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      runner,
      verifyIsolationOnCreate: false,
      resolveRealPath: identityRealPath,
    });

    let caught: unknown;
    try {
      await provider.create({ id: "sess-missing-containers" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxControlError);
    expect((caught as SandboxControlError).code).toBe("docker.egress_network_unverified");
    expect(calls.some((call) => call.args[0] === "run")).toBe(false);
  });
});
