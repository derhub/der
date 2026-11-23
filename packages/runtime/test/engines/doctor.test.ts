import { describe, expect, it } from "bun:test";
import { compiledParsers } from "@der/domain/compiled";
import {
  assertUnattendedEligible,
  DEFAULT_CLI_PINS,
  diagnoseAllEngines,
  diagnoseEngine,
  OFFICIAL_LOGIN_GUIDANCE,
  redactDiagnostics,
  verifyInstalledSdkApis,
  type EngineAuthProbeResult,
  type EngineDoctorConfig,
} from "@der/runtime/engines";
import type { CommandExecResult, CommandRunner } from "@der/runtime/sandbox";

function createDoctorRunner(responses: {
  readonly dockerInfo?: CommandExecResult;
  readonly cliVersions?: Readonly<Record<string, CommandExecResult>>;
  readonly agyAcpHelp?: CommandExecResult;
}): CommandRunner {
  return {
    async exec(command, args) {
      if (command === "docker" && args[0] === "info") {
        return (
          responses.dockerInfo ?? {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=rootless", "name=seccomp,profile=builtin"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          }
        );
      }
      if (args[0] === "acp" && args[1] === "--help") {
        return (
          responses.agyAcpHelp ?? {
            exitCode: 0,
            stdout:
              "Usage: agy acp [flags]\n  --stdio  Use stdio JSON-RPC transport\n  --login  Log in with Google interactively",
            stderr: "",
          }
        );
      }
      const matched = responses.cliVersions?.[command];
      if (matched) {
        return matched;
      }
      return { exitCode: 127, stdout: "", stderr: `${command}: command not found` };
    },
    async spawn() {
      throw new Error("spawn not expected during doctor probe");
    },
  };
}

function makeBaseDoctorConfig(
  engine: "codex" | "claude-code" | "antigravity",
  overrides?: Partial<EngineDoctorConfig>,
): EngineDoctorConfig {
  const cliVersions: Record<string, CommandExecResult> = {
    codex: { exitCode: 0, stdout: "codex-cli 0.171.0\n", stderr: "" },
    claude: { exitCode: 0, stdout: "2.1.330 (Claude Code)\n", stderr: "" },
    agy: { exitCode: 0, stdout: "1.5.9\n", stderr: "" },
  };
  return {
    engine,
    dockerHost: "unix:///run/user/1000/docker.sock",
    runner: createDoctorRunner({ cliVersions }),
    probeAuth: async (): Promise<EngineAuthProbeResult> => ({
      authenticated: true,
      detail: "Shadow home credentials present.",
    }),
    ...overrides,
  };
}

describe("verify installed SDK APIs and redact diagnostic secrets", () => {
  it("verifies required exports on installed TanStack AI sandbox and engine packages", () => {
    const result = verifyInstalledSdkApis();
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("redacts API keys, bearer tokens, JWTs, token fields, and host home paths", () => {
    const raw = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signature123",
      "OPENAI_API_KEY=sk-proj-secret1234567890abcdef",
      "ANTHROPIC_API_KEY=sk-ant-api03-secret9876543210",
      "refresh_token=rt_super_secret_token_999",
      "read failed at /home/alice/.codex/auth.json and /Users/bob/.claude.json",
    ].join("\n");

    const redacted = redactDiagnostics(raw);
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("sk-proj-secret");
    expect(redacted).not.toContain("sk-ant-api03-secret");
    expect(redacted).not.toContain("rt_super_secret_token_999");
    expect(redacted).not.toContain("/home/alice");
    expect(redacted).not.toContain("/Users/bob");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("<host-home>");
  });
});

describe("diagnose engine readiness, official login guidance, and independent interactive vs unattended eligibility", () => {
  it("returns login_required with redacted official login guidance for an empty shadow home", async () => {
    const readiness = await diagnoseEngine(
      makeBaseDoctorConfig("codex", {
        probeAuth: async () => ({
          authenticated: false,
          detail: "Empty shadow home at /home/alice/.codex; bearer sk-proj-leak1234567890 rejected",
        }),
      }),
    );

    expect(() => compiledParsers.engineReadiness.parse(readiness)).not.toThrow();
    expect(readiness.engine).toBe("codex");
    expect(readiness.interactive).toBe("login_required");
    expect(readiness.unattended).toBe("blocked");
    expect(readiness.isolationVerified).toBe(true);
    expect(readiness.loginGuidance).toBe(OFFICIAL_LOGIN_GUIDANCE.codex);
    expect(readiness.reasons.join("\n")).not.toContain("sk-proj-leak");
    expect(readiness.reasons.join("\n")).not.toContain("/home/alice");
  });

  it("keeps unattended coverage unverified by default even when interactive execution is ready", async () => {
    const readiness = await diagnoseEngine(makeBaseDoctorConfig("claude-code"));

    expect(readiness.interactive).toBe("ready");
    expect(readiness.unattended).toBe("unverified");
    expect(readiness.isolationVerified).toBe(true);

    const gate = assertUnattendedEligible(readiness);
    expect(gate).toEqual({
      allowed: false,
      reason: expect.stringContaining("unverified"),
    });
  });

  it("enables unattended readiness only when isolation, auth, CLI pins, and verified unattended terms all pass", async () => {
    const readiness = await diagnoseEngine(
      makeBaseDoctorConfig("antigravity", {
        terms: {
          interactive: "verified",
          unattended: "verified",
          verifiedAt: "2026-11-22",
          source: "https://example.invalid/terms",
        },
      }),
    );

    expect(readiness.interactive).toBe("ready");
    expect(readiness.unattended).toBe("ready");
    expect(readiness.isolationVerified).toBe(true);
    expect(assertUnattendedEligible(readiness)).toEqual({ allowed: true });
  });

  it("blocks unattended execution when terms prohibit unattended use while keeping interactive ready", async () => {
    const readiness = await diagnoseEngine(
      makeBaseDoctorConfig("codex", {
        terms: {
          interactive: "verified",
          unattended: "prohibited",
          verifiedAt: "2026-11-22",
        },
      }),
    );

    expect(readiness.interactive).toBe("ready");
    expect(readiness.unattended).toBe("blocked");
    expect(assertUnattendedEligible(readiness).allowed).toBe(false);
  });

  it("blocks readiness when Docker isolation enforcement fails, CLI version violates pin, or agy acp is unavailable", async () => {
    const unisolated = await diagnoseEngine(
      makeBaseDoctorConfig("codex", {
        runner: createDoctorRunner({
          dockerInfo: {
            exitCode: 0,
            stdout: JSON.stringify({
              ServerVersion: "29.10.0",
              SecurityOptions: ["name=seccomp"],
              MemoryLimit: true,
              CpuCfsQuota: true,
              PidsLimit: true,
            }),
            stderr: "",
          },
          cliVersions: { codex: { exitCode: 0, stdout: "codex-cli 0.171.0\n", stderr: "" } },
        }),
      }),
    );
    expect(unisolated.isolationVerified).toBe(false);
    expect(unisolated.interactive).toBe("blocked");
    expect(unisolated.unattended).toBe("blocked");

    const badPin = await diagnoseEngine(
      makeBaseDoctorConfig("claude-code", {
        cliPin: { ...DEFAULT_CLI_PINS["claude-code"], minVersion: "9.0.0" },
      }),
    );
    expect(badPin.interactive).toBe("blocked");
    expect(badPin.unattended).toBe("blocked");
    expect(badPin.reasons.some((r) => r.includes("9.0.0"))).toBe(true);

    const noAcp = await diagnoseEngine(
      makeBaseDoctorConfig("antigravity", {
        runner: createDoctorRunner({
          cliVersions: { agy: { exitCode: 0, stdout: "1.5.9\n", stderr: "" } },
          agyAcpHelp: { exitCode: 1, stdout: "", stderr: "unknown subcommand acp" },
        }),
      }),
    );
    expect(noAcp.interactive).toBe("blocked");
    expect(noAcp.unattended).toBe("blocked");
  });

  it("diagnoses all three official engines in parallel", async () => {
    const reports = await diagnoseAllEngines([
      makeBaseDoctorConfig("codex"),
      makeBaseDoctorConfig("claude-code"),
      makeBaseDoctorConfig("antigravity"),
    ]);

    expect(reports.map((report) => report.engine)).toEqual(["codex", "claude-code", "antigravity"]);
    expect(reports.every((report) => report.interactive === "ready")).toBe(true);
    expect(reports.every((report) => report.unattended === "unverified")).toBe(true);
  });
});
