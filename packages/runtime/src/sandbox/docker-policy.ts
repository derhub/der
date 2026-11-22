import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type { EngineKind } from "@der/domain";
import { SandboxControlError } from "./errors";
import { bunCommandRunner, type CommandRunner } from "./process-runner";

export type OfficialEngineKind = Exclude<EngineKind, "fixture">;
export type RealPathResolver = (path: string) => string;
export const DOCKER_EGRESS_ALLOWED_HOSTS_LABEL = "der.egress.allowed_hosts";

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
      readonly egressProxyUrl: string;
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
  readonly allowedWorkspaceRoots?: readonly string[];
  readonly shadowHome: EngineShadowHomeSpec;
  readonly network: DockerNetworkPolicy;
  readonly limits: DockerResourceLimits;
  readonly dockerHost: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extraMounts?: readonly DockerMountSpec[];
  readonly readOnlyRootfs?: boolean;
  readonly resolveRealPath?: RealPathResolver;
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
  readonly egressNetworkName?: string;
  readonly egressEngine?: OfficialEngineKind;
  readonly egressAllowedHosts?: readonly string[];
  readonly egressProxyUrl?: string;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

export interface DockerEgressNetworkReport {
  readonly verified: boolean;
  readonly networkName: string;
  readonly driver: string | null;
  readonly internal: boolean;
  readonly allowedHosts: readonly string[];
  readonly reasons: readonly string[];
}

export interface ProbeDockerEgressNetworkOptions {
  readonly dockerHost: string;
  readonly networkName: string;
  readonly engine?: OfficialEngineKind;
  readonly allowedHosts?: readonly string[];
  readonly egressProxyUrl?: string;
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
const FORBIDDEN_NETWORK_NAMES = new Set(["host", "bridge", "default", "none"]);
const VALID_DOCKER_NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function extractUnixSocketPath(dockerHost: string): string | null {
  if (!dockerHost.startsWith("unix://")) {
    return null;
  }
  const raw = dockerHost.slice("unix://".length).trim();
  return raw.length > 0 ? posix.resolve(raw) : null;
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

function normalizeCleanAbsolutePath(rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new SandboxControlError(
      "docker.invalid_workspace_mount",
      `${label} "${rawPath}" must be a clean absolute path.`,
    );
  }
  const segments = trimmed.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new SandboxControlError(
      "docker.invalid_workspace_mount",
      `${label} "${rawPath}" cannot contain relative path segments.`,
    );
  }
  return posix.resolve(trimmed);
}

function isWithinAllowedRoots(normalizedPath: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root) => {
    const normalizedRoot = root === "/" ? "/" : root.replace(/\/+$/, "");
    if (normalizedRoot === "/") {
      return normalizedPath.startsWith("/");
    }
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

function assertNotForbiddenHostPath(
  rawSource: string,
  normalizedSource: string,
  target: string,
  daemonSocketPath: string | null,
  isBind: boolean,
): void {
  const lowerRaw = rawSource.toLowerCase();
  const lowerNorm = normalizedSource.toLowerCase();
  const lowerTarget = target.toLowerCase();

  for (const marker of FORBIDDEN_SOCKET_MARKERS) {
    if (lowerRaw.includes(marker) || lowerNorm.includes(marker) || lowerTarget.includes(marker)) {
      throw new SandboxControlError(
        "docker.socket_mount_forbidden",
        `Mounting container daemon socket "${rawSource}" into a guest container is forbidden.`,
      );
    }
  }
  if (daemonSocketPath !== null && normalizedSource === daemonSocketPath) {
    throw new SandboxControlError(
      "docker.socket_mount_forbidden",
      `Mounting configured rootless daemon socket "${daemonSocketPath}" into a guest container is forbidden.`,
    );
  }

  if (isBind) {
    for (const pattern of FORBIDDEN_HOST_HOME_PATTERNS) {
      if (pattern.test(rawSource) || pattern.test(normalizedSource)) {
        throw new SandboxControlError(
          "docker.host_home_mount_forbidden",
          `Binding host home or credential directory "${rawSource}" into a guest container is forbidden.`,
        );
      }
    }
  }
}

function resolveCanonicalHostPath(
  normalizedPath: string,
  rawPath: string,
  label: string,
  resolveRealPath: RealPathResolver,
): string {
  let resolved: string;
  try {
    resolved = resolveRealPath(normalizedPath);
  } catch (error) {
    throw new SandboxControlError(
      "docker.invalid_workspace_mount",
      `${label} "${rawPath}" could not be resolved on the host filesystem.`,
      { cause: error },
    );
  }
  return normalizeCleanAbsolutePath(resolved, label);
}

function validateAllowedWorkspaceRoots(
  roots: readonly string[],
  daemonSocketPath: string | null,
  resolveRealPath: RealPathResolver,
): string[] {
  if (roots.length === 0) {
    throw new SandboxControlError(
      "docker.invalid_workspace_mount",
      "allowedWorkspaceRoots must contain at least one explicit absolute root path.",
    );
  }
  return roots.map((root) => {
    const normalized = normalizeCleanAbsolutePath(root, "Allowed workspace root");
    assertNotForbiddenHostPath(root, normalized, "/workspace", daemonSocketPath, true);
    const resolved = resolveCanonicalHostPath(
      normalized,
      root,
      "Allowed workspace root",
      resolveRealPath,
    );
    assertNotForbiddenHostPath(root, resolved, "/workspace", daemonSocketPath, true);
    return resolved;
  });
}

function assertMountSafe(
  mount: { readonly source: string; readonly target: string; readonly type: "bind" | "volume" },
  daemonSocketPath: string | null,
  resolveRealPath: RealPathResolver,
  allowedBindRoots?: readonly string[],
): string {
  const source = mount.source.trim();
  const target = mount.target.trim();
  if (
    source.length === 0 ||
    target.length === 0 ||
    !target.startsWith("/") ||
    target.includes("\0")
  ) {
    throw new SandboxControlError(
      "docker.invalid_workspace_mount",
      `Docker mount source "${source}" and target "${target}" must be non-empty with an absolute container target.`,
    );
  }

  if (mount.type === "volume") {
    assertNotForbiddenHostPath(source, source, target, daemonSocketPath, false);
    return source;
  }

  const normalizedSource = normalizeCleanAbsolutePath(source, "Docker bind mount source");
  assertNotForbiddenHostPath(source, normalizedSource, target, daemonSocketPath, true);
  const resolvedSource = resolveCanonicalHostPath(
    normalizedSource,
    source,
    "Docker bind mount source",
    resolveRealPath,
  );
  assertNotForbiddenHostPath(source, resolvedSource, target, daemonSocketPath, true);

  if (allowedBindRoots !== undefined && !isWithinAllowedRoots(resolvedSource, allowedBindRoots)) {
    throw new SandboxControlError(
      "docker.bind_path_outside_root",
      `Host bind mount "${source}" resolves to "${resolvedSource}", which is outside allowed workspace roots.`,
    );
  }

  return resolvedSource;
}

function validateEgressNetworkName(rawName: string): string {
  const netName = rawName.trim();
  const lower = netName.toLowerCase();
  if (
    netName.length === 0 ||
    FORBIDDEN_NETWORK_NAMES.has(lower) ||
    lower.startsWith("container:") ||
    !VALID_DOCKER_NETWORK_NAME.test(netName)
  ) {
    throw new SandboxControlError(
      "docker.host_network_forbidden",
      `Scoped egress network "${rawName}" must be a dedicated isolated network, never default, host, bridge, none, or container-shared.`,
    );
  }
  return netName;
}

function normalizeUrlHost(hostname: string): string {
  const stripped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return stripped.trim().toLowerCase().replace(/\.+$/, "");
}

function isLoopbackOrLinkLocalIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) {
    return false;
  }
  return a === 127 || a === 0 || (a === 169 && b === 254);
}

function isLoopbackOrLinkLocalHost(rawHostname: string): boolean {
  const host = normalizeUrlHost(rawHostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost.localdomain")
  ) {
    return true;
  }
  if (isLoopbackOrLinkLocalIpv4(host)) {
    return true;
  }
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:0:0:0") {
    return true;
  }
  if (/^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (mappedDotted?.[1] !== undefined) {
    return isLoopbackOrLinkLocalIpv4(mappedDotted[1]);
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isLoopbackOrLinkLocalIpv4(ipv4);
  }
  return false;
}

function parseValidatedEgressProxy(rawUrl: unknown): {
  readonly url: string;
  readonly host: string;
} {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new SandboxControlError(
      "docker.egress_network_unverified",
      "Scoped egress requires an explicit egressProxyUrl reachable on the internal Docker network.",
    );
  }
  const trimmed = rawUrl.trim();
  if (/[\r\n\0]/.test(trimmed)) {
    throw new SandboxControlError(
      "docker.egress_network_unverified",
      `Scoped egress proxy URL "${rawUrl}" contains invalid control characters.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SandboxControlError(
      "docker.egress_network_unverified",
      `Scoped egress proxy URL "${rawUrl}" must be a valid http(s) URL.`,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw new SandboxControlError(
      "docker.egress_network_unverified",
      `Scoped egress proxy URL "${rawUrl}" must use http:// or https:// with a valid host.`,
    );
  }
  const host = normalizeUrlHost(parsed.hostname);
  if (host.length === 0 || isLoopbackOrLinkLocalHost(host)) {
    throw new SandboxControlError(
      "docker.egress_network_unverified",
      `Scoped egress proxy URL "${rawUrl}" must use a non-loopback, non-link-local host reachable on the internal Docker network.`,
    );
  }
  return { url: trimmed, host };
}

function validateEgressProxyUrl(rawUrl: unknown): string {
  return parseValidatedEgressProxy(rawUrl).url;
}

interface ValidatedDockerMounts {
  readonly workspaceSource: string;
  readonly extraMounts: readonly DockerMountSpec[];
  readonly egressProxyUrl?: string;
}

function resolveAndValidateDockerSpec(spec: DockerContainerSpec): ValidatedDockerMounts {
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

  const networkMode = (spec.network as { readonly mode?: unknown }).mode;
  if (networkMode !== "none" && networkMode !== "scoped_egress") {
    throw new SandboxControlError(
      "docker.host_network_forbidden",
      `Unsupported Docker network mode "${String(networkMode)}". Only "none" or "scoped_egress" is allowed.`,
    );
  }

  let egressProxyUrl: string | undefined;
  if (spec.network.mode === "scoped_egress") {
    validateEgressNetworkName(spec.network.networkName);
    egressProxyUrl = validateEgressProxyUrl(
      (spec.network as { readonly egressProxyUrl?: unknown }).egressProxyUrl,
    );
    if (spec.network.allowedHosts.length === 0) {
      throw new SandboxControlError(
        "docker.egress_host_not_approved",
        `Scoped egress for engine "${spec.engine}" must declare at least one approved vendor host.`,
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

  const resolveRealPath = spec.resolveRealPath ?? realpathSync;
  const daemonSocketPath = extractUnixSocketPath(spec.dockerHost);
  const explicitAllowedRoots =
    spec.allowedWorkspaceRoots !== undefined
      ? validateAllowedWorkspaceRoots(spec.allowedWorkspaceRoots, daemonSocketPath, resolveRealPath)
      : undefined;

  const resolvedWorkspaceSource = assertMountSafe(
    {
      type: "bind",
      source: spec.workspaceMount.source,
      target: spec.workspaceMount.target,
    },
    daemonSocketPath,
    resolveRealPath,
    explicitAllowedRoots,
  );
  assertMountSafe(
    {
      type: "volume",
      source: spec.shadowHome.volumeName,
      target: spec.shadowHome.containerHomePath,
    },
    daemonSocketPath,
    resolveRealPath,
  );

  const effectiveBindRoots = explicitAllowedRoots ?? [resolvedWorkspaceSource];
  const resolvedExtraMounts: DockerMountSpec[] = [];
  for (const extra of spec.extraMounts ?? []) {
    const resolvedSource = assertMountSafe(
      extra,
      daemonSocketPath,
      resolveRealPath,
      effectiveBindRoots,
    );
    resolvedExtraMounts.push({
      ...extra,
      source: resolvedSource,
    });
  }

  return {
    workspaceSource: resolvedWorkspaceSource,
    extraMounts: resolvedExtraMounts,
    ...(egressProxyUrl !== undefined ? { egressProxyUrl } : {}),
  };
}

export function validateDockerContainerSpec(spec: DockerContainerSpec): void {
  resolveAndValidateDockerSpec(spec);
}

function formatMountArg(mount: DockerMountSpec): string {
  const source = mount.type === "bind" ? posix.resolve(mount.source.trim()) : mount.source.trim();
  const base = `type=${mount.type},source=${source},target=${mount.target.trim()}`;
  return mount.readonly ? `${base},readonly` : base;
}

export function buildDockerRunArgs(
  spec: DockerContainerSpec,
  options?: DockerRunArgOptions,
): string[] {
  const validated = resolveAndValidateDockerSpec(spec);

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
    args.push(`--network=${spec.network.networkName.trim()}`);
  }

  args.push(`--cpus=${spec.limits.cpus}`);
  args.push(`--memory=${spec.limits.memoryMb}m`);
  args.push(`--memory-swap=${spec.limits.memoryMb}m`);
  args.push(`--pids-limit=${spec.limits.pidsLimit}`);

  args.push(
    "--mount",
    formatMountArg({
      type: "bind",
      source: validated.workspaceSource,
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

  for (const extra of validated.extraMounts) {
    args.push("--mount", formatMountArg(extra));
  }

  args.push("-w", spec.workspaceMount.target);

  const mergedEnv: Record<string, string> = {
    ...spec.shadowHome.envOverrides,
    ...spec.env,
    ...(validated.egressProxyUrl !== undefined
      ? {
          HTTP_PROXY: validated.egressProxyUrl,
          HTTPS_PROXY: validated.egressProxyUrl,
          http_proxy: validated.egressProxyUrl,
          https_proxy: validated.egressProxyUrl,
        }
      : {}),
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

interface DockerNetworkEndpointPayload {
  readonly Name?: unknown;
  readonly IPv4Address?: unknown;
  readonly IPv6Address?: unknown;
}

interface DockerNetworkInspectPayload {
  readonly Name?: unknown;
  readonly Driver?: unknown;
  readonly Internal?: unknown;
  readonly Options?: unknown;
  readonly Labels?: unknown;
  readonly Containers?: unknown;
}

function parseEgressAllowedHostsLabel(
  rawLabel: unknown,
  netName: string,
  reasons: string[],
): string[] {
  if (typeof rawLabel !== "string" || rawLabel.trim().length === 0) {
    reasons.push(
      `Egress network "${netName}" is missing required label "${DOCKER_EGRESS_ALLOWED_HOSTS_LABEL}".`,
    );
    return [];
  }
  const parts = rawLabel.split(",").map((entry) => entry.trim());
  if (parts.length === 0 || parts.some((entry) => entry.length === 0)) {
    reasons.push(
      `Egress network "${netName}" label "${DOCKER_EGRESS_ALLOWED_HOSTS_LABEL}" must be a non-empty comma-separated host allowlist.`,
    );
    return [];
  }
  return [...new Set(parts)];
}

export async function probeDockerEgressNetwork(
  options: ProbeDockerEgressNetworkOptions,
): Promise<DockerEgressNetworkReport> {
  const runner = options.runner ?? bunCommandRunner;
  const dockerBinary = options.dockerBinary ?? "docker";
  const netName = options.networkName.trim();
  const reasons: string[] = [];

  try {
    validateEgressNetworkName(netName);
  } catch (error) {
    return {
      verified: false,
      networkName: netName,
      driver: null,
      internal: false,
      allowedHosts: [],
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }

  if (options.dockerHost.trim().length === 0) {
    return {
      verified: false,
      networkName: netName,
      driver: null,
      internal: false,
      allowedHosts: [],
      reasons: ["Dedicated rootless DOCKER_HOST is not configured."],
    };
  }

  let execResult;
  try {
    execResult = await runner.exec(
      dockerBinary,
      ["network", "inspect", netName, "--format", "{{json .}}"],
      {
        env: { DOCKER_HOST: options.dockerHost },
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
  } catch (error) {
    return {
      verified: false,
      networkName: netName,
      driver: null,
      internal: false,
      allowedHosts: [],
      reasons: [
        `Docker egress network probe failed for "${netName}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  if (execResult.exitCode !== 0) {
    return {
      verified: false,
      networkName: netName,
      driver: null,
      internal: false,
      allowedHosts: [],
      reasons: [
        `Configured scoped egress network "${netName}" does not exist or cannot be inspected (exit ${execResult.exitCode}).`,
      ],
    };
  }

  let parsed: DockerNetworkInspectPayload;
  try {
    const raw: unknown = JSON.parse(execResult.stdout);
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    if (candidate === null || typeof candidate !== "object") {
      throw new Error("docker network inspect JSON payload was not an object");
    }
    parsed = candidate as DockerNetworkInspectPayload;
  } catch {
    return {
      verified: false,
      networkName: netName,
      driver: null,
      internal: false,
      allowedHosts: [],
      reasons: [`Docker daemon returned malformed JSON when inspecting network "${netName}".`],
    };
  }

  const inspectedName = typeof parsed.Name === "string" ? parsed.Name.trim() : netName;
  const driver = typeof parsed.Driver === "string" ? parsed.Driver.trim() : null;
  const internal = parsed.Internal === true;
  const networkOptions =
    parsed.Options !== null && typeof parsed.Options === "object" && !Array.isArray(parsed.Options)
      ? (parsed.Options as Record<string, unknown>)
      : {};
  const networkLabels =
    parsed.Labels !== null && typeof parsed.Labels === "object" && !Array.isArray(parsed.Labels)
      ? (parsed.Labels as Record<string, unknown>)
      : {};

  if (FORBIDDEN_NETWORK_NAMES.has(inspectedName.toLowerCase())) {
    reasons.push(`Egress network "${inspectedName}" cannot be a default or host network.`);
  }
  if (driver === null || driver === "host" || driver === "null") {
    reasons.push(`Egress network "${netName}" uses disallowed driver "${String(driver)}".`);
  }
  if (networkOptions["com.docker.network.bridge.default_bridge"] === "true") {
    reasons.push(`Egress network "${netName}" is the default Docker bridge and is not isolated.`);
  }
  if (!internal) {
    reasons.push(
      `Egress network "${netName}" must be configured as an internal isolated network (Internal=true).`,
    );
  }

  const labelHosts = parseEgressAllowedHostsLabel(
    networkLabels[DOCKER_EGRESS_ALLOWED_HOSTS_LABEL],
    netName,
    reasons,
  );
  const approvedVendorHosts = new Set(
    options.engine !== undefined
      ? APPROVED_VENDOR_EGRESS[options.engine]
      : Object.values(APPROVED_VENDOR_EGRESS).flat(),
  );
  for (const host of labelHosts) {
    if (!approvedVendorHosts.has(host)) {
      reasons.push(
        `Egress network "${netName}" label "${DOCKER_EGRESS_ALLOWED_HOSTS_LABEL}" permits unapproved host "${host}".`,
      );
    }
  }
  if (options.allowedHosts !== undefined) {
    if (options.allowedHosts.length === 0) {
      reasons.push(
        `Scoped egress probe for network "${netName}" requires at least one requested approved host.`,
      );
    }
    const labelHostSet = new Set(labelHosts);
    for (const requestedHost of options.allowedHosts) {
      if (!approvedVendorHosts.has(requestedHost)) {
        reasons.push(`Requested egress host "${requestedHost}" is not an approved vendor host.`);
      } else if (!labelHostSet.has(requestedHost)) {
        reasons.push(
          `Egress network "${netName}" label "${DOCKER_EGRESS_ALLOWED_HOSTS_LABEL}" does not cover requested host "${requestedHost}".`,
        );
      }
    }
  }

  let proxyHost: string | undefined;
  if (options.egressProxyUrl !== undefined) {
    try {
      proxyHost = parseValidatedEgressProxy(options.egressProxyUrl).host;
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (parsed.Containers !== undefined) {
    const containersMap =
      parsed.Containers !== null &&
      typeof parsed.Containers === "object" &&
      !Array.isArray(parsed.Containers)
        ? (parsed.Containers as Record<string, unknown>)
        : null;
    if (containersMap === null) {
      reasons.push(`Egress network "${netName}" reported malformed Containers metadata.`);
    } else {
      const attachedContainers = Object.values(containersMap).filter(
        (entry): entry is DockerNetworkEndpointPayload =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      );
      if (attachedContainers.length === 0) {
        reasons.push(
          `Egress network "${netName}" has no containers attached to serve scoped egress proxy traffic.`,
        );
      } else if (proxyHost !== undefined) {
        const inspectedLower = inspectedName.toLowerCase();
        const proxyAttached = attachedContainers.some((endpoint) => {
          const name =
            typeof endpoint.Name === "string"
              ? endpoint.Name.trim().replace(/^\/+/, "").toLowerCase()
              : "";
          const ipv4 =
            typeof endpoint.IPv4Address === "string"
              ? (endpoint.IPv4Address.trim().split("/")[0]?.toLowerCase() ?? "")
              : "";
          const ipv6 =
            typeof endpoint.IPv6Address === "string"
              ? normalizeUrlHost(endpoint.IPv6Address.trim().split("/")[0] ?? "")
              : "";
          return (
            (name.length > 0 &&
              (name === proxyHost || `${name}.${inspectedLower}` === proxyHost)) ||
            (ipv4.length > 0 && ipv4 === proxyHost) ||
            (ipv6.length > 0 && ipv6 === proxyHost)
          );
        });
        if (!proxyAttached) {
          reasons.push(
            `Egress proxy host "${proxyHost}" is not attached to internal egress network "${netName}".`,
          );
        }
      }
    }
  }

  return {
    verified: reasons.length === 0,
    networkName: inspectedName,
    driver,
    internal,
    allowedHosts: labelHosts,
    reasons,
  };
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

  if (options.egressNetworkName !== undefined) {
    const egressReport = await probeDockerEgressNetwork({
      dockerHost: options.dockerHost,
      networkName: options.egressNetworkName,
      ...(options.egressEngine !== undefined ? { engine: options.egressEngine } : {}),
      ...(options.egressAllowedHosts !== undefined
        ? { allowedHosts: options.egressAllowedHosts }
        : {}),
      ...(options.egressProxyUrl !== undefined ? { egressProxyUrl: options.egressProxyUrl } : {}),
      dockerBinary,
      runner,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (!egressReport.verified) {
      reasons.push(...egressReport.reasons);
    }
  }

  return {
    isolationVerified: reasons.length === 0,
    isRootless,
    daemonVersion,
    securityOptions,
    reasons,
  };
}
