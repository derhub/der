import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDockerWasmerSandbox,
  createSdkWasmerDriver,
  createWasmerSandbox,
  SandboxControlError,
  validateWasmerDirectoryGrants,
  validateWasmerGuestPin,
  WASMER_RUNNER_CONTRACT,
  type CommandExecOptions,
  type CommandExecResult,
  type CommandRunner,
  type WasmerDriver,
  type WasmerGuestInstance,
  type WasmerGuestPin,
  type WasmerLaunchConfig,
  type WasmerRunOutput,
} from "../../src/sandbox/index";

const tempDirs: string[] = [];
const identityRealPath = (path: string): string => path;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface RecordedWasmerLaunch {
  readonly config: WasmerLaunchConfig;
  readonly command: string;
  readonly args: readonly string[];
  closed: boolean;
}

function createFakeWasmerDriver(
  runHandler: (launch: RecordedWasmerLaunch) => Promise<WasmerRunOutput> | WasmerRunOutput,
): { readonly driver: WasmerDriver; readonly launches: RecordedWasmerLaunch[] } {
  const launches: RecordedWasmerLaunch[] = [];
  const driver: WasmerDriver = {
    async createInstance(config: WasmerLaunchConfig): Promise<WasmerGuestInstance> {
      const record: RecordedWasmerLaunch = {
        config,
        command: "",
        args: [],
        closed: false,
      };
      launches.push(record);
      return {
        async run(input) {
          const updated: RecordedWasmerLaunch = {
            ...record,
            command: input.command,
            args: [...input.args],
          };
          launches[launches.length - 1] = updated;
          return runHandler(updated);
        },
        async close() {
          const current = launches[launches.length - 1];
          if (current) {
            current.closed = true;
          }
          record.closed = true;
        },
      };
    },
  };
  return { driver, launches };
}

describe("define and validate the Wasmer runner contract for ticket 5", () => {
  it("exposes image target, Dockerfile path, runner entrypoint, and pinned bash/python guests", () => {
    expect(WASMER_RUNNER_CONTRACT.imageTarget).toBe("der-wasmer-runner");
    expect(WASMER_RUNNER_CONTRACT.dockerfilePath).toBe("docker/Dockerfile.wasmer");
    expect(WASMER_RUNNER_CONTRACT.runnerEntrypoint.length).toBeGreaterThan(0);
    expect(WASMER_RUNNER_CONTRACT.guests.bash).toEqual({
      guest: "bash",
      packageRef: "wasmer/bash@1.0.25",
      version: "1.0.25",
      digest: "sha256:059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
      commandName: "bash",
      artifactPath: "/guests/bash-1.0.25.webc",
      abi: "wasix",
    });
    expect(WASMER_RUNNER_CONTRACT.guests.python).toEqual({
      guest: "python",
      packageRef: "python/python@3.13.20",
      version: "3.13.20",
      digest: "sha256:a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7",
      commandName: "python",
      artifactPath: "/guests/python-3.13.20.webc",
      abi: "wasix",
    });

    expect(() => validateWasmerGuestPin(WASMER_RUNNER_CONTRACT.guests.bash)).not.toThrow();
    expect(() => validateWasmerGuestPin(WASMER_RUNNER_CONTRACT.guests.python)).not.toThrow();
  });

  it.each([
    {
      name: "floating latest version",
      pin: {
        ...WASMER_RUNNER_CONTRACT.guests.bash,
        version: "latest",
      },
      expectedCode: "wasmer.unpinned_guest",
    },
    {
      name: "missing sha256 digest",
      pin: {
        ...WASMER_RUNNER_CONTRACT.guests.python,
        digest: "md5:1234",
      },
      expectedCode: "wasmer.unpinned_guest",
    },
    {
      name: "floating package ref tag",
      pin: {
        ...WASMER_RUNNER_CONTRACT.guests.bash,
        packageRef: "sharrattj/bash@latest",
      },
      expectedCode: "wasmer.unpinned_guest",
    },
  ])("rejects invalid guest pin: $name", ({ pin, expectedCode }) => {
    let caught: unknown;
    try {
      validateWasmerGuestPin(pin as WasmerGuestPin);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxControlError);
    expect((caught as SandboxControlError).code).toBe(expectedCode);
  });
});

describe("validate explicit Wasmer directory grants", () => {
  it("accepts explicit readonly and writable paths under allowed host roots", () => {
    const grants = validateWasmerDirectoryGrants(
      {
        readonlyPaths: ["/srv/der/workspaces/sess-1/input"],
        writablePaths: ["/srv/der/workspaces/sess-1/out"],
      },
      { allowedHostRoots: ["/srv/der/workspaces"], resolveRealPath: identityRealPath },
    );

    expect(grants).toEqual([
      {
        hostPath: "/srv/der/workspaces/sess-1/input",
        guestPath: "/workspace/mnt/ro-0",
        access: "readonly",
      },
      {
        hostPath: "/srv/der/workspaces/sess-1/out",
        guestPath: "/workspace/mnt/rw-0",
        access: "readwrite",
      },
    ]);
  });

  it.each([
    {
      name: "parent traversal segment",
      paths: { readonlyPaths: ["/srv/der/workspaces/../etc/passwd"] },
      expectedCode: "wasmer.invalid_directory_grant",
    },
    {
      name: "path outside allowed host root",
      paths: { readonlyPaths: ["/etc"] },
      expectedCode: "wasmer.directory_outside_root",
    },
    {
      name: "docker daemon socket path",
      paths: { readonlyPaths: ["/run/user/1000/docker.sock"] },
      expectedCode: "wasmer.forbidden_path",
    },
    {
      name: "host home directory",
      paths: { writablePaths: ["/home/alice/.ssh"] },
      expectedCode: "wasmer.forbidden_path",
    },
  ])("rejects unsafe directory grant: $name", ({ paths, expectedCode }) => {
    let caught: unknown;
    try {
      validateWasmerDirectoryGrants(paths, {
        allowedHostRoots: ["/srv/der/workspaces"],
        resolveRealPath: identityRealPath,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxControlError);
    expect((caught as SandboxControlError).code).toBe(expectedCode);
  });
});

describe("run pinned Bash and Python WASI/WASIX guests in a short-lived Wasmer sandbox", () => {
  it("executes pinned bash and python guests with network disabled, explicit grants only, and deterministic cleanup", async () => {
    const { driver, launches } = createFakeWasmerDriver((launch) => ({
      exitCode: 0,
      stdout: `${launch.config.guestPin.guest}:${launch.args.join(" ")}`,
      stderr: "",
      timedOut: false,
    }));

    const sandbox = createWasmerSandbox({
      driver,
      allowedHostRoots: ["/srv/der/workspaces"],
      maxTimeoutMs: 10_000,
      maxOutputBytes: 4096,
      now: () => 5000,
      resolveRealPath: identityRealPath,
    });

    const bashResult = await sandbox.execute({
      command: "bash",
      args: ["-c", "echo hi"],
      readonlyPaths: ["/srv/der/workspaces/sess-1/ro"],
      writablePaths: ["/srv/der/workspaces/sess-1/rw"],
      timeoutMs: 3000,
      network: "none",
    });

    expect(bashResult).toEqual({
      exitCode: 0,
      stdout: "bash:-c echo hi",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    });

    const pyResult = await sandbox.execute({
      command: "python",
      args: ["-c", "print(42)"],
      timeoutMs: 3000,
      network: "none",
    });

    expect(pyResult.stdout).toBe("python:-c print(42)");
    expect(launches).toHaveLength(2);
    expect(launches[0]?.config.networkMode).toBe("disabled");
    expect(launches[0]?.config.directoryGrants).toEqual([
      {
        hostPath: "/srv/der/workspaces/sess-1/ro",
        guestPath: "/workspace/mnt/ro-0",
        access: "readonly",
      },
      {
        hostPath: "/srv/der/workspaces/sess-1/rw",
        guestPath: "/workspace/mnt/rw-0",
        access: "readwrite",
      },
    ]);
    expect(launches[1]?.config.directoryGrants).toEqual([]);
    expect(launches.every((launch) => launch.closed)).toBe(true);
    expect(sandbox.activeSandboxCount()).toBe(0);
  });

  it("denies network access and unknown unpinned commands", async () => {
    const { driver, launches } = createFakeWasmerDriver(() => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }));
    const sandbox = createWasmerSandbox({
      driver,
      allowedHostRoots: ["/srv/der/workspaces"],
    });

    let networkError: unknown;
    try {
      await sandbox.execute({
        command: "bash",
        args: ["-c", "curl https://example.com"],
        timeoutMs: 1000,
        network: "scoped_egress",
      });
    } catch (error) {
      networkError = error;
    }
    expect(networkError).toBeInstanceOf(SandboxControlError);
    expect((networkError as SandboxControlError).code).toBe("wasmer.network_forbidden");

    let guestError: unknown;
    try {
      await sandbox.execute({
        command: "ruby",
        args: ["-e", "puts 1"],
        timeoutMs: 1000,
        network: "none",
      });
    } catch (error) {
      guestError = error;
    }
    expect(guestError).toBeInstanceOf(SandboxControlError);
    expect((guestError as SandboxControlError).code).toBe("wasmer.unsupported_guest");
    expect(launches).toHaveLength(0);
  });

  it("bounds output, reports timeout, and always cleans up the guest sandbox on failure", async () => {
    const { driver, launches } = createFakeWasmerDriver(() => ({
      exitCode: 124,
      stdout: "x".repeat(500),
      stderr: "timed out",
      timedOut: true,
    }));

    const sandbox = createWasmerSandbox({
      driver,
      allowedHostRoots: ["/srv/der/workspaces"],
      maxTimeoutMs: 2000,
      maxOutputBytes: 64,
    });

    const result = await sandbox.execute({
      command: "python",
      args: ["-c", "while True: pass"],
      timeoutMs: 60_000,
      network: "none",
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(64);
    expect(launches[0]?.config.timeoutMs).toBe(2000);
    expect(launches[0]?.closed).toBe(true);
    expect(sandbox.activeSandboxCount()).toBe(0);

    const { driver: failingDriver, launches: failingLaunches } = createFakeWasmerDriver(() => {
      throw new Error("guest trap");
    });
    const failingSandbox = createWasmerSandbox({
      driver: failingDriver,
      allowedHostRoots: ["/srv/der/workspaces"],
    });

    let trapError: unknown;
    try {
      await failingSandbox.execute({
        command: "bash",
        args: ["-c", "exit 1"],
        timeoutMs: 1000,
        network: "none",
      });
    } catch (error) {
      trapError = error;
    }
    expect(trapError).toBeInstanceOf(Error);
    expect((trapError as Error).message).toBe("guest trap");
    expect(failingLaunches[0]?.closed).toBe(true);
    expect(failingSandbox.activeSandboxCount()).toBe(0);
  });

  it("fails closed without registry fallback when local .webc artifact is missing or digest mismatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "der-wasmer-digest-"));
    tempDirs.push(dir);
    const tamperedPath = join(dir, "bash-1.0.25.webc");
    writeFileSync(tamperedPath, "not-the-pinned-webc-bytes", "utf8");

    const driver = createSdkWasmerDriver();
    const tamperedPin: WasmerGuestPin = {
      ...WASMER_RUNNER_CONTRACT.guests.bash,
      artifactPath: tamperedPath,
    };

    let mismatchError: unknown;
    try {
      await driver.createInstance({
        guestPin: tamperedPin,
        networkMode: "disabled",
        directoryGrants: [],
        env: {},
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      });
    } catch (error) {
      mismatchError = error;
    }
    expect(mismatchError).toBeInstanceOf(SandboxControlError);
    expect((mismatchError as SandboxControlError).code).toBe("wasmer.digest_mismatch");

    const missingPin: WasmerGuestPin = {
      ...WASMER_RUNNER_CONTRACT.guests.python,
      artifactPath: join(dir, "does-not-exist.webc"),
    };

    let missingError: unknown;
    try {
      await driver.createInstance({
        guestPin: missingPin,
        networkMode: "disabled",
        directoryGrants: [],
        env: {},
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      });
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(SandboxControlError);
    expect((missingError as SandboxControlError).code).toBe("wasmer.artifact_missing");
  });

  it("dispatches production wasmer execution inside the constrained der-wasmer-runner container", async () => {
    const recorded: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly options?: CommandExecOptions;
    }> = [];

    const fakeRunner: CommandRunner = {
      async exec(command, args, options): Promise<CommandExecResult> {
        recorded.push({ command, args: [...args], ...(options ? { options } : {}) });
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
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            exitCode: 0,
            stdout: "42\n",
            stderr: "",
            timedOut: false,
            durationMs: 12,
          }),
          stderr: "",
        };
      },
      async spawn() {
        throw new Error("spawn not expected");
      },
    };

    const sandbox = createDockerWasmerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      image: "der-wasmer-runner:latest",
      user: "1000:1000",
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      allowedHostRoots: ["/srv/der/workspaces"],
      maxTimeoutMs: 5000,
      runner: fakeRunner,
      now: () => 1000,
      resolveRealPath: identityRealPath,
    });

    const result = await sandbox.execute({
      command: "python",
      args: ["-c", "print(42)"],
      readonlyPaths: ["/srv/der/workspaces/sess-1/ro"],
      writablePaths: ["/srv/der/workspaces/sess-1/rw"],
      timeoutMs: 3000,
      network: "none",
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "42\n",
      stderr: "",
      timedOut: false,
      durationMs: 12,
    });

    const runCall = recorded.find((entry) => entry.args[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall?.args).toContain("--rm");
    expect(runCall?.args).toContain("--network=none");
    expect(runCall?.args).toContain("--read-only");
    expect(runCall?.args).toContain("--cap-drop=ALL");
    expect(runCall?.args).toContain("--security-opt=no-new-privileges:true");
    expect(runCall?.args).toContain("--cpus=1");
    expect(runCall?.args).toContain("--memory=512m");
    expect(runCall?.args).toContain("--pids-limit=128");
    expect(runCall?.args).toContain(
      "type=bind,source=/srv/der/workspaces/sess-1/ro,target=/work/ro-0,readonly",
    );
    expect(runCall?.args).toContain(
      "type=bind,source=/srv/der/workspaces/sess-1/rw,target=/work/rw-0",
    );
    expect(runCall?.args).toContain("der-wasmer-runner:latest");
    expect(JSON.parse(String(runCall?.options?.stdin))).toEqual({
      command: "python",
      args: ["-c", "print(42)"],
      readonlyPaths: ["/work/ro-0"],
      writablePaths: ["/work/rw-0"],
      timeoutMs: 3000,
      network: "none",
    });
  });

  it("rejects a symlink inside an allowed host root pointing outside the root in Wasmer contract, runner, and Docker Wasmer sandbox", async () => {
    const baseDir = mkdtempSync("/tmp/der-wasmer-symlink-");
    tempDirs.push(baseDir);
    const allowedRoot = join(baseDir, "allowed");
    const outsideDir = join(baseDir, "outside");
    const internalSubdir = join(allowedRoot, "safe");
    mkdirSync(internalSubdir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const escapeLink = join(allowedRoot, "escape-link");
    symlinkSync(outsideDir, escapeLink);
    const internalLink = join(allowedRoot, "internal-link");
    symlinkSync(internalSubdir, internalLink);

    let caughtGrant: unknown;
    try {
      validateWasmerDirectoryGrants(
        { readonlyPaths: [escapeLink] },
        { allowedHostRoots: [allowedRoot] },
      );
    } catch (error) {
      caughtGrant = error;
    }
    expect(caughtGrant).toBeInstanceOf(SandboxControlError);
    expect((caughtGrant as SandboxControlError).code).toBe("wasmer.directory_outside_root");

    const { driver, launches } = createFakeWasmerDriver(() => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    }));
    const wasmerSandbox = createWasmerSandbox({
      driver,
      allowedHostRoots: [allowedRoot],
    });

    let caughtWasmer: unknown;
    try {
      await wasmerSandbox.execute({
        command: "bash",
        args: ["-c", "ls"],
        writablePaths: [escapeLink],
        timeoutMs: 2000,
        network: "none",
      });
    } catch (error) {
      caughtWasmer = error;
    }
    expect(caughtWasmer).toBeInstanceOf(SandboxControlError);
    expect((caughtWasmer as SandboxControlError).code).toBe("wasmer.directory_outside_root");
    expect(launches).toHaveLength(0);

    const recorded: string[][] = [];
    const fakeRunner: CommandRunner = {
      async exec(_command, args): Promise<CommandExecResult> {
        recorded.push([...args]);
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
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            exitCode: 0,
            stdout: "ok",
            stderr: "",
            timedOut: false,
            durationMs: 1,
          }),
          stderr: "",
        };
      },
      async spawn() {
        throw new Error("spawn not expected");
      },
    };

    const dockerWasmer = createDockerWasmerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      user: "1000:1000",
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      allowedHostRoots: [allowedRoot],
      runner: fakeRunner,
    });

    let caughtDockerWasmer: unknown;
    try {
      await dockerWasmer.execute({
        command: "bash",
        args: ["-c", "ls"],
        readonlyPaths: [escapeLink],
        timeoutMs: 2000,
        network: "none",
      });
    } catch (error) {
      caughtDockerWasmer = error;
    }
    expect(caughtDockerWasmer).toBeInstanceOf(SandboxControlError);
    expect((caughtDockerWasmer as SandboxControlError).code).toBe("wasmer.directory_outside_root");

    let caughtMissing: unknown;
    try {
      validateWasmerDirectoryGrants(
        { readonlyPaths: [join(allowedRoot, "does-not-exist")] },
        { allowedHostRoots: [allowedRoot] },
      );
    } catch (error) {
      caughtMissing = error;
    }
    expect(caughtMissing).toBeInstanceOf(SandboxControlError);
    expect((caughtMissing as SandboxControlError).code).toBe("wasmer.invalid_directory_grant");
    expect(recorded.some((args) => args[0] === "run")).toBe(false);

    await dockerWasmer.execute({
      command: "bash",
      args: ["-c", "ls"],
      readonlyPaths: [internalLink],
      timeoutMs: 2000,
      network: "none",
    });
    const runCall = recorded.find((args) => args[0] === "run");
    expect(runCall).toContain(
      `type=bind,source=${realpathSync(internalSubdir)},target=/work/ro-0,readonly`,
    );
  });

  it("revalidates canonical Wasmer directory grants immediately before docker run after the awaited isolation probe", async () => {
    const baseDir = mkdtempSync("/tmp/der-wasmer-toctou-");
    tempDirs.push(baseDir);
    const allowedRoot = join(baseDir, "allowed");
    const outsideDir = join(baseDir, "outside");
    const swappedDir = join(allowedRoot, "swapped");
    mkdirSync(swappedDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const recorded: string[][] = [];
    const fakeRunner: CommandRunner = {
      async exec(_command, args): Promise<CommandExecResult> {
        recorded.push([...args]);
        if (args[0] === "info") {
          rmSync(swappedDir, { recursive: true, force: true });
          symlinkSync(outsideDir, swappedDir);
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
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            exitCode: 0,
            stdout: "should-not-run",
            stderr: "",
            timedOut: false,
            durationMs: 1,
          }),
          stderr: "",
        };
      },
      async spawn() {
        throw new Error("spawn not expected");
      },
    };

    const dockerWasmer = createDockerWasmerSandbox({
      dockerHost: "unix:///run/user/1000/docker.sock",
      user: "1000:1000",
      limits: { cpus: 1, memoryMb: 512, pidsLimit: 128 },
      allowedHostRoots: [allowedRoot],
      runner: fakeRunner,
    });

    let caught: unknown;
    try {
      await dockerWasmer.execute({
        command: "bash",
        args: ["-c", "ls"],
        readonlyPaths: [swappedDir],
        timeoutMs: 2000,
        network: "none",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxControlError);
    expect((caught as SandboxControlError).code).toBe("wasmer.directory_outside_root");
    expect(recorded.some((args) => args[0] === "run")).toBe(false);
  });
});
