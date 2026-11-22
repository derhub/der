export type SandboxControlErrorCode =
  | "docker.root_user_forbidden"
  | "docker.socket_mount_forbidden"
  | "docker.host_home_mount_forbidden"
  | "docker.bind_path_outside_root"
  | "docker.host_network_forbidden"
  | "docker.egress_host_not_approved"
  | "docker.egress_network_unverified"
  | "docker.invalid_resource_limits"
  | "docker.shadow_home_mismatch"
  | "docker.invalid_workspace_mount"
  | "docker.isolation_unverified"
  | "docker.launch_failed"
  | "docker.exec_failed"
  | "wasmer.unpinned_guest"
  | "wasmer.unsupported_guest"
  | "wasmer.artifact_missing"
  | "wasmer.digest_mismatch"
  | "wasmer.network_forbidden"
  | "wasmer.invalid_directory_grant"
  | "wasmer.directory_outside_root"
  | "wasmer.forbidden_path"
  | "wasmer.execution_failed";

export class SandboxControlError extends Error {
  readonly code: SandboxControlErrorCode;

  constructor(
    code: SandboxControlErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxControlError";
    this.code = code;
  }
}
