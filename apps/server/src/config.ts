import * as z from "zod";
import { compileSchema } from "@der/domain/compiled";

const serverConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(3000),
  restateHost: z.string().min(1).default("127.0.0.1"),
  restateListen: z.number().int().min(0).max(65535).default(9080),
  restateIngressUrl: z.string().url().default("http://127.0.0.1:8080"),
  restateAdminUrl: z.string().url().default("http://127.0.0.1:9070"),
  restateMode: z.enum(["restate", "direct"]).default("restate"),
  databasePath: z.string().min(1).default("./data/der.sqlite"),
  allowedOrigins: z
    .array(z.string().min(1))
    .default([
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]),
  approvalTimeoutMs: z.number().int().positive().default(300_000),
  ssePollIntervalMs: z.number().int().positive().default(25),
  sseKeepAliveMs: z.number().int().positive().default(15_000),
  seedFixture: z.boolean().default(false),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const compiledServerConfig = compileSchema(serverConfigSchema);

function parseOptionalInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new RangeError(`Expected integer configuration value, received "${raw}".`);
  }
  return value;
}

function parseOptionalOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function parseServerConfig(
  overrides?: Partial<ServerConfig>,
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const port = parseOptionalInt(env["DER_PORT"]);
  const restateListen = parseOptionalInt(env["DER_RESTATE_PORT"]);
  const allowedOrigins = parseOptionalOrigins(env["DER_ALLOWED_ORIGINS"]);
  const approvalTimeoutMs = parseOptionalInt(env["DER_APPROVAL_TIMEOUT_MS"]);
  const ssePollIntervalMs = parseOptionalInt(env["DER_SSE_POLL_INTERVAL_MS"]);
  const sseKeepAliveMs = parseOptionalInt(env["DER_SSE_KEEP_ALIVE_MS"]);

  const fromEnv: Partial<ServerConfig> = {
    ...(env["DER_HOST"] !== undefined ? { host: env["DER_HOST"] } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(env["DER_RESTATE_HOST"] !== undefined ? { restateHost: env["DER_RESTATE_HOST"] } : {}),
    ...(restateListen !== undefined ? { restateListen } : {}),
    ...(env["DER_RESTATE_INGRESS_URL"] !== undefined
      ? { restateIngressUrl: env["DER_RESTATE_INGRESS_URL"] }
      : {}),
    ...(env["DER_RESTATE_ADMIN_URL"] !== undefined
      ? { restateAdminUrl: env["DER_RESTATE_ADMIN_URL"] }
      : {}),
    ...(env["DER_RESTATE_MODE"] === "restate" || env["DER_RESTATE_MODE"] === "direct"
      ? { restateMode: env["DER_RESTATE_MODE"] }
      : {}),
    ...(env["DER_DATABASE_PATH"] !== undefined ? { databasePath: env["DER_DATABASE_PATH"] } : {}),
    ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    ...(ssePollIntervalMs !== undefined ? { ssePollIntervalMs } : {}),
    ...(sseKeepAliveMs !== undefined ? { sseKeepAliveMs } : {}),
    ...(env["DER_SEED_FIXTURE"] !== undefined
      ? { seedFixture: env["DER_SEED_FIXTURE"] === "true" || env["DER_SEED_FIXTURE"] === "1" }
      : {}),
  };

  return compiledServerConfig.parse({
    ...fromEnv,
    ...overrides,
  });
}
