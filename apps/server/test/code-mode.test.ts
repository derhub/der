import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod";
import {
  defineCapability,
  formatUtcTimestamp,
  type Capability,
  type Engine,
  type EngineEvent,
  type EngineKind,
  type ExecuteResult,
  type Run,
} from "@der/domain";
import type { AnyTool } from "@tanstack/ai";
import { createExecuteTool } from "#code-mode/execute";
import { boundResult } from "#code-mode/result-boundary";
import { codeModeInstructions } from "#code-mode/instructions";
import { createSearchTool } from "#code-mode/search";
import { createFixtureCapabilities } from "#capabilities/fixture";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase, waitUntil } from "./fixtures/restate-harness";
import { admitOwningRun, createNoteHost, type NoteHost } from "./fixtures/script-host";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

const RESULT_BYTES = 65_536;

async function startDirectServer(
  options: {
    readonly engines?: ReadonlyMap<EngineKind, Engine>;
    readonly extra?: readonly Capability[];
  } = {},
) {
  const tempDb = createTempDatabase("der-code-mode-");
  const host: NoteHost = createNoteHost();
  for (const capability of options.extra ?? []) {
    host.catalog.add(capability);
  }
  const server: RunningServer = await startServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      restateMode: "direct",
      databasePath: tempDb.dbPath,
      memoryProjectionDir: `${tempDb.dir}/memory`,
      skillsRootDir: `${tempDb.dir}/skills`,
      workspaceRootDir: `${tempDb.dir}/workspaces`,
      enabledEngines: ["fixture"],
      approvalTimeoutMs: 30_000,
      seedFixture: true,
    },
    catalog: host.catalog,
    ...(options.engines === undefined ? {} : { engines: options.engines }),
  });
  cleanups.push(async () => {
    await server.close();
    tempDb.cleanup();
  });
  return { server, host };
}

const ATTENDED_WAIT_MS = 60_000;

function executeToolFor(server: RunningServer, run: Run, maxResultBytes = RESULT_BYTES): AnyTool {
  return createExecuteTool({
    run,
    scriptRunStore: server.scriptRunStore,
    scriptDriver: server.scriptDriver,
    maxResultBytes,
    inlineWaitMs: ATTENDED_WAIT_MS,
  });
}

function callTool(
  tool: AnyTool,
  args: unknown,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<ExecuteResult> {
  return tool.execute!(args, { signal }) as Promise<ExecuteResult>;
}

function awaitPendingApproval(server: RunningServer, runId: string) {
  return waitUntil(
    async () => {
      const approval = server.store.getLatestApprovalForRun(runId);
      return approval?.decision.status === "pending" ? approval : false;
    },
    { timeoutMs: 20_000, label: "pending approval" },
  );
}

function scriptRunCount(server: RunningServer, runId: string): number {
  return server.store.database.db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM script_runs WHERE run_id = ?")
    .get(runId)!.n;
}

function decide(
  server: RunningServer,
  approval: { readonly id: string },
  owner: { readonly run: Run; readonly botId: string; readonly sessionId: string },
  status: "approved" | "denied" | "expired",
) {
  return server.commands.decideApproval({
    approvalId: approval.id,
    botId: owner.botId,
    sessionId: owner.sessionId,
    runId: owner.run.id,
    status,
    ...(status === "expired" ? {} : { actor: "operator" }),
    decidedAt: formatUtcTimestamp(new Date()),
  } as Parameters<RunningServer["coordinator"]["decide"]>[0]);
}

const transfer = defineCapability({
  id: "bank.transfer",
  description: "Move money",
  input: z.object({ amount: z.number() }),
  output: z.object({ moved: z.number() }),
  effect: "write",
  approval: (input) => input.amount > 100,
  async execute({ amount }) {
    return { moved: amount };
  },
}) as unknown as Capability;

const PUBLISH = `return await step.run("notes.publish", { text: "release" });`;

describe("execute a gated script through the tool", () => {
  it("raises one approval, then returns the value with one effect once the approval is granted", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-approval");
    const execute = executeToolFor(server, owner.run);

    const pending = callTool(execute, { script: PUBLISH });
    const approval = await awaitPendingApproval(server, owner.run.id);
    expect(host.published).toEqual([]);
    const detail = await fetch(`${server.url}/api/runs/${owner.run.id}`);
    expect(await detail.json()).toMatchObject({
      approvals: [
        {
          id: approval.id,
          effect: {
            operationId: "notes.publish",
            canonicalArguments: { text: "release" },
          },
        },
      ],
    });
    const decision = await fetch(`${server.url}/api/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: owner.botId,
        sessionId: owner.sessionId,
        runId: owner.run.id,
        status: "approved",
        actor: "operator",
      }),
    });
    expect(decision.status).toBe(200);

    expect(await pending).toEqual({
      ok: true,
      result: { published: true },
      logs: [],
      truncated: false,
    });
    expect(host.published).toEqual(["release"]);
    expect(
      server.store.getEffect({ ...approval.effect, operationKind: "capability" })?.status,
    ).toBe("completed");
  }, 60_000);

  it("asks no approval when the capability's approval rule says the input is small", async () => {
    const { server } = await startDirectServer({ extra: [transfer] });
    const owner = await admitOwningRun(server, "code-mode-approval-rule");
    const execute = executeToolFor(server, owner.run);

    const result = await callTool(execute, {
      script: `return await step.run("bank.transfer", { amount: 5 });`,
    });

    expect(result).toEqual({ ok: true, result: { moved: 5 }, logs: [], truncated: false });
    expect(server.store.getLatestApprovalForRun(owner.run.id)).toBeUndefined();
  }, 60_000);

  it("asks for approval when the capability's approval rule says the input is large", async () => {
    const { server } = await startDirectServer({ extra: [transfer] });
    const owner = await admitOwningRun(server, "code-mode-approval-rule-large");
    const execute = executeToolFor(server, owner.run);

    const pending = callTool(execute, {
      script: `return await step.run("bank.transfer", { amount: 500 });`,
    });
    const approval = await awaitPendingApproval(server, owner.run.id);
    await decide(server, approval, owner, "approved");

    expect(await pending).toEqual({ ok: true, result: { moved: 500 }, logs: [], truncated: false });
  }, 60_000);
});

describe("pick a script back up after the tool call was cut", () => {
  it("attaches to the same script run and effect when execute is called again after an abort", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-attach");
    const execute = executeToolFor(server, owner.run);
    const cut = new AbortController();

    const first = callTool(execute, { script: PUBLISH }, cut.signal);
    const approval = await awaitPendingApproval(server, owner.run.id);
    cut.abort();

    expect(await first).toMatchObject({
      ok: false,
      error: { kind: "cancelled", message: expect.any(String) },
      logs: [],
    });
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("pending");

    await decide(server, approval, owner, "approved");
    const second = await callTool(execute, { script: PUBLISH });

    expect(second).toEqual({ ok: true, result: { published: true }, logs: [], truncated: false });
    expect(host.published).toEqual(["release"]);
    expect(scriptRunCount(server, owner.run.id)).toBe(1);
  }, 60_000);
});

describe("run multiple Scripts in one Run", () => {
  it("runs a different Script while another waits on approval", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-concurrent");
    const execute = executeToolFor(server, owner.run);
    const first = callTool(execute, { script: PUBLISH });
    const approval = await awaitPendingApproval(server, owner.run.id);

    expect(
      await callTool(execute, { script: `return await step.run("notes.read", { key: "a" });` }),
    ).toEqual({ ok: true, result: { value: "value-a" }, logs: [], truncated: false });
    expect(host.published).toEqual([]);

    await decide(server, approval, owner, "approved");
    expect(await first).toEqual({
      ok: true,
      result: { published: true },
      logs: [],
      truncated: false,
    });
    expect(host.published).toEqual(["release"]);
    expect(scriptRunCount(server, owner.run.id)).toBe(2);
  });
});

describe("repeat a script on purpose", () => {
  it("runs the same script again when given a new key, giving two script runs and two effects", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-repeat");
    const execute = executeToolFor(server, owner.run);
    const append = `return await step.run("notes.append", { text: "tick" });`;

    const first = await callTool(execute, { script: append });
    const second = await callTool(execute, { script: append, key: "again" });

    expect(first).toEqual({ ok: true, result: { count: 1 }, logs: [], truncated: false });
    expect(second).toEqual({ ok: true, result: { count: 2 }, logs: [], truncated: false });
    expect(host.appended).toEqual(["tick", "tick"]);
    expect(scriptRunCount(server, owner.run.id)).toBe(2);
  }, 60_000);
});

describe("report a refused approval", () => {
  it.each(["denied", "expired"] as const)(
    "returns ok false with kind %s and records no effect",
    async (status) => {
      const { server, host } = await startDirectServer();
      const owner = await admitOwningRun(server, `code-mode-${status}`);
      const execute = executeToolFor(server, owner.run);

      const pending = callTool(execute, { script: PUBLISH });
      const approval = await awaitPendingApproval(server, owner.run.id);
      await decide(server, approval, owner, status);

      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: status, call: "notes.publish", message: expect.any(String) },
        logs: [],
      });
      expect(host.published).toEqual([]);
      expect(
        server.store.getEffect({ ...approval.effect, operationKind: "capability" }),
      ).toBeUndefined();
    },
    60_000,
  );

  it("returns ok false with kind script for arguments that are not a script", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-bad-args");

    const result = await callTool(executeToolFor(server, owner.run), { script: 7 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("script");
  }, 60_000);
});

describe("cancel script runs at run end", () => {
  it("cancels a script run parked on an approval when the run finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedEngine: Engine = {
      kind: "fixture",
      async *run(run: Run): AsyncIterable<EngineEvent> {
        yield {
          type: "chunk",
          chunkKey: `${run.id}:started`,
          chunk: { type: "RUN_STARTED", threadId: run.sessionId, runId: run.id },
        };
        await gate;
        yield { type: "completed" };
      },
    };
    const { server } = await startDirectServer({
      engines: new Map<EngineKind, Engine>([["fixture", gatedEngine]]),
    });
    const botId = server.seededFixture!.bot.id;
    const sessionId = server.seededFixture!.session.id;
    const { run } = await server.coordinator.admit({
      botId,
      sessionId,
      origin: "http",
      idempotencyKey: "code-mode-run-end",
      input: { parts: [{ type: "text", text: "owner" }] },
    });
    await waitUntil(async () => server.store.getRun(run.id)?.status === "running", {
      timeoutMs: 10_000,
      label: "run started",
    });

    const pending = callTool(executeToolFor(server, run), { script: PUBLISH });
    const approval = await awaitPendingApproval(server, run.id);
    release();
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "script cancelled" },
      logs: [],
    });
    expect(server.store.getRun(run.id)?.status).toBe("completed");
    expect(server.store.listPendingApprovalsForRun(run.id)).toEqual([]);
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("expired");
  }, 60_000);
});

type DeclarationToken = {
  readonly kind: "ident" | "string" | "punct" | "doc";
  readonly value: string;
};

interface ParsedProperty {
  readonly type: string;
  readonly optional: boolean;
  readonly doc: string;
}

type ParsedType = string | Readonly<Record<string, ParsedProperty>>;

interface ParsedDeclaration {
  readonly types: Readonly<Record<string, ParsedType>>;
  readonly stepRun: {
    readonly id: string;
    readonly inputType: string;
    readonly outputType: string;
    readonly doc: string;
  };
}

function cleanDocComment(raw: string): string {
  return raw
    .replace(/^\/\*\*?|\*\/$/g, "")
    .replace(/^\/\//gm, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeDeclaration(source: string): DeclarationToken[] {
  const tokens: DeclarationToken[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index]!;
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        throw new Error("Unterminated block comment in declaration");
      }
      tokens.push({ kind: "doc", value: cleanDocComment(source.slice(index, end + 2)) });
      index = end + 2;
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      const stop = end < 0 ? source.length : end;
      tokens.push({ kind: "doc", value: cleanDocComment(source.slice(index, stop)) });
      index = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== ch) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (source[index] !== ch) {
        throw new Error("Unterminated string literal in declaration");
      }
      index += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) {
        end += 1;
      }
      tokens.push({ kind: "ident", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", value: ch });
    index += 1;
  }
  return tokens;
}

function formatTypeTokens(tokens: readonly DeclarationToken[]): string {
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "doc") {
      continue;
    }
    if (token.kind === "ident" && token.value === "Array" && tokens[i + 1]?.value === "<") {
      let depth = 0;
      let j = i + 1;
      for (; j < tokens.length; j += 1) {
        if (tokens[j]!.value === "<") depth += 1;
        else if (tokens[j]!.value === ">") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const inner = formatTypeTokens(tokens.slice(i + 2, j));
      parts.push(/[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`);
      i = j;
      continue;
    }
    if (token.kind === "string") {
      parts.push(JSON.stringify(token.value));
    } else if (token.value === "|" || token.value === "&") {
      parts.push(` ${token.value} `);
    } else if (token.value === ",") {
      parts.push(", ");
    } else {
      parts.push(token.value);
    }
  }
  return parts.join("");
}

function parseDeclaration(source: string): ParsedDeclaration {
  const tokens = tokenizeDeclaration(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => {
    const token = tokens[pos];
    if (!token) {
      throw new Error("Unexpected end of declaration");
    }
    pos += 1;
    return token;
  };
  const takeDocs = () => {
    const docs: string[] = [];
    while (peek()?.kind === "doc") {
      const value = take().value;
      if (value.length > 0) {
        docs.push(value);
      }
    }
    return docs.join(" ");
  };
  const expectToken = (kind: DeclarationToken["kind"], value?: string) => {
    const token = take();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected ${kind} ${value ?? ""}, got ${token.kind} ${token.value}`);
    }
    return token;
  };
  const readTypeTokens = (stops: ReadonlySet<string>): DeclarationToken[] => {
    const collected: DeclarationToken[] = [];
    let angle = 0;
    let paren = 0;
    let brace = 0;
    let bracket = 0;
    while (pos < tokens.length) {
      const token = peek()!;
      if (
        angle === 0 &&
        paren === 0 &&
        brace === 0 &&
        bracket === 0 &&
        token.kind === "punct" &&
        stops.has(token.value)
      ) {
        break;
      }
      take();
      if (token.kind === "punct") {
        if (token.value === "<") angle += 1;
        else if (token.value === ">") angle -= 1;
        else if (token.value === "(") paren += 1;
        else if (token.value === ")") paren -= 1;
        else if (token.value === "{") brace += 1;
        else if (token.value === "}") brace -= 1;
        else if (token.value === "[") bracket += 1;
        else if (token.value === "]") bracket -= 1;
      }
      collected.push(token);
    }
    return collected;
  };
  const parseObjectType = (): Record<string, ParsedProperty> => {
    expectToken("punct", "{");
    const properties: Record<string, ParsedProperty> = {};
    while (pos < tokens.length) {
      const doc = takeDocs();
      if (peek()?.kind === "punct" && peek()?.value === "}") {
        take();
        return properties;
      }
      const key = take();
      if (key.kind !== "ident" && key.kind !== "string") {
        throw new Error(`Unexpected property key ${key.kind} ${key.value}`);
      }
      let optional = false;
      if (peek()?.kind === "punct" && peek()?.value === "?") {
        take();
        optional = true;
      }
      expectToken("punct", ":");
      const type = formatTypeTokens(readTypeTokens(new Set([";", ",", "}"])));
      if (peek()?.kind === "punct" && (peek()?.value === ";" || peek()?.value === ",")) {
        take();
      }
      properties[key.value] = { type, optional, doc };
    }
    throw new Error("Unterminated object type in declaration");
  };

  const types: Record<string, ParsedType> = {};
  let stepRun: ParsedDeclaration["stepRun"] | undefined;
  while (pos < tokens.length) {
    const doc = takeDocs();
    if (pos >= tokens.length) {
      break;
    }
    const lead = take();
    if (lead.kind === "ident" && lead.value === "type") {
      const name = expectToken("ident").value;
      expectToken("punct", "=");
      types[name] =
        peek()?.kind === "punct" && peek()?.value === "{"
          ? parseObjectType()
          : formatTypeTokens(readTypeTokens(new Set([";"])));
      if (peek()?.kind === "punct" && peek()?.value === ";") {
        take();
      }
      continue;
    }
    if (lead.kind === "ident" && lead.value === "interface") {
      const name = expectToken("ident").value;
      types[name] = parseObjectType();
      continue;
    }
    if (lead.kind === "ident" && lead.value === "declare") {
      expectToken("ident", "const");
      expectToken("ident", "step");
      expectToken("punct", ":");
      expectToken("punct", "{");
      const memberDoc = takeDocs();
      expectToken("ident", "run");
      expectToken("punct", "(");
      expectToken("ident");
      expectToken("punct", ":");
      const id = expectToken("string").value;
      expectToken("punct", ",");
      expectToken("ident");
      expectToken("punct", ":");
      const inputType = formatTypeTokens(readTypeTokens(new Set([",", ")"])));
      if (peek()?.kind === "punct" && peek()?.value === ",") {
        take();
      }
      expectToken("punct", ")");
      expectToken("punct", ":");
      expectToken("ident", "Promise");
      expectToken("punct", "<");
      const outputType = formatTypeTokens(readTypeTokens(new Set([">"])));
      expectToken("punct", ">");
      if (peek()?.kind === "punct" && (peek()?.value === ";" || peek()?.value === ",")) {
        take();
      }
      expectToken("punct", "}");
      if (peek()?.kind === "punct" && peek()?.value === ";") {
        take();
      }
      stepRun = {
        id,
        inputType,
        outputType,
        doc: [doc, memberDoc].filter((part) => part.length > 0).join(" "),
      };
      continue;
    }
    throw new Error(`Unexpected token ${lead.kind} ${lead.value} in declaration`);
  }
  if (!stepRun) {
    throw new Error("Declaration is missing step.run signature");
  }
  return { types, stepRun };
}

describe("search the catalog", () => {
  const archive = defineCapability({
    id: "notes.archive",
    description: "Archive a note",
    input: z.object({ key: z.string() }),
    output: z.object({ archived: z.boolean() }),
    effect: "write",
    approval: "none",
    example: 'await step.run("notes.archive", { key: "a" })',
    async execute() {
      return { archived: true };
    },
  }) as unknown as Capability;

  it("returns the declaration and example of the one capability a query matches", async () => {
    const { server, host } = await startDirectServer({ extra: [archive] });
    expect(server.scriptDriver).toBeDefined();
    const search = createSearchTool({ catalog: host.catalog, maxResultBytes: RESULT_BYTES });

    const result = (await search.execute!({ query: "archive" })) as {
      hits: Array<{ id: string; summary: string; declaration: string; example?: string }>;
      truncated: boolean;
    };

    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(1);
    const [hit] = result.hits;
    expect(hit).toMatchObject({
      id: "notes.archive",
      summary: "Archive a note",
      example: 'await step.run("notes.archive", { key: "a" })',
    });
    expect(parseDeclaration(hit!.declaration)).toEqual({
      types: {
        NotesArchiveInput: {
          key: { type: "string", optional: false, doc: "" },
        },
        NotesArchiveOutput: {
          archived: { type: "boolean", optional: false, doc: "" },
        },
      },
      stepRun: {
        id: "notes.archive",
        inputType: "NotesArchiveInput",
        outputType: "NotesArchiveOutput",
        doc: "Archive a note",
      },
    });
  }, 60_000);

  it("returns no hits for a query that matches nothing", async () => {
    const host = createNoteHost();
    const search = createSearchTool({ catalog: host.catalog, maxResultBytes: RESULT_BYTES });

    expect(await search.execute!({ query: "zebra" })).toEqual({ hits: [], truncated: false });
  }, 60_000);

  it("keeps whole hits within the byte budget and flags the cut", async () => {
    const host = createNoteHost();
    const search = createSearchTool({ catalog: host.catalog, maxResultBytes: 400 });

    const result = (await search.execute!({ query: "note" })) as {
      hits: { id: string }[];
      truncated: boolean;
    };

    expect(result.hits.map((hit) => hit.id)).toEqual(["notes.append"]);
    expect(result.truncated).toBe(true);
  }, 60_000);
});

describe("cap what execute hands back", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

  it("fits a failed result with a long message and logs within the byte limit and flags cuts", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-truncate-error-long");

    const result = await callTool(executeToolFor(server, owner.run, 256), {
      script:
        'console.log("a".repeat(60)); console.log("b".repeat(60)); throw new Error("y".repeat(400));',
    });

    expect(bytes(result)).toBeLessThanOrEqual(256);
    expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
    if (!result.ok) {
      expect(result.error.message).toContain("y".repeat(20));
      expect(result.error.message).toMatch(/truncat/i);
    }
    expect(result.logs).not.toContain("a".repeat(60));
    expect(result.logs.some((line) => /truncat/i.test(line))).toBe(true);
  }, 60_000);

  it("keeps fitting logs alongside a short error message within the byte limit and flags cut logs", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-truncate-error-logs");

    const result = await callTool(executeToolFor(server, owner.run, 256), {
      script:
        'console.log("a".repeat(100)); console.log("b".repeat(100)); throw new Error("short");',
    });

    expect(bytes(result)).toBeLessThanOrEqual(256);
    expect(result).toMatchObject({ ok: false, error: { kind: "script" } });
    if (!result.ok) {
      expect(result.error.message).toContain("short");
      expect(result.error.message).not.toMatch(/truncat/i);
    }
    expect(result.logs).toContain("a".repeat(100));
    expect(result.logs).not.toContain("b".repeat(100));
    expect(result.logs.some((line) => /truncat/i.test(line))).toBe(true);
  }, 60_000);

  it("fits a call to a 70,000-character unknown capability into the default limit and flags truncation", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-truncate-call");

    const result = await callTool(executeToolFor(server, owner.run), {
      script: 'return await step.run("notes." + "z".repeat(70_000), {});',
    });

    expect(bytes(result)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(result).toMatchObject({ ok: false, error: { kind: "capability" }, logs: [] });
    if (!result.ok) {
      expect(result.error.message).toContain("notes.z");
      expect(result.error.message).toMatch(/truncat/i);
    }
  }, 60_000);

  it("cuts an oversized result to the byte budget, keeps original content, and flags it truncated", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-truncate");

    const result = await callTool(executeToolFor(server, owner.run, 256), {
      script: `return "x".repeat(400);`,
    });

    expect(bytes(result)).toBeLessThanOrEqual(256);
    expect(result).toMatchObject({ ok: true, truncated: true, logs: [] });
    expect(
      result.ok && typeof result.result === "string" && result.result.includes("x".repeat(20)),
    ).toBe(true);
  }, 60_000);

  it("refuses a result limit below the minimum", () => {
    expect(() => boundResult({ ok: true, result: "ok", logs: [], truncated: false }, 255)).toThrow(
      RangeError,
    );
  });
});

describe("describe the tools to the model", () => {
  it("lists each namespace's members on one line and conveys safe retry and repeat-key rules", () => {
    const host = createNoteHost();

    const text = codeModeInstructions(host.catalog);
    const lines = text.split("\n");
    const notesLine = lines.find(
      (line) => /\bnotes\b/.test(line) && /\bappend\b/.test(line) && /\bpublish\b/.test(line),
    );
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);

    expect(notesLine).toBeDefined();
    expect(notesLine).toMatch(/\bread\b/);
    expect(text).toMatch(/execute\([^)]*\bkey\??[^)]*\)/);
    expect(
      sentences.some((sentence) => /\bstep\.run\b/.test(sentence) && /\bawait\b/.test(sentence)),
    ).toBe(true);
    expect(
      sentences.some(
        (sentence) =>
          /\bsame\s+script\b/i.test(sentence) &&
          /\b(same\s+execution|reattach)\b/i.test(sentence) &&
          !/\b(new|fresh|separate|another)\s+execution\b/i.test(sentence),
      ),
    ).toBe(true);
    const interruptedSentences = sentences.filter((sentence) =>
      /\b(cut\s+off|interrupt\w*|abort\w*|disconnect\w*|lost)\b/i.test(sentence),
    );
    expect(interruptedSentences.length).toBeGreaterThan(0);
    expect(
      interruptedSentences.every(
        (sentence) =>
          /\bsame\s+script\b/i.test(sentence) &&
          /\bkey\b/i.test(sentence) &&
          /\b(same\s+execution|that\s+execution|existing\s+execution|stored\s+result|reattach\w*|resume\w*|recover\w*)\b/i.test(
            sentence,
          ) &&
          !/\b(new|fresh|separate|another)\s+execution\b/i.test(sentence),
      ),
    ).toBe(true);
    expect(
      sentences.some(
        (sentence) =>
          /\b(on\s+purpose|intentionally|again)\b/i.test(sentence) &&
          /\bnew\s+`?key`?\b/i.test(sentence),
      ),
    ).toBe(true);
    expect(
      sentences.some(
        (sentence) =>
          /\b(failed|finished)\b/i.test(sentence) &&
          /\b(retry|retrying|repeat)\b/i.test(sentence) &&
          /\bnew\s+`?key`?\b/i.test(sentence),
      ),
    ).toBe(true);
    expect(
      sentences.some(
        (sentence) =>
          /\b(retry|retrying|same\s+script|cut\s+off|interrupt\w*|abort\w*)\b/i.test(sentence) &&
          /\b(new|fresh|separate|another)\s+execution\b/i.test(sentence) &&
          !/\bnew\s+`?key`?\b/i.test(sentence),
      ),
    ).toBe(false);
  });
});

describe("give the engine its host tools", () => {
  it("gives a fixture-engine run exactly search and execute", async () => {
    const { server } = await startDirectServer();
    const { run } = await server.coordinator.admit({
      botId: server.seededFixture!.bot.id,
      sessionId: server.seededFixture!.session.id,
      origin: "http",
      idempotencyKey: "code-mode-host-tools",
      input: { parts: [{ type: "text", text: "tools:" }] },
    });

    await waitUntil(async () => server.store.getRun(run.id)?.status === "completed", {
      timeoutMs: 10_000,
      label: "run completed",
    });

    expect(
      server.store
        .listMessages(run.sessionId)
        .find((message) => message.runId === run.id && message.role === "assistant")?.parts,
    ).toEqual([{ type: "text", text: "Host tools: search, execute" }]);
  }, 60_000);
});

describe("drive a fixture capability through the execute tool", () => {
  it("raises one approval for the script call and reports the applied effect once it is approved", async () => {
    const fixture = createFixtureCapabilities();
    const { server } = await startDirectServer({ extra: fixture.capabilities });
    const botId = server.seededFixture!.bot.id;
    const sessionId = server.seededFixture!.session.id;
    const { run } = await server.coordinator.admit({
      botId,
      sessionId,
      origin: "http",
      idempotencyKey: "code-mode-fixture-apply",
      input: { parts: [{ type: "text", text: "lamp-1" }] },
    });

    const approval = await awaitPendingApproval(server, run.id);
    const scriptRunId = approval.awakeable.slice("script:".length);

    expect(approval.effect).toEqual({
      runId: run.id,
      operationKind: "capability",
      operationId: "fixture.apply",
      canonicalArguments: { target: "lamp-1", mode: "apply" },
      attemptId: `${scriptRunId}:1`,
    });
    expect(fixture.applied).toEqual([]);

    await decide(server, approval, { run, botId, sessionId }, "approved");
    await waitUntil(async () => server.store.getRun(run.id)?.status === "completed", {
      timeoutMs: 10_000,
      label: "run completed",
    });

    expect(fixture.applied).toEqual([
      {
        operationId: "fixture.apply",
        attemptId: `${scriptRunId}:1`,
        runId: run.id,
        canonicalArguments: { target: "lamp-1", mode: "apply" },
      },
    ]);
    expect(
      server.store
        .listMessages(sessionId)
        .find((message) => message.runId === run.id && message.role === "assistant")?.parts,
    ).toEqual([
      {
        type: "text",
        text: 'Applied fixture.apply: {"applied":true,"operationId":"fixture.apply","arguments":{"target":"lamp-1","mode":"apply"}}',
      },
    ]);
  }, 60_000);
});
