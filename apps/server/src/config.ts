import * as z from "zod";
import { engineKind, type EngineKind } from "@der/domain";
import { compileSchema } from "@der/domain/compiled";
import type { McpServerConfig } from "@der/mcp";

const originString = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value
        );
      } catch {
        return false;
      }
    },
    {
      message: "Origin must be a canonical http(s) origin without path, query, or trailing slash.",
    },
  );

const nonRootDockerUser = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const uidPart = value.trim().split(":")[0];
      return uidPart !== undefined && uidPart.length > 0 && uidPart !== "0" && uidPart !== "root";
    },
    { message: "Docker container user must be non-root." },
  );

const egressNetworkName = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const lower = value.trim().toLowerCase();
      return (
        lower !== "host" &&
        lower !== "bridge" &&
        lower !== "default" &&
        lower !== "none" &&
        !lower.startsWith("container:") &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.trim())
      );
    },
    {
      message:
        'Docker egress network must be a dedicated isolated network, never "default", "host", "bridge", "none", or "container:*".',
    },
  );

const egressProxyUrl = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value.trim());
        return (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.hostname.length > 0
        );
      } catch {
        return false;
      }
    },
    {
      message:
        "Docker egress proxy URL must be a valid http(s) URL reachable on the internal egress network.",
    },
  );

const mcpTransportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("streamable-http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    bearerToken: z.string().min(1).optional(),
  }),
]);

const mcpServerConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  transport: mcpTransportSchema,
  allowedTools: z.array(z.string().min(1)).optional(),
  readOnlyTools: z.array(z.string().min(1)).optional(),
  defaultRequiresApproval: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  redactedSecrets: z.array(z.string().min(1)).optional(),
});

const engineImagesSchema = z.object({
  codex: z.string().min(1).default("der-engine-codex:latest"),
  claudeCode: z.string().min(1).default("der-engine-claude-code:latest"),
  antigravity: z.string().min(1).default("der-engine-antigravity:latest"),
});

const engineModelsSchema = z.object({
  codex: z.string().min(1).default("gpt-5-codex"),
  claudeCode: z.string().min(1).default("claude-sonnet-4-5"),
  antigravity: z.string().min(1).default("default"),
});

const serverConfigSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(3000),
    restateHost: z.string().min(1).default("127.0.0.1"),
    restateListen: z.number().int().min(0).max(65535).default(9080),
    restateIngressUrl: z.string().url().default("http://127.0.0.1:8080"),
    restateAdminUrl: z.string().url().default("http://127.0.0.1:9070"),
    restateDeploymentUrl: z.string().url().optional(),
    restateAutoRegister: z.boolean().default(false),
    restateMode: z.enum(["restate", "direct"]).default("restate"),
    databasePath: z.string().min(1).default("./data/der.sqlite"),
    memoryProjectionDir: z.string().min(1).default("./data/memory"),
    skillsRootDir: z.string().min(1).default("./data/skills"),
    workspaceRootDir: z.string().min(1).default("./data/workspaces"),
    contextMaxTokens: z.number().int().positive().default(32_000),
    // Below 1,024 bytes the truncation pointer alone can exceed the cap.
    memoryPromptMaxBytes: z.number().int().min(1024).default(24_000),
    skillCatalogMaxBytes: z.number().int().min(1024).default(8_000),
    engineCompactTokens: z.number().int().positive().default(100_000),
    allowedOrigins: z
      .array(originString)
      .default([
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ]),
    approvalTimeoutMs: z.number().int().positive().default(300_000),
    scriptMaxCalls: z.number().int().positive().default(100),
    scriptActiveMs: z.number().int().positive().default(30_000),
    scriptMemoryBytes: z.number().int().positive().default(268_435_456),
    scriptOutputBytes: z.number().int().positive().default(1_048_576),
    scriptResultBytes: z.number().int().positive().default(65_536),
    ssePollIntervalMs: z.number().int().positive().default(25),
    sseKeepAliveMs: z.number().int().positive().default(15_000),
    seedFixture: z.boolean().default(false),
    enabledEngines: z.array(engineKind).min(1).default(["codex", "claude-code", "antigravity"]),
    dockerHost: z.string().default(""),
    dockerBinary: z.string().min(1).default("docker"),
    dockerUser: nonRootDockerUser.default("1000:1000"),
    dockerCpus: z.number().positive().default(2),
    dockerMemoryMb: z.number().int().min(64).default(2048),
    dockerPidsLimit: z.number().int().min(16).default(256),
    dockerEgressNetwork: egressNetworkName.optional(),
    dockerEgressProxyUrl: egressProxyUrl.optional(),
    engineImages: engineImagesSchema.default({
      codex: "der-engine-codex:latest",
      claudeCode: "der-engine-claude-code:latest",
      antigravity: "der-engine-antigravity:latest",
    }),
    engineModels: engineModelsSchema.default({
      codex: "gpt-5-codex",
      claudeCode: "claude-sonnet-4-5",
      antigravity: "default",
    }),
    wasmerRunnerImage: z.string().min(1).default("der-wasmer-runner:latest"),
    wasmerAllowedRoots: z.array(z.string().min(1)).default([]),
    wasmerMaxTimeoutMs: z.number().int().positive().default(30_000),
    mcpServers: z.array(mcpServerConfigSchema).default([]),
    outboxPollIntervalMs: z.number().int().positive().default(500),
    outboxInitialBackoffMs: z.number().int().positive().default(1_000),
    outboxMaxBackoffMs: z.number().int().positive().default(60_000),
  })
  .superRefine((value, ctx) => {
    if (value.dockerEgressNetwork !== undefined && value.dockerEgressProxyUrl === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["dockerEgressProxyUrl"],
        message:
          "DER_DOCKER_EGRESS_PROXY_URL is required when DER_DOCKER_EGRESS_NETWORK is configured.",
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ParsedMcpServerConfig = McpServerConfig;

export const compiledServerConfig = compileSchema(serverConfigSchema);

function parseOptionalInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new RangeError(`Configuration ${name} must be an integer, received "${raw}".`);
  }
  return value;
}

function parseOptionalNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new RangeError(`Configuration ${name} must be a finite number, received "${raw}".`);
  }
  return value;
}

function parseOptionalBoolean(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new RangeError(`Configuration ${name} must be a boolean, received "${raw}".`);
}

function parseOptionalCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalMcpServers(raw: string | undefined): ServerConfig["mcpServers"] | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new RangeError("Configuration DER_MCP_SERVERS_JSON must be valid JSON.");
  }
  return z.array(mcpServerConfigSchema).parse(decoded);
}

export function parseServerConfig(
  overrides?: Partial<ServerConfig>,
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const port = parseOptionalInt(env["DER_PORT"], "DER_PORT");
  const restateListen = parseOptionalInt(env["DER_RESTATE_PORT"], "DER_RESTATE_PORT");
  const allowedOrigins = parseOptionalCsv(env["DER_ALLOWED_ORIGINS"]);
  const approvalTimeoutMs = parseOptionalInt(
    env["DER_APPROVAL_TIMEOUT_MS"],
    "DER_APPROVAL_TIMEOUT_MS",
  );
  const scriptMaxCalls = parseOptionalInt(env["DER_SCRIPT_MAX_CALLS"], "DER_SCRIPT_MAX_CALLS");
  const scriptActiveMs = parseOptionalInt(env["DER_SCRIPT_ACTIVE_MS"], "DER_SCRIPT_ACTIVE_MS");
  const scriptMemoryBytes = parseOptionalInt(
    env["DER_SCRIPT_MEMORY_BYTES"],
    "DER_SCRIPT_MEMORY_BYTES",
  );
  const scriptOutputBytes = parseOptionalInt(
    env["DER_SCRIPT_OUTPUT_BYTES"],
    "DER_SCRIPT_OUTPUT_BYTES",
  );
  const scriptResultBytes = parseOptionalInt(
    env["DER_SCRIPT_RESULT_BYTES"],
    "DER_SCRIPT_RESULT_BYTES",
  );
  const ssePollIntervalMs = parseOptionalInt(
    env["DER_SSE_POLL_INTERVAL_MS"],
    "DER_SSE_POLL_INTERVAL_MS",
  );
  const sseKeepAliveMs = parseOptionalInt(env["DER_SSE_KEEP_ALIVE_MS"], "DER_SSE_KEEP_ALIVE_MS");
  const contextMaxTokens = parseOptionalInt(
    env["DER_CONTEXT_MAX_TOKENS"],
    "DER_CONTEXT_MAX_TOKENS",
  );
  const memoryPromptMaxBytes = parseOptionalInt(
    env["DER_MEMORY_PROMPT_MAX_BYTES"],
    "DER_MEMORY_PROMPT_MAX_BYTES",
  );
  const skillCatalogMaxBytes = parseOptionalInt(
    env["DER_SKILL_CATALOG_MAX_BYTES"],
    "DER_SKILL_CATALOG_MAX_BYTES",
  );
  const engineCompactTokens = parseOptionalInt(
    env["DER_ENGINE_COMPACT_TOKENS"],
    "DER_ENGINE_COMPACT_TOKENS",
  );
  const seedFixture = parseOptionalBoolean(env["DER_SEED_FIXTURE"], "DER_SEED_FIXTURE");
  const restateAutoRegister = parseOptionalBoolean(
    env["DER_RESTATE_AUTO_REGISTER"],
    "DER_RESTATE_AUTO_REGISTER",
  );
  const enabledEnginesRaw = parseOptionalCsv(env["DER_ENABLED_ENGINES"]);
  const dockerCpus = parseOptionalNumber(env["DER_DOCKER_CPUS"], "DER_DOCKER_CPUS");
  const dockerMemoryMb = parseOptionalInt(env["DER_DOCKER_MEMORY_MB"], "DER_DOCKER_MEMORY_MB");
  const dockerPidsLimit = parseOptionalInt(env["DER_DOCKER_PIDS_LIMIT"], "DER_DOCKER_PIDS_LIMIT");
  const wasmerAllowedRoots = parseOptionalCsv(env["DER_WASMER_ALLOWED_ROOTS"]);
  const wasmerMaxTimeoutMs = parseOptionalInt(
    env["DER_WASMER_MAX_TIMEOUT_MS"],
    "DER_WASMER_MAX_TIMEOUT_MS",
  );
  const mcpServers = parseOptionalMcpServers(env["DER_MCP_SERVERS_JSON"]);
  const outboxPollIntervalMs = parseOptionalInt(
    env["DER_OUTBOX_POLL_INTERVAL_MS"],
    "DER_OUTBOX_POLL_INTERVAL_MS",
  );
  const outboxInitialBackoffMs = parseOptionalInt(
    env["DER_OUTBOX_INITIAL_BACKOFF_MS"],
    "DER_OUTBOX_INITIAL_BACKOFF_MS",
  );
  const outboxMaxBackoffMs = parseOptionalInt(
    env["DER_OUTBOX_MAX_BACKOFF_MS"],
    "DER_OUTBOX_MAX_BACKOFF_MS",
  );

  const rawRestateMode = env["DER_RESTATE_MODE"]?.trim();
  if (
    rawRestateMode !== undefined &&
    rawRestateMode !== "" &&
    rawRestateMode !== "restate" &&
    rawRestateMode !== "direct"
  ) {
    throw new RangeError(
      `Configuration DER_RESTATE_MODE must be "restate" or "direct", received "${rawRestateMode}".`,
    );
  }

  const engineImagesFromEnv: Partial<ServerConfig["engineImages"]> = {
    ...(env["DER_ENGINE_IMAGE_CODEX"] ? { codex: env["DER_ENGINE_IMAGE_CODEX"] } : {}),
    ...(env["DER_ENGINE_IMAGE_CLAUDE_CODE"]
      ? { claudeCode: env["DER_ENGINE_IMAGE_CLAUDE_CODE"] }
      : {}),
    ...(env["DER_ENGINE_IMAGE_ANTIGRAVITY"]
      ? { antigravity: env["DER_ENGINE_IMAGE_ANTIGRAVITY"] }
      : {}),
  };

  const engineModelsFromEnv: Partial<ServerConfig["engineModels"]> = {
    ...(env["DER_ENGINE_MODEL_CODEX"] ? { codex: env["DER_ENGINE_MODEL_CODEX"] } : {}),
    ...(env["DER_ENGINE_MODEL_CLAUDE_CODE"]
      ? { claudeCode: env["DER_ENGINE_MODEL_CLAUDE_CODE"] }
      : {}),
    ...(env["DER_ENGINE_MODEL_ANTIGRAVITY"]
      ? { antigravity: env["DER_ENGINE_MODEL_ANTIGRAVITY"] }
      : {}),
  };

  const fromEnv: Partial<ServerConfig> = {
    ...(env["DER_HOST"] ? { host: env["DER_HOST"] } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(env["DER_RESTATE_HOST"] ? { restateHost: env["DER_RESTATE_HOST"] } : {}),
    ...(restateListen !== undefined ? { restateListen } : {}),
    ...(env["DER_RESTATE_INGRESS_URL"]
      ? { restateIngressUrl: env["DER_RESTATE_INGRESS_URL"] }
      : {}),
    ...(env["DER_RESTATE_ADMIN_URL"] ? { restateAdminUrl: env["DER_RESTATE_ADMIN_URL"] } : {}),
    ...(env["DER_RESTATE_DEPLOYMENT_URL"]
      ? { restateDeploymentUrl: env["DER_RESTATE_DEPLOYMENT_URL"] }
      : {}),
    ...(restateAutoRegister !== undefined ? { restateAutoRegister } : {}),
    ...(rawRestateMode === "restate" || rawRestateMode === "direct"
      ? { restateMode: rawRestateMode }
      : {}),
    ...(env["DER_DATABASE_PATH"] ? { databasePath: env["DER_DATABASE_PATH"] } : {}),
    ...(env["DER_MEMORY_PROJECTION_DIR"]
      ? { memoryProjectionDir: env["DER_MEMORY_PROJECTION_DIR"] }
      : {}),
    ...(env["DER_SKILLS_ROOT_DIR"] ? { skillsRootDir: env["DER_SKILLS_ROOT_DIR"] } : {}),
    ...(env["DER_WORKSPACE_ROOT_DIR"] ? { workspaceRootDir: env["DER_WORKSPACE_ROOT_DIR"] } : {}),
    ...(contextMaxTokens !== undefined ? { contextMaxTokens } : {}),
    ...(memoryPromptMaxBytes !== undefined ? { memoryPromptMaxBytes } : {}),
    ...(skillCatalogMaxBytes !== undefined ? { skillCatalogMaxBytes } : {}),
    ...(engineCompactTokens !== undefined ? { engineCompactTokens } : {}),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    ...(scriptMaxCalls !== undefined ? { scriptMaxCalls } : {}),
    ...(scriptActiveMs !== undefined ? { scriptActiveMs } : {}),
    ...(scriptMemoryBytes !== undefined ? { scriptMemoryBytes } : {}),
    ...(scriptOutputBytes !== undefined ? { scriptOutputBytes } : {}),
    ...(scriptResultBytes !== undefined ? { scriptResultBytes } : {}),
    ...(ssePollIntervalMs !== undefined ? { ssePollIntervalMs } : {}),
    ...(sseKeepAliveMs !== undefined ? { sseKeepAliveMs } : {}),
    ...(seedFixture !== undefined ? { seedFixture } : {}),
    ...(enabledEnginesRaw !== undefined
      ? { enabledEngines: enabledEnginesRaw as EngineKind[] }
      : {}),
    ...(env["DER_DOCKER_HOST"] !== undefined ? { dockerHost: env["DER_DOCKER_HOST"].trim() } : {}),
    ...(env["DER_DOCKER_BINARY"] ? { dockerBinary: env["DER_DOCKER_BINARY"] } : {}),
    ...(env["DER_DOCKER_USER"] ? { dockerUser: env["DER_DOCKER_USER"] } : {}),
    ...(dockerCpus !== undefined ? { dockerCpus } : {}),
    ...(dockerMemoryMb !== undefined ? { dockerMemoryMb } : {}),
    ...(dockerPidsLimit !== undefined ? { dockerPidsLimit } : {}),
    ...(env["DER_DOCKER_EGRESS_NETWORK"]
      ? { dockerEgressNetwork: env["DER_DOCKER_EGRESS_NETWORK"].trim() }
      : {}),
    ...(env["DER_DOCKER_EGRESS_PROXY_URL"]?.trim()
      ? { dockerEgressProxyUrl: env["DER_DOCKER_EGRESS_PROXY_URL"].trim() }
      : {}),
    ...(Object.keys(engineImagesFromEnv).length > 0
      ? {
          engineImages: engineImagesSchema.parse(engineImagesFromEnv),
        }
      : {}),
    ...(Object.keys(engineModelsFromEnv).length > 0
      ? {
          engineModels: engineModelsSchema.parse(engineModelsFromEnv),
        }
      : {}),
    ...(env["DER_WASMER_RUNNER_IMAGE"]
      ? { wasmerRunnerImage: env["DER_WASMER_RUNNER_IMAGE"].trim() }
      : {}),
    ...(wasmerAllowedRoots !== undefined ? { wasmerAllowedRoots } : {}),
    ...(wasmerMaxTimeoutMs !== undefined ? { wasmerMaxTimeoutMs } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(outboxPollIntervalMs !== undefined ? { outboxPollIntervalMs } : {}),
    ...(outboxInitialBackoffMs !== undefined ? { outboxInitialBackoffMs } : {}),
    ...(outboxMaxBackoffMs !== undefined ? { outboxMaxBackoffMs } : {}),
  };

  return compiledServerConfig.parse({
    ...fromEnv,
    ...overrides,
    ...(overrides?.engineImages
      ? {
          engineImages: engineImagesSchema.parse({
            ...engineImagesFromEnv,
            ...overrides.engineImages,
          }),
        }
      : {}),
    ...(overrides?.engineModels
      ? {
          engineModels: engineModelsSchema.parse({
            ...engineModelsFromEnv,
            ...overrides.engineModels,
          }),
        }
      : {}),
  });
}
