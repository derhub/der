import {
  defineCapability,
  defineIntegration,
  DomainError,
  type Capability,
  type Integration,
  type JsonValue,
} from "@der/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { redactSecrets, ToolConfigurationError, ToolEffectUncertainError } from "./errors";

export type McpTransportConfig =
  | {
      readonly kind: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | {
      readonly kind: "streamable-http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly bearerToken?: string;
    }
  | {
      readonly kind: "custom";
      readonly createTransport: () => Transport | Promise<Transport>;
    };

export interface McpServerConfig {
  readonly id: string;
  readonly transport: McpTransportConfig;
  readonly allowedTools?: readonly string[];
  readonly readOnlyTools?: readonly string[];
  readonly defaultRequiresApproval?: boolean;
  readonly timeoutMs?: number;
  readonly redactedSecrets?: readonly string[];
}

export interface McpToolsOptions {
  readonly servers: readonly McpServerConfig[];
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface McpToolsHandle {
  capabilities(): Promise<readonly Capability[]>;
  close(): Promise<void>;
}

interface ConnectedServer {
  readonly config: McpServerConfig;
  readonly client: Client;
  readonly secrets: readonly string[];
}

const mcpArgumentsSchema = z.record(z.string(), z.unknown());

const VALID_SERVER_ID = /^[a-z0-9][a-z0-9_-]*$/;

function collectServerSecrets(config: McpServerConfig): string[] {
  const secrets: string[] = [...(config.redactedSecrets ?? [])];
  if (config.transport.kind === "streamable-http") {
    if (config.transport.bearerToken) {
      secrets.push(config.transport.bearerToken);
    }
    if (config.transport.headers) {
      for (const [key, value] of Object.entries(config.transport.headers)) {
        if (/authorization|token|secret|key/i.test(key) && value.length > 0) {
          secrets.push(value);
        }
      }
    }
  } else if (config.transport.kind === "stdio" && config.transport.env) {
    for (const [key, value] of Object.entries(config.transport.env)) {
      if (/token|secret|password|key/i.test(key) && value.length > 0) {
        secrets.push(value);
      }
    }
  }
  return secrets;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function textOf(blocks: readonly unknown[]): string[] {
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "object" && block !== null) {
      const entry = block as Record<string, unknown>;
      if (entry["type"] === "text" && typeof entry["text"] === "string") {
        texts.push(entry["text"]);
      }
    }
  }
  return texts;
}

function mcpValue(result: {
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: unknown;
}): JsonValue {
  if (result.structuredContent !== undefined) {
    return toJsonValue(result.structuredContent);
  }
  if (!Array.isArray(result.content)) {
    return null;
  }
  const texts = textOf(result.content);
  if (texts.length === 1 && result.content.length === 1) {
    try {
      return toJsonValue(JSON.parse(texts[0]!));
    } catch {
      return texts[0]!;
    }
  }
  return toJsonValue(result.content);
}

function mcpFailure(code: string, detail: string, capabilityId: string): DomainError {
  return new DomainError({
    type: `https://der.invalid/problems/${code.replaceAll(".", "-").replaceAll("_", "-")}`,
    title: "MCP call failed",
    status: 502,
    detail,
    instance: `/capabilities/${capabilityId}`,
    code,
  });
}

function identifierSegment(name: string): string {
  const segment = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(segment) ? segment : `_${segment}`;
}

async function buildTransport(config: McpServerConfig): Promise<Transport> {
  if (config.transport.kind === "custom") {
    return config.transport.createTransport();
  }
  if (config.transport.kind === "stdio") {
    return new StdioClientTransport({
      command: config.transport.command,
      ...(config.transport.args ? { args: [...config.transport.args] } : {}),
      ...(config.transport.env ? { env: { ...config.transport.env } } : {}),
      ...(config.transport.cwd !== undefined ? { cwd: config.transport.cwd } : {}),
    });
  }

  const headers: Record<string, string> = { ...config.transport.headers };
  if (config.transport.bearerToken !== undefined) {
    headers["Authorization"] = `Bearer ${config.transport.bearerToken}`;
  }

  return new StreamableHTTPClientTransport(
    new URL(config.transport.url),
    Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined,
  );
}

export function createMcpTools(options: McpToolsOptions): McpToolsHandle {
  const serverMap = new Map<string, McpServerConfig>();
  for (const server of options.servers) {
    if (!VALID_SERVER_ID.test(server.id)) {
      throw new ToolConfigurationError(
        "mcp.invalid_server_id",
        `MCP server id "${server.id}" must match ${VALID_SERVER_ID.source}.`,
      );
    }
    if (serverMap.has(server.id)) {
      throw new ToolConfigurationError(
        "mcp.duplicate_server_id",
        `Duplicate MCP server id "${server.id}".`,
      );
    }
    serverMap.set(server.id, server);
  }

  const connected = new Map<string, ConnectedServer>();

  const clientInfo = {
    name: options.clientName ?? "der-mcp",
    version: options.clientVersion ?? "0.1.0",
  };

  async function ensureConnected(serverId: string): Promise<ConnectedServer> {
    const existing = connected.get(serverId);
    if (existing) {
      return existing;
    }
    const config = serverMap.get(serverId);
    if (!config) {
      throw new ToolConfigurationError(
        "mcp.unknown_server",
        `MCP server "${serverId}" is not configured.`,
      );
    }
    const client = new Client(clientInfo);
    const transport = await buildTransport(config);
    await client.connect(transport);
    const entry: ConnectedServer = {
      config,
      client,
      secrets: collectServerSecrets(config),
    };
    connected.set(serverId, entry);
    return entry;
  }

  function mcpCapability(
    server: ConnectedServer,
    id: string,
    tool: Tool,
    requiresApproval: boolean,
  ): Capability {
    const summary = tool.description ?? tool.title ?? tool.name;
    return defineCapability({
      id,
      description: `${summary}\nInput JSON schema: ${JSON.stringify(tool.inputSchema)}`,
      input: mcpArgumentsSchema,
      output: z.unknown(),
      effect: "write",
      approval: requiresApproval ? "always" : "none",
      async execute(args) {
        let result: Awaited<ReturnType<Client["callTool"]>>;
        try {
          result = await server.client.callTool(
            { name: tool.name, arguments: args },
            undefined,
            server.config.timeoutMs !== undefined
              ? { timeout: server.config.timeoutMs }
              : undefined,
          );
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const safeMessage = redactSecrets(rawMessage, server.secrets);
          if (requiresApproval) {
            throw new ToolEffectUncertainError(
              `MCP write "${id}" outcome is uncertain after dispatch: ${safeMessage}`,
            );
          }
          throw mcpFailure("mcp.call_failed", safeMessage, id);
        }
        const outcome = result as {
          readonly structuredContent?: Record<string, unknown>;
          readonly content?: unknown;
          readonly isError?: boolean;
        };
        if (outcome.isError === true) {
          const detail = Array.isArray(outcome.content) ? textOf(outcome.content).join("\n") : "";
          throw mcpFailure(
            "mcp.tool_error",
            redactSecrets(detail || `MCP tool "${tool.name}" reported an error.`, server.secrets),
            id,
          );
        }
        return mcpValue(outcome);
      },
    }) as unknown as Capability;
  }

  return {
    async capabilities(): Promise<readonly Capability[]> {
      const capabilities = new Map<
        string,
        { readonly capability: Capability; readonly origin: string }
      >();

      for (const [serverId, config] of serverMap.entries()) {
        const server = await ensureConnected(serverId);
        const allowedSet = config.allowedTools ? new Set(config.allowedTools) : undefined;
        const readOnlySet = new Set(config.readOnlyTools ?? []);
        const defaultRequiresApproval = config.defaultRequiresApproval ?? true;

        const listed = await server.client.listTools();
        for (const tool of listed.tools) {
          if (allowedSet && !allowedSet.has(tool.name)) {
            continue;
          }
          const id = `mcp.${identifierSegment(serverId)}.${identifierSegment(tool.name)}`;
          const origin = `${serverId}/${tool.name}`;
          const existing = capabilities.get(id);
          if (existing) {
            throw new ToolConfigurationError(
              "mcp.duplicate_capability_id",
              `MCP tools "${existing.origin}" and "${origin}" both map to capability "${id}".`,
            );
          }
          const requiresApproval = readOnlySet.has(tool.name) ? false : defaultRequiresApproval;
          capabilities.set(id, {
            capability: mcpCapability(server, id, tool, requiresApproval),
            origin,
          });
        }
      }

      return [...capabilities.values()].map((entry) => entry.capability);
    },

    async close(): Promise<void> {
      const entries = [...connected.values()];
      connected.clear();
      await Promise.all(
        entries.map(async (entry) => {
          try {
            await entry.client.close();
          } catch {
            // Best-effort close for disconnected transports.
          }
        }),
      );
    },
  };
}

export function createMcpIntegration(
  options: McpToolsOptions & { readonly id?: string },
): Integration {
  return defineIntegration({
    id: options.id ?? "mcp",
    setup() {
      const handle = createMcpTools(options);
      return {
        listCapabilities: () => handle.capabilities(),
        stop: () => handle.close(),
      };
    },
  });
}
