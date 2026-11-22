import type { EngineKind } from "@der/domain";
import { SandboxControlError } from "./errors";
import { bunCommandRunner, type CommandRunner } from "./process-runner";

export type OfficialEngineKind = Exclude<EngineKind, "fixture">;

export interface EngineShadowHomeSpec {
  readonly engine: OfficialEngineKind;
  readonly volumeName: string;
  readonly containerHomePath: string;
  readonly envOverrides: Readonly<Record<string, string>>;
}

export const DEFAULT_ENGINE_SHADOW_HOMES: Readonly<
  Record<OfficialEngineKind, EngineShadowHomeSpec>
> = {
  codex: {
    engine: "codex",
    volumeName: "der-home-codex",
    containerHomePath: "/home/engine",
    envOverrides: {
      HOME: "/home/engine",
      CODEX_HOME: "/home/engine/.codex",
    },
  },
  "claude-code": {
    engine: "claude-code",
    volumeName: "der-home-claude-code",
    containerHomePath: "/home/engine",
    envOverrides: {
      HOME: "/home/engine",
      CLAUDE_CONFIG_DIR: "/home/engine/.claude",
    },
  },
  antigravity: {
    engine: "antigravity",
    volumeName: "der-home-antigravity",
    containerHomePath: "/home/engine",
    envOverrides: {
      HOME: "/home/engine",
      XDG_CONFIG_HOME: "/home/engine/.config",
      XDG_DATA_HOME: "/home/engine/.local/share",
    },
  },
} as const;

export const APPROVED_VENDOR_EGRESS: Readonly<Record<OfficialEngineKind, readonly string[]>> = {
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  "claude-code": ["api.anthropic.com", "claude.ai", "console.anthropic.com"],
  antigravity: [
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
  ],
} as const;

export interface DockerResourceLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
}

export type DockerNetworkPolicy =
  | { readonly mode: "none" }
  | {
      readonly mode: "scoped_egress";
      readonly networkName: string;
      readonly allowedHosts: readonly string[];
    };

export interface DockerMountSpec {
  readonly type: "bind" | "volume";
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
}

export interface DockerWorkspaceMount {
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
}

export interface DockerContainerSpec {
  readonly containerName: string;
  readonly image: string;
  readonly engine: OfficialEngineKind;
  readonly user: string;
  readonly workspaceMount: DockerWorkspaceMount;
  readonly shadowHome: EngineShadowHomeSpec;
  readonly network: DockerNetworkPolicy;
  readonly limits: DockerResourceLimits;
  readonly dockerHost: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraMounts?: readonly DockerMountSpec[];
  readonly readOnlyRootfs?: boolean;
}

export interface DockerRunArgOptions {
  readonly detach?: boolean;
  readonly removeOnExit?: boolean;
  readonly command?: readonly string[];
}

export interface DockerIsolationReport {
  readonly isolationVerified: boolean;
  readonly isRootless: boolean;
  readonly daemonVersion: string | null;
  readonly securityOptions: readonly string[];
  readonly reasons: readonly string[];
}

export interface ProbeDockerIsolationOptions {
  readonly dockerHost: string;
  readonly dockerBinary?: string;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

const FORBIDDEN_SOCKET_MARKERS = ["docker.sock", "podman.sock", "containerd.sock"];
const FORBIDDEN_HOST_HOME_PATTERNS = [
  /^\/root(?:\/|$)/,
  /^\/home\/[^/]+(?:\/|$)/,
  /^\/Users\/[^/]+(?:\/|$)/,
  /(?:^|\/)\.(?:codex|claude|gemini|ssh|aws|gnupg|docker)(?:\/|$)/,
];

function extractUnixSocketPath(dockerHost: string): string | null {
  if (!dockerHost.startsWith("unix://")) {
    return null;
  }
  return dockerHost.slice("unix://".length);
}

function isRootUserSpec(user: string): boolean {
  const trimmed = user.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const [uidPart] = trimmed.split(":");
  if (!uidPart) {
    return true;
  }
  return uidPart === "root" || uidPart === "0";
}

function assertMountSafe(
  mount: { readonly source: string; readonly target: string; readonly type: "bind" | "volume" },
  daemonSocketPath: string | null,
): void {
  const source = mount.source.trim();
  const target = mount.target.trim();
  if (source.length === 0 || target.length === 0 || !target.startsWith("/")) {
    throw new SandboxControlError(
      "docker.invalid_workspace_mount",
      `Docker mount source "${source}" and target "${target}" must be non-empty with an absolute container target.`,
    );
  }

  const normalizedSource = source.toLowerCase();
  for (const marker of FORBIDDEN_SOCKET_MARKERS) {
    if (normalizedSource.includes(marker) || target.toLowerCase().includes(marker)) {
      throw new SandboxControlError(
        "docker.socket_mount_forbidden",
        `Mounting container daemon socket "${source}" into a guest container is forbidden.`,
      );
    }
  }
  if (daemonSocketPath !== null && source === daemonSocketPath) {
    throw new SandboxControlError(
      "docker.socket_mount_forbidden",
      `Mounting configured rootless daemon socket "${daemonSocketPath}" into a guest container is forbidden.`,
    );
  }

  if (mount.type === "bind") {
    for (const pattern of FORBIDDEN_HOST_HOME_PATTERNS) {
      if (pattern.test(source)) {
        throw new SandboxControlError(
          "docker.host_home_mount_forbidden",
          `Binding host home or credential directory "${source}" into a guest container is forbidden.`,
        );
      }
    }
  }
}

export function validateDockerContainerSpec(spec: DockerContainerSpec): void {
  if (isRootUserSpec(spec.user)) {
    throw new SandboxControlError(
      "docker.root_user_forbidden",
      `Container user "${spec.user}" must be non-root.`,
    );
  }

  if (
    !Number.isFinite(spec.limits.cpus) ||
    spec.limits.cpus <= 0 ||
    !Number.isInteger(spec.limits.memoryMb) ||
    spec.limits.memoryMb < 64 ||
    !Number.isInteger(spec.limits.pidsLimit) ||
    spec.limits.pidsLimit < 16
  ) {
    throw new SandboxControlError(
      "docker.invalid_resource_limits",
      `Invalid resource limits: cpus=${spec.limits.cpus}, memoryMb=${spec.limits.memoryMb}, pidsLimit=${spec.limits.pidsLimit}.`,
    );
  }

  if (spec.shadowHome.engine !== spec.engine) {
    throw new SandboxControlError(
      "docker.shadow_home_mismatch",
      `Shadow home for "${spec.shadowHome.engine}" cannot be mounted into "${spec.engine}" container.`,
    );
  }

  if (
    spec.shadowHome.volumeName.trim().length === 0 ||
    spec.shadowHome.volumeName.includes("/") ||
    !spec.shadowHome.containerHomePath.startsWith("/")
  ) {
    throw new SandboxControlError(
      "docker.shadow_home_mismatch",
      `Shadow home "${spec.shadowHome.volumeName}" must be a named Docker volume targeting an absolute container path.`,
    );
  }

  if (spec.network.mode === "scoped_egress") {
    const netName = spec.network.networkName.trim();
    if (netName.length === 0 || netName === "host" || netName === "bridge") {
      throw new SandboxControlError(
        "docker.host_network_forbidden",
        `Scoped egress network "${netName}" must be a dedicated isolated network, never host or default bridge.`,
      );
    }
    const approved = new Set(APPROVED_VENDOR_EGRESS[spec.engine]);
    for (const host of spec.network.allowedHosts) {
      if (!approved.has(host)) {
        throw new SandboxControlError(
          "docker.egress_host_not_approved",
          `Egress host "${host}" is not approved for engine "${spec.engine}".`,
        );
      }
    }
  }

  const daemonSocketPath = extractUnixSocketPath(spec.dockerHost);
  assertMountSafe(
    {
      type: "bind",
      source: spec.workspaceMount.source,
      target: spec.workspaceMount.target,
    },
    daemonSocketPath,
  );
  assertMountSafe(
    {
      type: "volume",
      source: spec.shadowHome.volumeName,
      target: spec.shadowHome.containerHomePath,
    },
    daemonSocketPath,
  );

  for (const extra of spec.extraMounts ?? []) {
    assertMountSafe(extra, daemonSocketPath);
  }
}

function formatMountArg(mount: DockerMountSpec): string {
  const base = `type=${mount.type},source=${mount.source},target=${mount.target}`;
  return mount.readonly ? `${base},readonly` : base;
}

export function buildDockerRunArgs(
  spec: DockerContainerSpec,
  options?: DockerRunArgOptions,
): string[] {
  validateDockerContainerSpec(spec);

  const args: string[] = ["run"];
  if (options?.detach) {
    args.push("-d");
  }
  if (options?.removeOnExit) {
    args.push("--rm");
  }

  args.push("--name", spec.containerName);
  args.push("--user", spec.user);
  args.push("--cap-drop=ALL");
  args.push("--security-opt=no-new-privileges:true");

  if (spec.readOnlyRootfs) {
    args.push("--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m");
  }

  if (spec.network.mode === "none") {
    args.push("--network=none");
  } else {
    args.push(`--network=${spec.network.networkName}`);
  }

  args.push(`--cpus=${spec.limits.cpus}`);
  args.push(`--memory=${spec.limits.memoryMb}m`);
  args.push(`--memory-swap=${spec.limits.memoryMb}m`);
  args.push(`--pids-limit=${spec.limits.pidsLimit}`);

  args.push(
    "--mount",
    formatMountArg({
      type: "bind",
      source: spec.workspaceMount.source,
      target: spec.workspaceMount.target,
      readonly: spec.workspaceMount.readonly,
    }),
  );
  args.push(
    "--mount",
    formatMountArg({
      type: "volume",
      source: spec.shadowHome.volumeName,
      target: spec.shadowHome.containerHomePath,
      readonly: false,
    }),
  );

  for (const extra of spec.extraMounts ?? []) {
    args.push("--mount", formatMountArg(extra));
  }

  args.push("-w", spec.workspaceMount.target);

  const mergedEnv: Record<string, string> = {
    ...spec.shadowHome.envOverrides,
    ...spec.env,
  };
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (key === "DOCKER_HOST") {
      continue;
    }
    args.push("-e", `${key}=${value}`);
  }

  args.push(spec.image);
  if (options?.command) {
    args.push(...options.command);
  }
  return args;
}

interface DockerInfoPayload {
  readonly ServerVersion?: unknown;
  readonly SecurityOptions?: unknown;
  readonly MemoryLimit?: unknown;
  readonly CpuCfsQuota?: unknown;
  readonly PidsLimit?: unknown;
}

export async function probeDockerIsolation(
  options: ProbeDockerIsolationOptions,
): Promise<DockerIsolationReport> {
  const runner = options.runner ?? bunCommandRunner;
  const dockerBinary = options.dockerBinary ?? "docker";
  const reasons: string[] = [];

  if (options.dockerHost.trim().length === 0) {
    return {
      isolationVerified: false,
      isRootless: false,
      daemonVersion: null,
      securityOptions: [],
      reasons: ["Dedicated rootless DOCKER_HOST is not configured."],
    };
  }

  let execResult;
  try {
    execResult = await runner.exec(dockerBinary, ["info", "--format", "{{json .}}"], {
      env: { DOCKER_HOST: options.dockerHost },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return {
      isolationVerified: false,
      isRootless: false,
      daemonVersion: null,
      securityOptions: [],
      reasons: [
        `Docker daemon probe failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  if (execResult.exitCode !== 0) {
    return {
      isolationVerified: false,
      isRootless: false,
      daemonVersion: null,
      securityOptions: [],
      reasons: [`Docker daemon unreachable or rejected info probe (exit ${execResult.exitCode}).`],
    };
  }

  let parsed: DockerInfoPayload;
  try {
    const raw: unknown = JSON.parse(execResult.stdout);
    if (raw === null || typeof raw !== "object") {
      throw new Error("docker info JSON payload was not an object");
    }
    parsed = raw as DockerInfoPayload;
  } catch {
    return {
      isolationVerified: false,
      isRootless: false,
      daemonVersion: null,
      securityOptions: [],
      reasons: ["Docker daemon returned malformed JSON for docker info."],
    };
  }

  const securityOptions = Array.isArray(parsed.SecurityOptions)
    ? parsed.SecurityOptions.filter((entry): entry is string => typeof entry === "string")
    : [];
  const isRootless = securityOptions.some(
    (opt) => opt === "rootless" || opt.includes("name=rootless"),
  );
  const daemonVersion = typeof parsed.ServerVersion === "string" ? parsed.ServerVersion : null;

  if (!isRootless) {
    reasons.push("Docker daemon is not running in rootless mode.");
  }
  if (parsed.MemoryLimit !== true) {
    reasons.push("Docker daemon does not enforce cgroup memory limits.");
  }
  if (parsed.CpuCfsQuota !== true) {
    reasons.push("Docker daemon does not enforce cgroup CPU quota limits.");
  }
  if (parsed.PidsLimit !== true) {
    reasons.push("Docker daemon does not enforce cgroup PIDs limits.");
  }

  return {
    isolationVerified: reasons.length === 0,
    isRootless,
    daemonVersion,
    securityOptions,
    reasons,
  };
}
