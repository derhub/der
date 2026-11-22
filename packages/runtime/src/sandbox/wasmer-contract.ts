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
      packageRef: "sharrattj/bash@1.0.25",
      version: "1.0.25",
      digest: "sha256:4a6c2f7b1d8e9a0c3f5b7e2d1a9c4b8e6f0a2d4c8e1b3a5f7d9c2e4a6b8d0f12",
      commandName: "bash",
      artifactPath: "/guests/bash-1.0.25.webc",
      abi: "wasix",
    },
    python: {
      guest: "python",
      packageRef: "wasmer/python@3.12.2",
      version: "3.12.2",
      digest: "sha256:9f3e1c5a7b9d2e4f6a8c0b2d4e6f8a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d34",
      commandName: "python",
      artifactPath: "/guests/python-3.12.2.webc",
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
      guestPath: `/mnt/ro-${i}`,
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
      guestPath: `/mnt/rw-${i}`,
      access: "readwrite",
    });
  }

  return grants;
}
