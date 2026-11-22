import type { JsonValue, ToolDescriptor, ToolOperation, ToolResult, Tools } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { deniedToolResult, type ApprovalVerifier } from "./authorization";
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
  readonly verifyApproval?: ApprovalVerifier;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export interface McpToolsHandle extends Tools {
  list(): Promise<readonly ToolDescriptor[]>;
  invoke(operation: ToolOperation): Promise<ToolResult>;
  close(): Promise<void>;
}

interface DiscoveredTool {
  readonly serverId: string;
  readonly toolName: string;
  readonly descriptor: ToolDescriptor;
}

interface ConnectedServer {
  readonly config: McpServerConfig;
  readonly client: Client;
  readonly secrets: readonly string[];
}

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

function normalizeMcpCallOutcome(result: {
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: unknown;
  readonly isError?: boolean;
}): ToolResult {
  const isError = result.isError === true;
  if (result.structuredContent !== undefined) {
    return compiledParsers.toolResult.parse({
      ok: !isError,
      isError,
      outcome: toJsonValue(result.structuredContent),
    });
  }

  if (Array.isArray(result.content)) {
    const textBlocks: string[] = [];
    const normalizedBlocks: JsonValue[] = [];
    for (const block of result.content) {
      if (typeof block === "object" && block !== null) {
        const entry = block as Record<string, unknown>;
        if (entry["type"] === "text" && typeof entry["text"] === "string") {
          textBlocks.push(entry["text"]);
        }
        normalizedBlocks.push(toJsonValue(entry));
      }
    }

    if (textBlocks.length === 1 && normalizedBlocks.length === 1) {
      const single = textBlocks[0]!;
      try {
        return compiledParsers.toolResult.parse({
          ok: !isError,
          isError,
          outcome: toJsonValue(JSON.parse(single)),
        });
      } catch {
        return compiledParsers.toolResult.parse({
          ok: !isError,
          isError,
          outcome: single,
          ...(isError ? { detail: single } : {}),
        });
      }
    }

    return compiledParsers.toolResult.parse({
      ok: !isError,
      isError,
      outcome: normalizedBlocks,
      ...(isError && textBlocks.length > 0 ? { detail: textBlocks.join("\n") } : {}),
    });
  }

  return compiledParsers.toolResult.parse({
    ok: !isError,
    isError,
    outcome: null,
  });
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
  const catalog = new Map<string, DiscoveredTool>();
  let catalogLoaded = false;

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

  async function refreshCatalog(): Promise<readonly ToolDescriptor[]> {
    catalog.clear();
    const descriptors: ToolDescriptor[] = [];

    for (const [serverId, config] of serverMap.entries()) {
      const serverConn = await ensureConnected(serverId);
      const allowedSet = config.allowedTools ? new Set(config.allowedTools) : undefined;
      const readOnlySet = new Set(config.readOnlyTools ?? []);
      const defaultRequiresApproval = config.defaultRequiresApproval ?? true;

      const listed = await serverConn.client.listTools();
      for (const tool of listed.tools) {
        if (allowedSet && !allowedSet.has(tool.name)) {
          continue;
        }
        const operationId = `${serverId}.${tool.name}`;
        const annotationReadOnly =
          tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
        const requiresApproval = readOnlySet.has(tool.name)
          ? false
          : annotationReadOnly
            ? false
            : defaultRequiresApproval;

        const descriptor = compiledParsers.toolDescriptor.parse({
          kind: "mcp",
          id: operationId,
          name: tool.title ?? tool.name,
          description: tool.description ?? "",
          requiresApproval,
          inputSchema: toJsonValue(tool.inputSchema),
        });

        catalog.set(operationId, {
          serverId,
          toolName: tool.name,
          descriptor,
        });
        descriptors.push(descriptor);
      }
    }

    descriptors.sort((a, b) => a.id.localeCompare(b.id));
    catalogLoaded = true;
    return descriptors;
  }

  return {
    async list(): Promise<readonly ToolDescriptor[]> {
      return refreshCatalog();
    },

    async invoke(operation: ToolOperation): Promise<ToolResult> {
      const parsedOp = compiledParsers.toolOperation.safeParse(operation);
      if (!parsedOp.success) {
        return deniedToolResult(
          "tool.invalid_arguments",
          `Invalid tool operation payload: ${parsedOp.error.message}`,
        );
      }

      const { effect } = parsedOp.data;
      if (effect.operationKind !== "mcp") {
        return deniedToolResult(
          "tool.unrecognized_operation",
          `Operation kind "${effect.operationKind}" is not handled by the MCP adapter.`,
        );
      }

      if (!catalogLoaded) {
        await refreshCatalog();
      }

      const discovered = catalog.get(effect.operationId);
      if (!discovered) {
        return deniedToolResult(
          "tool.unrecognized_operation",
          `MCP operation "${effect.operationId}" is not recognized or allowed.`,
        );
      }

      if (
        effect.canonicalArguments === null ||
        typeof effect.canonicalArguments !== "object" ||
        Array.isArray(effect.canonicalArguments)
      ) {
        return deniedToolResult(
          "tool.invalid_arguments",
          `MCP operation "${effect.operationId}" requires a JSON object argument payload.`,
        );
      }

      if (discovered.descriptor.requiresApproval && options.verifyApproval) {
        const authorized = await options.verifyApproval(effect);
        if (!authorized) {
          return deniedToolResult(
            "tool.approval_required",
            `Exact-operation approval is required for MCP operation "${effect.operationId}".`,
          );
        }
      }

      const serverConn = await ensureConnected(discovered.serverId);
      try {
        const rawResult = await serverConn.client.callTool(
          {
            name: discovered.toolName,
            arguments: effect.canonicalArguments as Record<string, unknown>,
          },
          undefined,
          serverConn.config.timeoutMs !== undefined
            ? { timeout: serverConn.config.timeoutMs }
            : undefined,
        );

        return normalizeMcpCallOutcome(
          rawResult as {
            readonly structuredContent?: Record<string, unknown>;
            readonly content?: unknown;
            readonly isError?: boolean;
          },
        );
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const safeMessage = redactSecrets(rawMessage, serverConn.secrets);

        if (discovered.descriptor.requiresApproval) {
          throw new ToolEffectUncertainError(
            effect,
            `MCP write "${effect.operationId}" outcome is uncertain after dispatch: ${safeMessage}`,
          );
        }

        return compiledParsers.toolResult.parse({
          ok: false,
          isError: true,
          outcome: { code: "mcp.call_failed" },
          detail: safeMessage,
        });
      }
    },

    async close(): Promise<void> {
      const entries = [...connected.values()];
      connected.clear();
      catalog.clear();
      catalogLoaded = false;
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
