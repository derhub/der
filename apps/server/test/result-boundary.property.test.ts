import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import * as z from "zod";
import {
  CapabilityCatalog,
  defineCapability,
  type Capability,
  type ExecuteResult,
  type JsonValue,
} from "@der/domain";
import { openSqliteStore, type SqliteStore } from "@der/storage";
import { createExecuteTool } from "#code-mode/execute";
import { createEventDelivery } from "#events/event-delivery";
import { startServer, type RunningServer } from "#main";
import { createTempDatabase } from "./fixtures/restate-harness";

/** The documented smallest `DER_SCRIPT_RESULT_BYTES`. */
const MIN_RESULT_BYTES = 256;
const UNKNOWN_OUTCOME = "Unknown outcome: ";
const ERROR_KINDS = [
  "script",
  "denied",
  "expired",
  "limit",
  "capability",
  "cancelled",
  "nondeterministic",
] as const;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;

const text = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: "binary", maxLength: 400 }),
  fc.string({ unit: fc.constantFrom("a", '"', "\\", "\n", "é", "😀"), maxLength: 2_000 }),
);
const limit = fc.oneof(
  fc.integer({ min: MIN_RESULT_BYTES, max: MIN_RESULT_BYTES + 64 }),
  fc.integer({ min: MIN_RESULT_BYTES, max: 4_096 }),
);
const capabilityId = fc.stringMatching(/^[a-z_][a-z0-9_]{0,12}(\.[a-z_][a-z0-9_]{0,300}){1,2}$/);
const logs = fc.array(text, { maxLength: 6 });

type Case =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "failed" | "cancelled"; readonly result: ExecuteResult }
  | { readonly status: "in_doubt"; readonly result: ExecuteResult; readonly unknown: string[] };

const failure = fc.record({
  kind: fc.constantFrom(...ERROR_KINDS),
  message: text,
  call: fc.option(text, { nil: undefined }),
  line: fc.option(fc.nat({ max: 100_000 }), { nil: undefined }),
  logs,
});

const resultCase: fc.Arbitrary<Case> = fc.oneof(
  fc
    .record({ value: fc.jsonValue({ maxDepth: 3 }), logs, truncated: fc.boolean() })
    .map(({ value, logs: lines, truncated }) => ({
      status: "completed" as const,
      result: { ok: true as const, result: value as JsonValue, logs: lines, truncated },
    })),
  fc
    .record({ status: fc.constantFrom("failed" as const, "cancelled" as const), failure })
    .map(({ status, failure: f }) => ({
      status,
      result: {
        ok: false as const,
        error: {
          kind: f.kind,
          message: f.message,
          ...(f.call === undefined ? {} : { call: f.call }),
          ...(f.line === undefined ? {} : { line: f.line }),
        },
        logs: f.logs,
      },
    })),
  fc
    .record({
      failure,
      applied: fc.array(capabilityId, { maxLength: 3 }),
      unknown: fc.array(capabilityId, { minLength: 1, maxLength: 40 }),
    })
    .map(({ failure: f, applied, unknown }) => {
      const names = unknown.map((id, index) => `#${applied.length + index + 1} ${id}`);
      const done = applied.map((id, index) => `#${index + 1} ${id}`).join(", ");
      return {
        status: "in_doubt" as const,
        unknown: names,
        result: {
          ok: false as const,
          error: {
            kind: f.kind,
            message: `${f.message.replace(/\.$/, "")}. Already applied: ${done || "none confirmed"}. ${UNKNOWN_OUTCOME}${names.join(", ")}.`,
            ...(f.call === undefined ? {} : { call: f.call }),
            ...(f.line === undefined ? {} : { line: f.line }),
          },
          logs: f.logs,
        },
      };
    }),
);

/** The names an in-doubt message lists and the count it says it left out. */
function unknownWrites(message: string): { listed: string[]; omitted: number } {
  const at = message.lastIndexOf(UNKNOWN_OUTCOME);
  if (at < 0) {
    return { listed: [], omitted: 0 };
  }
  const entries = message
    .slice(at + UNKNOWN_OUTCOME.length)
    .replace(/\.$/, "")
    .split(", ");
  const count = /^(\d+) omitted$/.exec(entries.at(-1) ?? "");
  return count === null
    ? { listed: entries, omitted: 0 }
    : { listed: entries.slice(0, -1), omitted: Number(count[1]) };
}

/** What a reader must still learn from the bounded result. */
function outcomeOf(result: ExecuteResult, unknown?: readonly string[]): JsonValue {
  if (result.ok) {
    return { ok: true };
  }
  if (unknown === undefined) {
    return { ok: false, kind: result.error.kind };
  }
  const { listed, omitted } = unknownWrites(result.error.message);
  return {
    ok: false,
    kind: result.error.kind,
    accounted: listed.length + omitted,
    listedAreUnknown: listed.every((name) => unknown.includes(name)),
  };
}

function expectedOutcome(testCase: Case): JsonValue {
  if (testCase.result.ok) {
    return { ok: true };
  }
  if (testCase.status !== "in_doubt") {
    return { ok: false, kind: testCase.result.error.kind };
  }
  return {
    ok: false,
    kind: testCase.result.error.kind,
    accounted: testCase.unknown.length,
    listedAreUnknown: true,
  };
}

describe("property: the bounded text of a Script result", () => {
  let store: SqliteStore;
  let cleanup: () => void;
  let session = 0;

  beforeAll(() => {
    const tempDb = createTempDatabase("der-result-property-");
    store = openSqliteStore({ filename: tempDb.dbPath });
    cleanup = () => {
      store.close();
      tempDb.cleanup();
    };
    store.createBot({
      id: "bot-1",
      name: "Bot",
      persona: "",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
      eventChainLimit: 1_000_000,
    });
  });

  afterAll(() => cleanup());

  it("keeps an event Run's text within the limit and keeps the outcome and unknown writes", async () => {
    await fc.assert(
      fc.asyncProperty(resultCase, limit, async (testCase, maxResultBytes) => {
        session += 1;
        const sessionId = `sess-${session}`;
        store.createSession({ id: sessionId, botId: "bot-1", title: sessionId });
        store.enqueueSessionEvent({
          id: `evt-${session}`,
          botId: "bot-1",
          sessionId,
          kind: "script.finished",
          payload: {
            event: "script.finished",
            executionId: `sr_${crypto.randomUUID()}`,
            status: testCase.status,
            result: testCase.result as unknown as JsonValue,
          },
        });
        await createEventDelivery({
          store,
          bots: store,
          admit: (request) => store.admit(request),
          maxResultBytes,
        })();
        const [message] = store.listMessages(sessionId);
        const eventText = (message!.parts[0] as { text: string }).text;
        const parsed = JSON.parse(eventText) as { status: string; result: ExecuteResult };
        const unknown = testCase.status === "in_doubt" ? testCase.unknown : undefined;

        expect({
          withinLimit: bytes(eventText) <= maxResultBytes,
          status: parsed.status,
          outcome: outcomeOf(parsed.result, unknown),
        }).toEqual({
          withinLimit: true,
          status: testCase.status,
          outcome: expectedOutcome(testCase),
        });
      }),
      { numRuns: 300 },
    );
  }, 60_000);
});

const WRITES = ["w.a", "writes.beta", `w.${"long".repeat(40)}`, "w.gamma_delta"] as const;

function unknownOutcomeCatalog(): CapabilityCatalog {
  const catalog = new CapabilityCatalog();
  const writes = WRITES.map(
    (id) =>
      defineCapability({
        id,
        description: "A write whose outcome is never known",
        input: z.object({ message: z.string() }),
        output: z.object({}),
        effect: "write",
        approval: "none",
        async execute({ message }) {
          throw new Error(message);
        },
      }) as Capability,
  );
  for (const capability of writes) {
    catalog.add(capability);
  }
  return catalog;
}

type InlineCase =
  | { readonly kind: "value"; readonly logs: string[]; readonly value: JsonValue }
  | { readonly kind: "throw"; readonly logs: string[]; readonly message: string }
  | {
      readonly kind: "unknown";
      readonly logs: string[];
      readonly writes: string[];
      readonly message: string;
    }
  | { readonly kind: "invalid"; readonly args: JsonValue }
  | { readonly kind: "aborted" };

const inlineCase: fc.Arbitrary<InlineCase> = fc.oneof(
  fc.record({
    kind: fc.constant("value" as const),
    logs,
    value: fc.jsonValue({ maxDepth: 3 }).map((value) => value as JsonValue),
  }),
  fc.record({ kind: fc.constant("throw" as const), logs, message: text }),
  fc.record({
    kind: fc.constant("unknown" as const),
    logs,
    writes: fc.subarray([...WRITES], { minLength: 1 }),
    message: text,
  }),
  fc.record({
    kind: fc.constant("invalid" as const),
    args: fc.oneof(
      fc.record({ script: fc.oneof(fc.integer(), fc.constant("")), junk: text }),
      fc.record({ code: text }),
    ),
  }),
  fc.constant({ kind: "aborted" as const }),
);

function scriptFor(testCase: Extract<InlineCase, { logs: string[] }>): string {
  const data = JSON.stringify(testCase);
  const body =
    testCase.kind === "value"
      ? "return d.value;"
      : testCase.kind === "throw"
        ? "throw new Error(d.message);"
        : "await step.all(d.writes.map((id) => step.run(id, { message: d.message || 'lost' })));";
  return `const d = ${data};\nfor (const line of d.logs) console.log(line);\n${body}`;
}

function expectedInline(testCase: InlineCase): JsonValue {
  switch (testCase.kind) {
    case "value":
      return { ok: true };
    case "throw":
    case "invalid":
      return { ok: false, kind: "script" };
    case "aborted":
      return { ok: false, kind: "cancelled" };
    case "unknown":
      return {
        ok: false,
        kind: "capability",
        accounted: testCase.writes.length,
        listedAreUnknown: true,
      };
  }
}

describe("property: the bounded text execute returns inline", () => {
  let server: RunningServer;
  let cleanup: () => Promise<void>;
  let session = 0;

  beforeAll(async () => {
    const tempDb = createTempDatabase("der-inline-property-");
    server = await startServer({
      config: {
        host: "127.0.0.1",
        port: 0,
        restateMode: "direct",
        databasePath: tempDb.dbPath,
        memoryProjectionDir: `${tempDb.dir}/memory`,
        skillsRootDir: `${tempDb.dir}/skills`,
        workspaceRootDir: `${tempDb.dir}/workspaces`,
        enabledEngines: ["fixture"],
        seedFixture: true,
      },
      catalog: unknownOutcomeCatalog(),
    });
    cleanup = async () => {
      await server.close();
      tempDb.cleanup();
    };
  });

  afterAll(() => cleanup());

  it("keeps the tool result within the limit and keeps the outcome and unknown writes", async () => {
    await fc.assert(
      fc.asyncProperty(inlineCase, limit, async (testCase, maxResultBytes) => {
        session += 1;
        const botId = server.seededFixture!.bot.id;
        const sessionId = `inline-${session}`;
        server.store.createSession({ id: sessionId, botId, title: sessionId });
        const { run } = await server.store.admit({
          botId,
          sessionId,
          origin: "http",
          idempotencyKey: sessionId,
          input: { parts: [{ type: "text", text: "owner" }] },
        });
        const tool = createExecuteTool({
          run,
          scriptRunStore: server.scriptRunStore,
          scriptDriver: server.scriptDriver,
          maxResultBytes,
          inlineWaitMs: 30_000,
        });
        const aborted = new AbortController();
        aborted.abort();
        const args =
          testCase.kind === "invalid"
            ? testCase.args
            : testCase.kind === "aborted"
              ? { script: "return 1;" }
              : { script: scriptFor(testCase) };
        const result = (await tool.execute!(args, {
          signal: testCase.kind === "aborted" ? aborted.signal : AbortSignal.timeout(30_000),
        })) as ExecuteResult;
        const unknown =
          testCase.kind === "unknown"
            ? testCase.writes.map((id, index) => `#${index + 1} ${id}`)
            : undefined;

        expect({
          withinLimit: bytes(JSON.stringify(result)) <= maxResultBytes,
          outcome: outcomeOf(result, unknown),
        }).toEqual({ withinLimit: true, outcome: expectedInline(testCase) });
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
