import type { ToolDescriptor } from "@der/domain";
import { SandboxControlError } from "./errors";

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
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}

function validateHostGrantPath(hostPath: string, allowedRoots: readonly string[]): string {
  const trimmed = hostPath.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new SandboxControlError(
      "wasmer.invalid_directory_grant",
      `Directory grant "${hostPath}" must be a clean absolute path.`,
    );
  }

  const segments = trimmed.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new SandboxControlError(
      "wasmer.invalid_directory_grant",
      `Directory grant "${hostPath}" cannot contain relative path segments.`,
    );
  }

  for (const pattern of FORBIDDEN_GRANT_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new SandboxControlError(
        "wasmer.forbidden_path",
        `Directory grant "${hostPath}" targets a forbidden host home, credential, or daemon socket path.`,
      );
    }
  }

  const normalized = normalizeRoot(trimmed);
  const inAllowedRoot = allowedRoots.some((root) => {
    const normRoot = normalizeRoot(root);
    return normalized === normRoot || normalized.startsWith(`${normRoot}/`);
  });

  if (!inAllowedRoot) {
    throw new SandboxControlError(
      "wasmer.directory_outside_root",
      `Directory grant "${hostPath}" is outside allowed host roots.`,
    );
  }

  return normalized;
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

  for (let i = 0; i < readonlyPaths.length; i += 1) {
    const rawPath = readonlyPaths[i];
    if (rawPath === undefined) {
      continue;
    }
    const hostPath = validateHostGrantPath(rawPath, policy.allowedHostRoots);
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
    const hostPath = validateHostGrantPath(rawPath, policy.allowedHostRoots);
    grants.push({
      hostPath,
      guestPath: `/workspace/mnt/rw-${i}`,
      access: "readwrite",
    });
  }

  return grants;
}
