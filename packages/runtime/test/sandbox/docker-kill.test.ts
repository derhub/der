import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import {
  bunCommandRunner,
  createHardenedDockerProvider,
  DEFAULT_ENGINE_SHADOW_HOMES,
  probeDockerIsolation,
  SandboxControlError,
} from "@der/runtime/sandbox";

const IMAGE = "alpine:3.22";
const socketPath =
  process.env["DER_ROOTLESS_DOCKER_SOCKET"] ?? `/run/user/${process.getuid?.() ?? 0}/docker.sock`;
const dockerHost = `unix://${socketPath}`;

async function daemonReady(): Promise<boolean> {
  if (!existsSync(socketPath)) {
    return false;
  }
  const probe = await probeDockerIsolation({ dockerHost, runner: bunCommandRunner });
  if (!probe.isolationVerified) {
    return false;
  }
  const image = await bunCommandRunner.exec("docker", ["image", "inspect", IMAGE], {
    env: { DOCKER_HOST: dockerHost },
  });
  return image.exitCode === 0;
}

const ready = await daemonReady();

function docker(...args: string[]) {
  return bunCommandRunner.exec("docker", args, { env: { DOCKER_HOST: dockerHost } });
}

async function sleepPids(containerId: string): Promise<string[]> {
  const result = await docker("exec", containerId, "pgrep", "-f", "sleep 600");
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await Bun.sleep(100);
  }
  return condition();
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function createSandbox(): Promise<SandboxHandle> {
  const workspace = mkdtempSync(join(tmpdir(), "der-kill-"));
  chmodSync(workspace, 0o755);
  const volumeName = `der-kill-home-${crypto.randomUUID().slice(0, 8)}`;
  const provider = createHardenedDockerProvider({
    dockerHost,
    image: IMAGE,
    engine: "codex",
    user: "1000:1000",
    workspaceHostPath: realpathSync(workspace),
    shadowHome: { ...DEFAULT_ENGINE_SHADOW_HOMES.codex, volumeName },
    network: { mode: "none" },
    limits: { cpus: 1, memoryMb: 256, pidsLimit: 64 },
  });
  const handle = await provider.create({ id: `kill-${crypto.randomUUID().slice(0, 8)}` });
  cleanups.push(async () => {
    await docker("rm", "-f", handle.id);
    await docker("volume", "rm", "-f", volumeName);
    rmSync(workspace, { recursive: true, force: true });
  });
  return handle;
}

describe.skipIf(!ready)("kill a spawned process inside a real rootless container", () => {
  it("ends the process and its child after kill()", async () => {
    const handle = await createSandbox();
    const spawned = await handle.process.spawn("sleep 600 & sleep 600");
    expect(await waitFor(async () => (await sleepPids(handle.id)).length >= 2, 10_000)).toBe(true);

    await spawned.kill();
    await spawned.wait();

    expect(await waitFor(async () => (await sleepPids(handle.id)).length === 0, 5_000)).toBe(true);
  }, 30_000);

  it("ends the process and its child after the abort signal fires", async () => {
    const handle = await createSandbox();
    const controller = new AbortController();
    const spawned = await handle.process.spawn("sleep 600 & sleep 600", {
      signal: controller.signal,
    });
    expect(await waitFor(async () => (await sleepPids(handle.id)).length >= 2, 10_000)).toBe(true);

    controller.abort();
    await spawned.wait();

    expect(await waitFor(async () => (await sleepPids(handle.id)).length === 0, 5_000)).toBe(true);
  }, 30_000);

  it("rejects kill() when the process ignores the signal and stays alive", async () => {
    const handle = await createSandbox();
    const spawned = await handle.process.spawn("trap '' TERM; sleep 600 & sleep 600");
    expect(await waitFor(async () => (await sleepPids(handle.id)).length >= 2, 10_000)).toBe(true);

    const failure = await spawned.kill("SIGTERM").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxControlError);
    expect((failure as SandboxControlError).message).toContain(
      `Spawned process "trap '' TERM; sleep 600 & sleep 600" survived signal SIGTERM`,
    );
    expect((await sleepPids(handle.id)).length).toBe(2);

    await spawned.kill("SIGKILL");
    expect(await waitFor(async () => (await sleepPids(handle.id)).length === 0, 5_000)).toBe(true);
  }, 30_000);
});
