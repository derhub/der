import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSseFrame, type SseFrame } from "@der/domain";

export interface TempDatabaseHandle {
  readonly dir: string;
  readonly dbPath: string;
  readonly cleanup: () => void;
}

export function createTempDatabase(prefix = "der-server-"): TempDatabaseHandle {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    dbPath: join(dir, "der.sqlite"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function allocateLocalTcpNumber(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate free TCP port")));
        return;
      }
      const assigned = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(assigned);
      });
    });
  });
}

export async function waitUntil<T>(
  probe: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  options: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly label?: string;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 30;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) {
      return value;
    }
    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${options.label ?? "condition"}.`);
}

export async function collectSseFrames(
  response: Response,
  options: { readonly maxFrames?: number; readonly abortController?: AbortController } = {},
): Promise<SseFrame[]> {
  if (!response.body) {
    return [];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary === -1) {
          break;
        }
        const rawFrame = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);
        frames.push(parseSseFrame(rawFrame));
        if (options.maxFrames !== undefined && frames.length >= options.maxFrames) {
          options.abortController?.abort();
          await reader.cancel();
          return frames;
        }
      }
    }
  } catch (error) {
    if (!(options.abortController?.signal.aborted && error instanceof Error)) {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }

  return frames;
}

export interface LocalRestateHandle {
  readonly ingressUrl: string;
  readonly adminUrl: string;
  readonly stop: () => Promise<void>;
}

async function isRestateHealthy(adminUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${adminUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureLocalRestate(): Promise<LocalRestateHandle> {
  const envIngress =
    process.env["DER_TEST_RESTATE_INGRESS_URL"] ?? process.env["RESTATE_INGRESS_URL"];
  const envAdmin = process.env["DER_TEST_RESTATE_ADMIN_URL"] ?? process.env["RESTATE_ADMIN_URL"];
  if (envIngress && envAdmin) {
    await waitUntil(() => isRestateHealthy(envAdmin), {
      timeoutMs: 10_000,
      label: `Restate admin at ${envAdmin}`,
    });
    return {
      ingressUrl: envIngress,
      adminUrl: envAdmin,
      stop: async () => {},
    };
  }

  if (await isRestateHealthy("http://127.0.0.1:9070")) {
    return {
      ingressUrl: "http://127.0.0.1:8080",
      adminUrl: "http://127.0.0.1:9070",
      stop: async () => {},
    };
  }

  const ingressNum = await allocateLocalTcpNumber();
  const adminNum = await allocateLocalTcpNumber();
  const nodeNum = await allocateLocalTcpNumber();
  const containerName = `der-restate-test-${crypto.randomUUID().slice(0, 8)}`;
  const image = process.env["DER_RESTATE_IMAGE"] ?? "docker.restate.dev/restatedev/restate:latest";

  const launch = Bun.spawnSync(
    [
      "docker",
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--network",
      "host",
      "-e",
      `RESTATE_INGRESS__BIND_ADDRESS=127.0.0.1:${ingressNum}`,
      "-e",
      `RESTATE_ADMIN__BIND_ADDRESS=127.0.0.1:${adminNum}`,
      "-e",
      `RESTATE_BIND_PORT=${nodeNum}`,
      "-e",
      "RESTATE_NODE_NAME=der-test-node",
      image,
      "--no-logo",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  if (launch.exitCode !== 0) {
    throw new Error(
      `Failed to launch disposable local Restate container (${image}): ${launch.stderr.toString("utf8")}`,
    );
  }

  const adminUrl = `http://127.0.0.1:${adminNum}`;
  const ingressUrl = `http://127.0.0.1:${ingressNum}`;

  try {
    await waitUntil(() => isRestateHealthy(adminUrl), {
      timeoutMs: 25_000,
      intervalMs: 100,
      label: `disposable Restate container ${containerName}`,
    });
  } catch (error) {
    Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
    throw error;
  }

  return {
    ingressUrl,
    adminUrl,
    async stop() {
      Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
    },
  };
}

export async function registerRestateDeployment(
  adminUrl: string,
  deploymentUri: string,
  options: { readonly force?: boolean } = {},
): Promise<{ readonly id: string }> {
  const response = await fetch(`${adminUrl}/deployments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uri: deploymentUri,
      force: options.force ?? true,
      use_http_11: true,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to register Restate deployment ${deploymentUri} (${response.status}): ${body}`,
    );
  }
  return (await response.json()) as { id: string };
}
