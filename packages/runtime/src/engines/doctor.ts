import type { EngineReadiness } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { chat } from "@tanstack/ai";
import { acpCompatible, acpCompatibleText, startAcpSession } from "@tanstack/ai-acp";
import { claudeCodeText } from "@tanstack/ai-claude-code";
import { codexText } from "@tanstack/ai-codex";
import {
  defineSandbox,
  defineSandboxPolicy,
  provideToolBridgeProvisioner,
  withSandbox,
} from "@tanstack/ai-sandbox";
import {
  DEFAULT_ENGINE_SHADOW_HOMES,
  probeDockerIsolation,
  type OfficialEngineKind,
} from "../sandbox/docker-policy";
import { bunCommandRunner, type CommandRunner } from "../sandbox/process-runner";
import { redactDiagnostics } from "./redaction";

export interface EngineCliPin {
  readonly engine: OfficialEngineKind;
  readonly executable: string;
  readonly versionArgs: readonly string[];
  readonly minVersion: string;
  readonly acpProbeArgs?: readonly string[];
}

export type TermsCoverageStatus = "verified" | "prohibited" | "unverified";

export interface EngineTermsCoverage {
  readonly interactive: TermsCoverageStatus;
  readonly unattended: TermsCoverageStatus;
  readonly verifiedAt?: string;
  readonly source?: string;
}

export interface EngineAuthProbeResult {
  readonly authenticated: boolean;
  readonly detail?: string;
}

export interface EngineSdkCheckResult {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

export interface EngineDoctorConfig {
  readonly engine: OfficialEngineKind;
  readonly dockerHost: string;
  readonly dockerBinary?: string;
  readonly cliPin?: EngineCliPin;
  readonly terms?: EngineTermsCoverage;
  readonly runner?: CommandRunner;
  readonly probeAuth?: () => Promise<EngineAuthProbeResult>;
  readonly headlessSupported?: boolean;
}

export const DEFAULT_CLI_PINS: Readonly<Record<OfficialEngineKind, EngineCliPin>> = {
  codex: {
    engine: "codex",
    executable: "codex",
    versionArgs: ["--version"],
    minVersion: "0.100.0",
  },
  "claude-code": {
    engine: "claude-code",
    executable: "claude",
    versionArgs: ["--version"],
    minVersion: "2.0.0",
  },
  antigravity: {
    engine: "antigravity",
    executable: "agy",
    versionArgs: ["--version"],
    minVersion: "1.0.0",
    acpProbeArgs: ["acp", "--help"],
  },
} as const;

export const OFFICIAL_LOGIN_GUIDANCE: Readonly<Record<OfficialEngineKind, string>> = {
  codex: `Sign in via the official Codex CLI inside shadow-home volume "${DEFAULT_ENGINE_SHADOW_HOMES.codex.volumeName}": run "codex login --device-auth" with CODEX_HOME=/home/engine/.codex.`,
  "claude-code": `Sign in via the official Claude Code CLI inside shadow-home volume "${DEFAULT_ENGINE_SHADOW_HOMES["claude-code"].volumeName}": run "claude login" with CLAUDE_CONFIG_DIR=/home/engine/.claude.`,
  antigravity: `Sign in via the official Antigravity CLI inside shadow-home volume "${DEFAULT_ENGINE_SHADOW_HOMES.antigravity.volumeName}": run "agy acp --login" with HOME=/home/engine.`,
} as const;

export const DEFAULT_TERMS_COVERAGE: Readonly<Record<OfficialEngineKind, EngineTermsCoverage>> = {
  codex: {
    interactive: "verified",
    unattended: "unverified",
  },
  "claude-code": {
    interactive: "verified",
    unattended: "unverified",
  },
  antigravity: {
    interactive: "verified",
    unattended: "unverified",
  },
} as const;

export function verifyInstalledSdkApis(): EngineSdkCheckResult {
  const checks: readonly [string, unknown][] = [
    ["@tanstack/ai:chat", chat],
    ["@tanstack/ai-sandbox:defineSandbox", defineSandbox],
    ["@tanstack/ai-sandbox:withSandbox", withSandbox],
    ["@tanstack/ai-sandbox:defineSandboxPolicy", defineSandboxPolicy],
    ["@tanstack/ai-sandbox:provideToolBridgeProvisioner", provideToolBridgeProvisioner],
    ["@tanstack/ai-codex:codexText", codexText],
    ["@tanstack/ai-claude-code:claudeCodeText", claudeCodeText],
    ["@tanstack/ai-acp:acpCompatible", acpCompatible],
    ["@tanstack/ai-acp:acpCompatibleText", acpCompatibleText],
    ["@tanstack/ai-acp:startAcpSession", startAcpSession],
  ];

  const missing: string[] = [];
  for (const [label, fn] of checks) {
    if (typeof fn !== "function") {
      missing.push(label);
    }
  }
  return {
    ok: missing.length === 0,
    missing,
  };
}

function parseSemver(output: string): readonly [number, number, number] | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return [major, minor, patch];
}

function compareSemver(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (actual[i] ?? 0) - (minimum[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export async function diagnoseEngine(config: EngineDoctorConfig): Promise<EngineReadiness> {
  const runner = config.runner ?? bunCommandRunner;
  const cliPin = config.cliPin ?? DEFAULT_CLI_PINS[config.engine];
  const terms = config.terms ?? DEFAULT_TERMS_COVERAGE[config.engine];
  const reasons: string[] = [];

  const sdkCheck = verifyInstalledSdkApis();
  if (!sdkCheck.ok) {
    reasons.push(`Missing required SDK APIs: ${sdkCheck.missing.join(", ")}.`);
  }

  const isolation = await probeDockerIsolation({
    dockerHost: config.dockerHost,
    ...(config.dockerBinary !== undefined ? { dockerBinary: config.dockerBinary } : {}),
    runner,
  });
  for (const reason of isolation.reasons) {
    reasons.push(redactDiagnostics(reason));
  }

  let cliOk = true;
  try {
    const versionResult = await runner.exec(cliPin.executable, cliPin.versionArgs);
    if (versionResult.exitCode !== 0) {
      cliOk = false;
      reasons.push(
        redactDiagnostics(
          `CLI "${cliPin.executable}" unavailable (exit ${versionResult.exitCode}).`,
        ),
      );
    } else {
      const parsedActual = parseSemver(`${versionResult.stdout}\n${versionResult.stderr}`);
      const parsedMin = parseSemver(cliPin.minVersion);
      if (!parsedActual || !parsedMin || compareSemver(parsedActual, parsedMin) < 0) {
        cliOk = false;
        reasons.push(
          `CLI "${cliPin.executable}" version does not satisfy minimum pin ${cliPin.minVersion}.`,
        );
      }
    }
  } catch (error) {
    cliOk = false;
    reasons.push(
      redactDiagnostics(
        `CLI "${cliPin.executable}" probe failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  if (cliOk && cliPin.acpProbeArgs) {
    try {
      const acpProbe = await runner.exec(cliPin.executable, cliPin.acpProbeArgs);
      if (acpProbe.exitCode !== 0 || !acpProbe.stdout.includes("--stdio")) {
        cliOk = false;
        reasons.push(`CLI "${cliPin.executable}" does not advertise ACP stdio support.`);
      }
    } catch (error) {
      cliOk = false;
      reasons.push(
        redactDiagnostics(
          `ACP capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  const authResult: EngineAuthProbeResult = config.probeAuth
    ? await config.probeAuth()
    : { authenticated: false, detail: "Shadow home login state has not been verified." };

  if (!authResult.authenticated && authResult.detail) {
    reasons.push(redactDiagnostics(authResult.detail));
  }

  const technicallySound = sdkCheck.ok && isolation.isolationVerified && cliOk;

  let interactive: EngineReadiness["interactive"];
  if (!technicallySound) {
    interactive = "blocked";
  } else if (terms.interactive === "prohibited" || terms.interactive === "unverified") {
    interactive = "blocked";
    reasons.push(`Interactive terms coverage for "${config.engine}" is ${terms.interactive}.`);
  } else if (!authResult.authenticated) {
    interactive = "login_required";
  } else {
    interactive = "ready";
  }

  let unattended: EngineReadiness["unattended"];
  if (!technicallySound || !authResult.authenticated || config.headlessSupported === false) {
    unattended = "blocked";
    if (config.headlessSupported === false) {
      reasons.push(`Engine "${config.engine}" does not support headless unattended execution.`);
    }
  } else if (terms.unattended === "prohibited") {
    unattended = "blocked";
    reasons.push(`Unattended scheduled terms coverage for "${config.engine}" is prohibited.`);
  } else if (terms.unattended === "unverified") {
    unattended = "unverified";
    reasons.push(
      `Unattended scheduled terms coverage for "${config.engine}" is unverified; scheduled execution remains disabled.`,
    );
  } else {
    unattended = "ready";
  }

  const loginGuidance =
    interactive === "login_required"
      ? redactDiagnostics(OFFICIAL_LOGIN_GUIDANCE[config.engine])
      : undefined;

  return compiledParsers.engineReadiness.parse({
    engine: config.engine,
    interactive,
    unattended,
    isolationVerified: isolation.isolationVerified,
    reasons: reasons.map((reason) => redactDiagnostics(reason)),
    ...(loginGuidance !== undefined ? { loginGuidance } : {}),
  });
}

export async function diagnoseAllEngines(
  configs: readonly EngineDoctorConfig[],
): Promise<EngineReadiness[]> {
  return Promise.all(configs.map((config) => diagnoseEngine(config)));
}

export function assertUnattendedEligible(
  readiness: EngineReadiness,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (!readiness.isolationVerified) {
    return {
      allowed: false,
      reason: `Engine "${readiness.engine}" isolation is unverified.`,
    };
  }
  if (readiness.unattended !== "ready") {
    return {
      allowed: false,
      reason: `Engine "${readiness.engine}" unattended scheduled eligibility is "${readiness.unattended}".`,
    };
  }
  return { allowed: true };
}
