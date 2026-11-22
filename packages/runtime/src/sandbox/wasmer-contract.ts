import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type { ToolDescriptor } from "@der/domain";
import { SandboxControlError } from "./errors";

export type WasmerRealPathResolver = (path: string) => string;

export type WasmerGuestKind = "bash" | "python";

export interface WasmerGuestPin {
  readonly guest: WasmerGuestKind;
  readonly packageRef: string;
  readonly version: string;
  readonly digest: string;
  readonly commandName: string;
  readonly artifactPath: string;
  readonly abi: "wasix" | "wasi";
}

export interface WasmerRunnerContract {
  readonly imageTarget: "der-wasmer-runner";
  readonly dockerfilePath: "docker/Dockerfile.wasmer";
  readonly guestRoot: "/guests";
  readonly runnerEntrypoint: readonly string[];
  readonly networkMode: "disabled";
  readonly guests: Readonly<Record<WasmerGuestKind, WasmerGuestPin>>;
}

export const WASMER_RUNNER_CONTRACT: WasmerRunnerContract = {
  imageTarget: "der-wasmer-runner",
  dockerfilePath: "docker/Dockerfile.wasmer",
  guestRoot: "/guests",
  runnerEntrypoint: ["bun", "run", "/app/wasmer-runner.ts"],
  networkMode: "disabled",
  guests: {
    bash: {
      guest: "bash",
      packageRef: "wasmer/bash@1.0.25",
      version: "1.0.25",
      digest: "sha256:059606d132e2e6bc1afe3b432ee64dcb1b1b059815c8bb213cf3b24798ef21e1",
      commandName: "bash",
      artifactPath: "/guests/bash-1.0.25.webc",
      abi: "wasix",
    },
    python: {
      guest: "python",
      packageRef: "python/python@3.13.20",
      version: "3.13.20",
      digest: "sha256:a9fa8202f1bf6a4eca8d31ee5f2b1970c8f45af5c5520cc954d28a133333d8e7",
      commandName: "python",
      artifactPath: "/guests/python-3.13.20.webc",
      abi: "wasix",
    },
  },
} as const;

export const WASMER_TOOL_DESCRIPTOR: ToolDescriptor = {
  kind: "wasmer",
  id: "wasmer.execute",
  name: "Wasmer Guest Execute",
  description:
    "Run a pinned Bash or Python WASI/WASIX guest with explicit directory grants and no network.",
  requiresApproval: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", enum: ["bash", "python"] },
      args: { type: "array", items: { type: "string" } },
      readonlyPaths: { type: "array", items: { type: "string" } },
      writablePaths: { type: "array", items: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1 },
    },
    required: ["command", "args", "timeoutMs"],
  },
};

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FLOATING_TAG_PATTERN = /(?:^|@|:)(?:latest|main|master|nightly|edge|canary)$/i;
const FORBIDDEN_GRANT_PATTERNS = [
  /docker\.sock/i,
  /podman\.sock/i,
  /containerd\.sock/i,
  /^\/root(?:\/|$)/,
  /^\/home\/[^/]+(?:\/|$)/,
  /^\/Users\/[^/]+(?:\/|$)/,
  /(?:^|\/)\.(?:codex|claude|gemini|ssh|aws|gnupg|docker)(?:\/|$)/,
];

export interface WasmerDirectoryGrant {
  readonly hostPath: string;
  readonly guestPath: string;
  readonly access: "readonly" | "readwrite";
}

export interface WasmerGrantPolicy {
  readonly allowedHostRoots: readonly string[];
  readonly resolveRealPath?: WasmerRealPathResolver;
}

export function validateWasmerGuestPin(pin: WasmerGuestPin): void {
  const version = pin.version.trim();
  const packageRef = pin.packageRef.trim();
  if (
    version.length === 0 ||
    FLOATING_TAG_PATTERN.test(version) ||
    packageRef.length === 0 ||
    FLOATING_TAG_PATTERN.test(packageRef)
  ) {
    throw new SandboxControlError(
      "wasmer.unpinned_guest",
      `Wasmer guest "${pin.guest}" must use an immutable version and packageRef, got "${packageRef}" (${version}).`,
    );
  }
  if (!SHA256_DIGEST_PATTERN.test(pin.digest)) {
    throw new SandboxControlError(
      "wasmer.unpinned_guest",
      `Wasmer guest "${pin.guest}" requires a sha256 digest pin, got "${pin.digest}".`,
    );
  }
  if (!pin.artifactPath.startsWith("/")) {
    throw new SandboxControlError(
      "wasmer.unpinned_guest",
      `Wasmer guest "${pin.guest}" artifactPath "${pin.artifactPath}" must be absolute.`,
    );
  }
}

function normalizeRoot(root: string): string {
  const resolved = posix.resolve(root);
  return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

function assertCleanAbsoluteGrantPath(rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new SandboxControlError(
      "wasmer.invalid_directory_grant",
      `${label} "${rawPath}" must be a clean absolute path.`,
    );
  }
  const segments = trimmed.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new SandboxControlError(
      "wasmer.invalid_directory_grant",
      `${label} "${rawPath}" cannot contain relative path segments.`,
    );
  }
  return normalizeRoot(trimmed);
}

function assertNotForbiddenGrantPath(rawPath: string, candidatePath: string): void {
  for (const pattern of FORBIDDEN_GRANT_PATTERNS) {
    if (pattern.test(candidatePath)) {
      throw new SandboxControlError(
        "wasmer.forbidden_path",
        `Directory grant "${rawPath}" targets a forbidden host home, credential, or daemon socket path.`,
      );
    }
  }
}

function resolveCanonicalGrantPath(
  normalizedPath: string,
  rawPath: string,
  label: string,
  resolveRealPath: WasmerRealPathResolver,
): string {
  let resolved: string;
  try {
    resolved = resolveRealPath(normalizedPath);
  } catch (error) {
    throw new SandboxControlError(
      "wasmer.invalid_directory_grant",
      `${label} "${rawPath}" could not be resolved on the host filesystem.`,
      { cause: error },
    );
  }
  return assertCleanAbsoluteGrantPath(resolved, label);
}

function resolveAllowedHostRoots(
  allowedRoots: readonly string[],
  resolveRealPath: WasmerRealPathResolver,
): string[] {
  return allowedRoots.map((root) => {
    const normalized = assertCleanAbsoluteGrantPath(root, "Allowed host root");
    assertNotForbiddenGrantPath(root, normalized);
    const resolved = resolveCanonicalGrantPath(
      normalized,
      root,
      "Allowed host root",
      resolveRealPath,
    );
    assertNotForbiddenGrantPath(root, resolved);
    return resolved;
  });
}

function validateHostGrantPath(
  hostPath: string,
  resolvedAllowedRoots: readonly string[],
  resolveRealPath: WasmerRealPathResolver,
): string {
  const normalized = assertCleanAbsoluteGrantPath(hostPath, "Directory grant");
  assertNotForbiddenGrantPath(hostPath, normalized);
  const resolved = resolveCanonicalGrantPath(
    normalized,
    hostPath,
    "Directory grant",
    resolveRealPath,
  );
  assertNotForbiddenGrantPath(hostPath, resolved);

  const inAllowedRoot = resolvedAllowedRoots.some((normRoot) => {
    if (normRoot === "/") {
      return resolved.startsWith("/");
    }
    return resolved === normRoot || resolved.startsWith(`${normRoot}/`);
  });

  if (!inAllowedRoot) {
    throw new SandboxControlError(
      "wasmer.directory_outside_root",
      `Directory grant "${hostPath}" resolves to "${resolved}", which is outside allowed host roots.`,
    );
  }

  return resolved;
}

export function validateWasmerDirectoryGrants(
  input: {
    readonly readonlyPaths?: readonly string[];
    readonly writablePaths?: readonly string[];
  },
  policy: WasmerGrantPolicy,
): WasmerDirectoryGrant[] {
  const grants: WasmerDirectoryGrant[] = [];
  const readonlyPaths = input.readonlyPaths ?? [];
  const writablePaths = input.writablePaths ?? [];

  if (readonlyPaths.length === 0 && writablePaths.length === 0) {
    return grants;
  }

  const resolveRealPath = policy.resolveRealPath ?? realpathSync;
  const resolvedAllowedRoots = resolveAllowedHostRoots(policy.allowedHostRoots, resolveRealPath);

  for (let i = 0; i < readonlyPaths.length; i += 1) {
    const rawPath = readonlyPaths[i];
    if (rawPath === undefined) {
      continue;
    }
    const hostPath = validateHostGrantPath(rawPath, resolvedAllowedRoots, resolveRealPath);
    grants.push({
      hostPath,
      guestPath: `/workspace/mnt/ro-${i}`,
      access: "readonly",
    });
  }

  for (let i = 0; i < writablePaths.length; i += 1) {
    const rawPath = writablePaths[i];
    if (rawPath === undefined) {
      continue;
    }
    const hostPath = validateHostGrantPath(rawPath, resolvedAllowedRoots, resolveRealPath);
    grants.push({
      hostPath,
      guestPath: `/workspace/mnt/rw-${i}`,
      access: "readwrite",
    });
  }

  return grants;
}
