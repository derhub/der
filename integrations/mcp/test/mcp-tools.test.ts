import { afterEach, describe, expect, it } from "bun:test";
import { DomainError, IntegrationRegistry, type Catalog } from "@der/domain";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createMcpIntegration,
  ToolConfigurationError,
  ToolEffectUncertainError,
  type McpServerConfig,
} from "../src/index";

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) {
      await close();
    }
  }
});

async function startFixtureMcpServer(extraToolNames: readonly string[] = []) {
  const server = new McpServer({ name: "notes-server", version: "1.0.0" });
  const writes: Array<{ title: string; body: string }> = [];
  let dropOnWrite = false;

  server.registerTool(
    "search_notes",
    {
      title: "Search Notes",
      description: "Search read-only operator notes.",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ query }) => ({
      content: [{ type: "text", text: JSON.stringify({ matches: [`note:${query}`] }) }],
      structuredContent: { matches: [`note:${query}`] },
    }),
  );

  server.registerTool(
    "append_note",
    {
      title: "Append Note",
      description: "Write a new note entry.",
      inputSchema: { title: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, body }) => {
      if (dropOnWrite) {
        await serverTransport.close();
        throw new Error("connection reset with secret-mcp-token-999");
      }
      writes.push({ title, body });
      return {
        content: [{ type: "text", text: `Saved ${title}` }],
        structuredContent: { saved: true, title },
      };
    },
  );

  server.registerTool(
    "archive-note",
    {
      description: "Archive a note by title.",
      inputSchema: { title: z.string() },
    },
    async ({ title }) => ({
      content: [{ type: "text", text: JSON.stringify({ archived: title }) }],
    }),
  );

  server.registerTool(
    "broken_note",
    { description: "Always reports a tool error.", inputSchema: {} },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "note store is read-only" }],
    }),
  );

  for (const name of extraToolNames) {
    server.registerTool(name, { description: `Extra ${name}.`, inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  closers.push(() => server.close());

  return {
    clientTransport,
    writes,
    setDropOnWrite: (value: boolean) => {
      dropOnWrite = value;
    },
  };
}

async function startCatalog(
  fixture: { readonly clientTransport: InMemoryTransport },
  server: Partial<McpServerConfig> = {},
): Promise<Catalog> {
  const registry = new IntegrationRegistry();
  await registry.register(
    createMcpIntegration({
      servers: [
        {
          id: "notes",
          transport: { kind: "custom", createTransport: () => fixture.clientTransport },
          allowedTools: ["search_notes", "append_note"],
          readOnlyTools: ["search_notes"],
          redactedSecrets: ["secret-mcp-token-999"],
          ...server,
        },
      ],
    }),
  );
  closers.push(() => registry.stop());
  await registry.start();
  return registry.catalog;
}

describe("expose remote MCP tools as capabilities", () => {
  it("lists each tool as a write capability that asks approval unless the operator marked it read-only", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer());

    expect(
      catalog.list().map((entry) => ({
        id: entry.id,
        effect: entry.effect,
        requiresApproval: entry.requiresApproval,
      })),
    ).toEqual([
      { id: "mcp.notes.append_note", effect: "write", requiresApproval: true },
      { id: "mcp.notes.search_notes", effect: "write", requiresApproval: false },
    ]);
    expect(catalog.requiresApproval("mcp.notes.append_note", { title: "t", body: "b" })).toBe(true);
    expect(catalog.requiresApproval("mcp.notes.search_notes", { query: "q" })).toBe(false);
  });

  it("declares an unknown output and carries the remote description and input schema, without credentials", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer());

    const [hit] = catalog.search("append_note");
    const described = catalog.list().find((entry) => entry.id === "mcp.notes.append_note");

    expect(hit?.id).toBe("mcp.notes.append_note");
    expect(hit?.summary).toBe("Write a new note entry.");
    expect(hit?.declaration).toContain("type McpNotesAppendNoteOutput = unknown;");
    expect(described?.description).toContain('"required":["title","body"]');
    expect(JSON.stringify(catalog.list())).not.toContain("secret-mcp-token-999");
  });

  it("requires approval for every tool when the server is not told which tools are read-only", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer(), {
      allowedTools: ["search_notes"],
      readOnlyTools: [],
    });

    expect(catalog.list().map((entry) => [entry.id, entry.requiresApproval])).toEqual([
      ["mcp.notes.search_notes", true],
    ]);
  });

  it("asks no approval for any tool when the server defaults to no approval", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer(), {
      readOnlyTools: [],
      defaultRequiresApproval: false,
    });

    expect(catalog.list().map((entry) => [entry.id, entry.requiresApproval])).toEqual([
      ["mcp.notes.append_note", false],
      ["mcp.notes.search_notes", false],
    ]);
  });

  it("leaves out a tool the operator did not allow", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer());

    expect(catalog.list().map((entry) => entry.id)).not.toContain("mcp.notes.hidden_admin");
  });
});

describe("call a remote MCP tool through the catalog", () => {
  it("returns the structured content of a read-only tool and of a write", async () => {
    const fixture = await startFixtureMcpServer();
    const catalog = await startCatalog(fixture);

    expect(await catalog.invoke("mcp.notes.search_notes", { query: "uptime" }, {})).toEqual({
      matches: ["note:uptime"],
    });
    expect(
      await catalog.invoke("mcp.notes.append_note", { title: "Shift", body: "All green" }, {}),
    ).toEqual({ saved: true, title: "Shift" });
    expect(fixture.writes).toEqual([{ title: "Shift", body: "All green" }]);
  });

  it("fails with a typed error and the redacted tool text when the remote tool reports an error", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer(), {
      allowedTools: ["broken_note"],
    });

    const caught = await catalog.invoke("mcp.notes.broken_note", {}, {}).catch((error) => error);

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("mcp.tool_error");
    expect((caught as DomainError).message).toBe("note store is read-only");
  });

  it("raises ToolEffectUncertainError with redacted details when a dispatched write loses transport", async () => {
    const fixture = await startFixtureMcpServer();
    const catalog = await startCatalog(fixture);
    fixture.setDropOnWrite(true);

    const caught = await catalog
      .invoke("mcp.notes.append_note", { title: "Incident", body: "Lost ack" }, {})
      .catch((error) => error);

    expect(caught).toBeInstanceOf(ToolEffectUncertainError);
    expect((caught as ToolEffectUncertainError).code).toBe("effect.outcome_uncertain");
    expect((caught as ToolEffectUncertainError).message).not.toContain("secret-mcp-token-999");
  });

  it("fails with a typed error, not an uncertain outcome, when a tool that asks no approval loses transport", async () => {
    const fixture = await startFixtureMcpServer();
    const catalog = await startCatalog(fixture, { readOnlyTools: ["append_note"] });
    fixture.setDropOnWrite(true);

    const caught = await catalog
      .invoke("mcp.notes.append_note", { title: "Incident", body: "Lost ack" }, {})
      .catch((error) => error);

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("mcp.call_failed");
    expect((caught as DomainError).message).not.toContain("secret-mcp-token-999");
  });
});

describe("name a remote tool as a capability id", () => {
  it("replaces characters that are not identifier characters and still calls the remote name", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer(), {
      id: "team-notes",
      allowedTools: ["archive-note"],
    });

    expect(catalog.list().map((entry) => entry.id)).toEqual(["mcp.team_notes.archive_note"]);
    expect(await catalog.invoke("mcp.team_notes.archive_note", { title: "old" }, {})).toEqual({
      archived: "old",
    });
  });

  it("prefixes a segment that starts with a digit", async () => {
    const catalog = await startCatalog(await startFixtureMcpServer(["9lives"]), {
      id: "2fa",
      allowedTools: ["9lives"],
    });

    expect(catalog.list().map((entry) => entry.id)).toEqual(["mcp._2fa._9lives"]);
  });

  it("fails start naming both remote tools when two names map to one capability id", async () => {
    const fixture = await startFixtureMcpServer(["sync-all", "sync_all"]);

    const caught = await startCatalog(fixture, { allowedTools: ["sync-all", "sync_all"] }).catch(
      (error) => error,
    );

    expect(caught).toBeInstanceOf(ToolConfigurationError);
    expect((caught as ToolConfigurationError).code).toBe("mcp.duplicate_capability_id");
    expect((caught as ToolConfigurationError).message).toBe(
      'MCP tools "notes/sync-all" and "notes/sync_all" both map to capability "mcp.notes.sync_all".',
    );
  });

  it("fails start when a second integration contributes an id the MCP integration already registered", async () => {
    const fixture = await startFixtureMcpServer();
    const registry = new IntegrationRegistry();
    await registry.register(
      createMcpIntegration({
        servers: [
          {
            id: "notes",
            transport: { kind: "custom", createTransport: () => fixture.clientTransport },
            allowedTools: ["search_notes"],
          },
        ],
      }),
    );
    const sameTools = await startFixtureMcpServer();
    await registry.register(
      createMcpIntegration({
        id: "mcp-second",
        servers: [
          {
            id: "notes",
            transport: { kind: "custom", createTransport: () => sameTools.clientTransport },
            allowedTools: ["search_notes"],
          },
        ],
      }),
    );
    closers.push(() => registry.stop());

    const caught = await registry.start().catch((error) => error);

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("integration.duplicate_capability_id");
  });
});
