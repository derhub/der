import { afterEach, describe, expect, it } from "bun:test";
import type { EffectIdentity, ToolOperation } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createExactApprovalVerifier,
  createHostTools,
  createMcpTools,
  ToolEffectUncertainError,
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

async function startFixtureMcpServer() {
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
    "hidden_admin",
    {
      title: "Hidden Admin",
      description: "Unlisted tool.",
      inputSchema: { cmd: z.string() },
    },
    async ({ cmd }) => ({
      content: [{ type: "text", text: cmd }],
    }),
  );

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

function makeOperation(overrides: Partial<EffectIdentity>): ToolOperation {
  return {
    effect: {
      runId: "run-1",
      operationKind: "mcp",
      operationId: "notes.search_notes",
      canonicalArguments: { query: "uptime" },
      attemptId: "attempt-1",
      ...overrides,
    },
  };
}

describe("MCP tools adapter with typed descriptors, exact-operation approval, and effect certainty", () => {
  it("lists verified descriptors, keeps credentials internal, runs read-only tools, and enforces exact approval on writes", async () => {
    const fixture = await startFixtureMcpServer();
    const approvedEffect: EffectIdentity = {
      runId: "run-1",
      operationKind: "mcp",
      operationId: "notes.append_note",
      canonicalArguments: { title: "Shift", body: "All green" },
      attemptId: "attempt-write-1",
    };

    const mcp = createMcpTools({
      servers: [
        {
          id: "notes",
          transport: { kind: "custom", createTransport: () => fixture.clientTransport },
          allowedTools: ["search_notes", "append_note"],
          readOnlyTools: ["search_notes"],
          redactedSecrets: ["secret-mcp-token-999"],
        },
      ],
      verifyApproval: createExactApprovalVerifier([approvedEffect]),
    });
    closers.push(() => mcp.close());

    const descriptors = await mcp.list();
    expect(descriptors.map((d) => ({ id: d.id, requiresApproval: d.requiresApproval }))).toEqual([
      { id: "notes.append_note", requiresApproval: true },
      { id: "notes.search_notes", requiresApproval: false },
    ]);
    for (const descriptor of descriptors) {
      expect(compiledParsers.toolDescriptor.safeParse(descriptor).success).toBe(true);
      expect(JSON.stringify(descriptor)).not.toContain("secret-mcp-token-999");
    }

    const readResult = await mcp.invoke(makeOperation({}));
    expect(compiledParsers.toolResult.parse(readResult)).toEqual({
      ok: true,
      isError: false,
      outcome: { matches: ["note:uptime"] },
    });

    const unapprovedWrite = await mcp.invoke(
      makeOperation({
        operationId: "notes.append_note",
        canonicalArguments: { title: "Shift", body: "Mutated payload" },
        attemptId: "attempt-write-1",
      }),
    );
    expect(unapprovedWrite.ok).toBe(false);
    expect(unapprovedWrite.isError).toBe(true);
    expect(unapprovedWrite.outcome).toEqual({
      denied: true,
      code: "tool.approval_required",
    });
    expect(fixture.writes).toHaveLength(0);

    const approvedWrite = await mcp.invoke({ effect: approvedEffect });
    expect(compiledParsers.toolResult.parse(approvedWrite)).toEqual({
      ok: true,
      isError: false,
      outcome: { saved: true, title: "Shift" },
    });
    expect(fixture.writes).toEqual([{ title: "Shift", body: "All green" }]);

    const unrecognized = await mcp.invoke(
      makeOperation({ operationId: "notes.hidden_admin", canonicalArguments: { cmd: "rm" } }),
    );
    expect(unrecognized.ok).toBe(false);
    expect(unrecognized.outcome).toEqual({
      denied: true,
      code: "tool.unrecognized_operation",
    });

    const hostTools = createHostTools([mcp]);
    const wrongKind = await hostTools.invoke(
      makeOperation({ operationKind: "docker", operationId: "docker.exec" }),
    );
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.outcome).toEqual({
      denied: true,
      code: "tool.unrecognized_operation",
    });
  });

  it("raises ToolEffectUncertainError with redacted details when a dispatched MCP write loses transport", async () => {
    const fixture = await startFixtureMcpServer();
    const writeEffect: EffectIdentity = {
      runId: "run-2",
      operationKind: "mcp",
      operationId: "notes.append_note",
      canonicalArguments: { title: "Incident", body: "Lost ack" },
      attemptId: "attempt-write-2",
    };

    const mcp = createMcpTools({
      servers: [
        {
          id: "notes",
          transport: { kind: "custom", createTransport: () => fixture.clientTransport },
          allowedTools: ["append_note"],
          redactedSecrets: ["secret-mcp-token-999"],
        },
      ],
      verifyApproval: createExactApprovalVerifier([writeEffect]),
    });
    closers.push(() => mcp.close());

    await mcp.list();
    fixture.setDropOnWrite(true);

    let caught: unknown;
    try {
      await mcp.invoke({ effect: writeEffect });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolEffectUncertainError);
    expect((caught as ToolEffectUncertainError).code).toBe("effect.outcome_uncertain");
    expect((caught as ToolEffectUncertainError).message).not.toContain("secret-mcp-token-999");
  });

  it("requires exact-operation approval for remote readOnlyHint tools unless operator-allowlisted in readOnlyTools", async () => {
    const fixture = await startFixtureMcpServer();
    const approvedReadEffect: EffectIdentity = {
      runId: "run-3",
      operationKind: "mcp",
      operationId: "notes.search_notes",
      canonicalArguments: { query: "approved" },
      attemptId: "attempt-read-1",
    };

    const mcp = createMcpTools({
      servers: [
        {
          id: "notes",
          transport: { kind: "custom", createTransport: () => fixture.clientTransport },
          allowedTools: ["search_notes"],
        },
      ],
      verifyApproval: createExactApprovalVerifier([approvedReadEffect]),
    });
    closers.push(() => mcp.close());

    const descriptors = await mcp.list();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.id).toBe("notes.search_notes");
    expect(descriptors[0]?.requiresApproval).toBe(true);

    const denied = await mcp.invoke(
      makeOperation({
        runId: "run-3",
        operationId: "notes.search_notes",
        canonicalArguments: { query: "unapproved" },
        attemptId: "attempt-read-unapproved",
      }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.outcome).toEqual({
      denied: true,
      code: "tool.approval_required",
    });

    const allowed = await mcp.invoke({ effect: approvedReadEffect });
    expect(allowed.ok).toBe(true);
    expect(allowed.outcome).toEqual({ matches: ["note:approved"] });

    const fixtureNoVerifier = await startFixtureMcpServer();
    const mcpWithoutVerifier = createMcpTools({
      servers: [
        {
          id: "notes",
          transport: { kind: "custom", createTransport: () => fixtureNoVerifier.clientTransport },
          allowedTools: ["search_notes"],
        },
      ],
    });
    closers.push(() => mcpWithoutVerifier.close());

    const closedResult = await mcpWithoutVerifier.invoke(
      makeOperation({
        runId: "run-4",
        operationId: "notes.search_notes",
        canonicalArguments: { query: "no-verifier" },
        attemptId: "attempt-read-2",
      }),
    );
    expect(closedResult.ok).toBe(false);
    expect(closedResult.outcome).toEqual({
      denied: true,
      code: "tool.approval_required",
    });
  });
});
