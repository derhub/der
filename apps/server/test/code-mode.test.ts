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
import type { ScriptRuns } from "#scripts/script-workflow";
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

function executeToolFor(server: RunningServer, run: Run, maxResultBytes = RESULT_BYTES): AnyTool {
  return createExecuteTool({
    run,
    scriptRunStore: server.scriptRunStore,
    scriptRuns: server.scriptRuns!,
    maxResultBytes,
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
  return server.coordinator.decide({
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

const PUBLISH = `return der.notes.publish({ text: "release" });`;

describe("execute a gated script through the tool", () => {
  it("raises one approval, then returns the value with one effect once the approval is granted", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-approval");
    const execute = executeToolFor(server, owner.run);

    const pending = callTool(execute, { script: PUBLISH });
    const approval = await awaitPendingApproval(server, owner.run.id);
    expect(host.published).toEqual([]);
    await decide(server, approval, owner, "approved");

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
      script: `return der.bank.transfer({ amount: 5 });`,
    });

    expect(result).toEqual({ ok: true, result: { moved: 5 }, logs: [], truncated: false });
    expect(server.store.getLatestApprovalForRun(owner.run.id)).toBeUndefined();
  }, 60_000);

  it("asks for approval when the capability's approval rule says the input is large", async () => {
    const { server } = await startDirectServer({ extra: [transfer] });
    const owner = await admitOwningRun(server, "code-mode-approval-rule-large");
    const execute = executeToolFor(server, owner.run);

    const pending = callTool(execute, { script: `return der.bank.transfer({ amount: 500 });` });
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

    expect(await first).toEqual({
      ok: false,
      error: {
        kind: "cancelled",
        message:
          "execute was aborted before the script finished; call execute with the same script to pick the run back up",
      },
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

describe("return a stored result without attaching", () => {
  it("returns the stored result of a finished undelivered script run when attach is unavailable", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-stored-result");
    const attachDown = new Error("workflow retention elapsed");
    const finishThenFail: ScriptRuns = {
      submit: (id) => server.scriptRuns!.submit(id),
      cancel: (id) => server.scriptRuns!.cancel(id),
      attach: async (id, signal) => {
        await server.scriptRuns!.attach(id, signal);
        throw attachDown;
      },
    };
    const neverAttach: ScriptRuns = {
      ...finishThenFail,
      attach: async () => {
        throw attachDown;
      },
    };
    const append = `return der.notes.append({ text: "tick" });`;
    const tool = (scriptRuns: ScriptRuns) =>
      createExecuteTool({
        run: owner.run,
        scriptRunStore: server.scriptRunStore,
        scriptRuns,
        maxResultBytes: RESULT_BYTES,
      });

    const first = await callTool(tool(finishThenFail), { script: append });
    const second = await callTool(tool(neverAttach), { script: append });

    expect(first).toEqual({
      ok: false,
      error: { kind: "capability", message: "execute failed: workflow retention elapsed" },
      logs: [],
    });
    expect(second).toEqual({ ok: true, result: { count: 1 }, logs: [], truncated: false });
    expect(host.appended).toEqual(["tick"]);
    expect(scriptRunCount(server, owner.run.id)).toBe(1);
  }, 60_000);
});

describe("repeat a script on purpose", () => {
  it("runs the same script again after its result was returned, giving two script runs and two effects", async () => {
    const { server, host } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-repeat");
    const execute = executeToolFor(server, owner.run);
    const append = `return der.notes.append({ text: "tick" });`;

    const first = await callTool(execute, { script: append });
    const second = await callTool(execute, { script: append });

    expect(first).toEqual({ ok: true, result: { count: 1 }, logs: [], truncated: false });
    expect(second).toEqual({ ok: true, result: { count: 2 }, logs: [], truncated: false });
    expect(host.appended).toEqual(["tick", "tick"]);
    expect(scriptRunCount(server, owner.run.id)).toBe(2);
  }, 60_000);
});

describe("report a refused approval", () => {
  it.each([
    { status: "denied", message: "Approval for notes.publish was denied" },
    { status: "expired", message: "Approval for notes.publish expired" },
  ] as const)(
    "returns ok false with kind $status and records no effect",
    async (testCase) => {
      const { server, host } = await startDirectServer();
      const owner = await admitOwningRun(server, `code-mode-${testCase.status}`);
      const execute = executeToolFor(server, owner.run);

      const pending = callTool(execute, { script: PUBLISH });
      const approval = await awaitPendingApproval(server, owner.run.id);
      await decide(server, approval, owner, testCase.status);

      expect(await pending).toEqual({
        ok: false,
        error: { kind: testCase.status, message: testCase.message, call: "notes.publish" },
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
    expect(server.scriptRunStore.listUnfinished(run.id)).toEqual([]);
    expect(server.store.getApproval(approval.id)?.decision.status).toBe("expired");
  }, 60_000);
});

describe("search the catalog", () => {
  const archive = defineCapability({
    id: "notes.archive",
    description: "Archive a note",
    input: z.object({ key: z.string() }),
    output: z.object({ archived: z.boolean() }),
    effect: "write",
    approval: "none",
    example: 'await der.notes.archive({ key: "a" })',
    async execute() {
      return { archived: true };
    },
  }) as unknown as Capability;

  it("returns the declaration and example of the one capability a query matches", async () => {
    const { server, host } = await startDirectServer({ extra: [archive] });
    expect(server.scriptRuns).toBeDefined();
    const search = createSearchTool({ catalog: host.catalog, maxResultBytes: RESULT_BYTES });

    expect(await search.execute!({ query: "archive" })).toEqual({
      hits: [
        {
          id: "notes.archive",
          summary: "Archive a note",
          declaration: [
            "type NotesArchiveInput = {",
            "  key: string;",
            "};",
            "type NotesArchiveOutput = {",
            "  archived: boolean;",
            "};",
            "/** Archive a note */",
            "declare function der.notes.archive(input: NotesArchiveInput): Promise<NotesArchiveOutput>;",
          ].join("\n"),
          example: 'await der.notes.archive({ key: "a" })',
        },
      ],
      truncated: false,
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
  it("cuts an oversized result to the byte budget and flags it truncated", async () => {
    const { server } = await startDirectServer();
    const owner = await admitOwningRun(server, "code-mode-truncate");

    const result = await callTool(executeToolFor(server, owner.run, 20), {
      script: `return "x".repeat(100);`,
    });

    expect(result).toEqual({
      ok: true,
      result: `"${"x".repeat(19)}`,
      logs: [],
      truncated: true,
    });
  }, 60_000);
});

describe("describe the tools to the model", () => {
  it("lists each namespace on one line and states the script rules", async () => {
    const host = createNoteHost();

    const text = codeModeInstructions(host.catalog);

    expect(text).toContain("- notes: append, publish, read");
    expect(text).toContain("`await` every call");
    expect(text).toContain(
      "- Modules and `import` are not available. `eval` and `Function` are unavailable. There are no timers.",
    );
    expect(text).toContain("`Date`, `Math.random` and `performance.now` return recorded values");
  }, 60_000);
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
    const [scriptRun] = server.scriptRunStore.listUnfinished(run.id);

    expect(approval.effect).toEqual({
      runId: run.id,
      operationKind: "capability",
      operationId: "fixture.apply",
      canonicalArguments: { target: "lamp-1", mode: "apply" },
      attemptId: `${scriptRun!.id}:1`,
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
        attemptId: `${scriptRun!.id}:1`,
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
