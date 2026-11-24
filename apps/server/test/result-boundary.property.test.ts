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
import { boundResult } from "#code-mode/result-boundary";
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
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const normalizeUtf8 = (value: string) => decoder.decode(encoder.encode(value));
const TRUNCATION_FLAG = /truncat/i;

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
    .split(", ")
    .filter((entry) => entry.length > 0);
  const count = /^(\d+) omitted$/.exec(entries.at(-1) ?? "");
  return count === null
    ? { listed: entries, omitted: 0 }
    : { listed: entries.slice(0, -1), omitted: Number(count[1]) };
}

function probeFailureSize(
  kind: Extract<ExecuteResult, { ok: false }>["error"]["kind"],
  message: string,
  line: number | undefined,
  logLines: readonly string[],
  envelopeBytes: number,
): number {
  return (
    envelopeBytes +
    bytes(
      JSON.stringify({
        ok: false,
        error: { kind, message, ...(line === undefined ? {} : { line }) },
        logs: logLines,
      }),
    )
  );
}

function logsCutHandled(
  actual: Extract<ExecuteResult, { ok: false }>,
  expectedLogs: readonly string[],
  maxResultBytes: number,
  envelopeBytes: number,
): boolean {
  const intact =
    actual.logs.length === expectedLogs.length &&
    actual.logs.every((line, index) => line === expectedLogs[index]);
  if (intact) {
    return true;
  }
  if (actual.logs.length > 0 && TRUNCATION_FLAG.test(actual.logs.at(-1)!)) {
    const kept = actual.logs.slice(0, -1);
    return (
      kept.length <= expectedLogs.length &&
      kept.every((line, index) => line === expectedLogs[index])
    );
  }
  const isPrefix =
    actual.logs.length <= expectedLogs.length &&
    actual.logs.every((line, index) => line === expectedLogs[index]);
  if (!isPrefix) {
    return false;
  }
  return (
    envelopeBytes +
      bytes(JSON.stringify({ ...actual, logs: [...actual.logs, "[logs truncated]"] })) >
    maxResultBytes
  );
}

function successOutcomeOf(
  actual: ExecuteResult,
  expected: {
    readonly value: JsonValue;
    readonly logs: readonly string[];
    readonly truncated: boolean;
  },
  maxResultBytes: number,
  envelopeBytes: number,
): JsonValue {
  if (!actual.ok) {
    return { ok: false };
  }
  const expectedJson = normalizeUtf8(JSON.stringify(expected.value) ?? "null");
  const actualJson = normalizeUtf8(JSON.stringify(actual.result) ?? "null");
  const valueIntact = actualJson === expectedJson;
  const normalizedLogs = expected.logs.map(normalizeUtf8);
  const logsIntact =
    actual.logs.length === normalizedLogs.length &&
    actual.logs.every((line, index) => line === normalizedLogs[index]);
  const logsArePrefix =
    actual.logs.length <= normalizedLogs.length &&
    actual.logs.every((line, index) => line === normalizedLogs[index]);
  const valuePreservedOrCut =
    valueIntact ||
    (typeof actual.result === "string" &&
      actual.result.length > 0 &&
      expectedJson.startsWith(actual.result));
  const inputFits =
    envelopeBytes +
      bytes(
        JSON.stringify({
          ok: true,
          result: expected.value,
          logs: expected.logs,
          truncated: expected.truncated,
        }),
      ) <=
    maxResultBytes;
  const cutFlagged = inputFits
    ? valueIntact && logsIntact && actual.truncated === expected.truncated
    : actual.truncated === true;
  return {
    ok: true,
    valuePreservedOrCut,
    logsArePrefix,
    cutFlagged,
  };
}

function unknownOutcomeOf(
  actual: Extract<ExecuteResult, { ok: false }>,
  unknown: readonly string[],
  hadLogs: boolean,
  maxResultBytes: number,
  envelopeBytes: number,
) {
  const { listed, omitted } = unknownWrites(actual.error.message);
  const reserveLogs = hadLogs ? ["[logs truncated]"] : [];
  const allFit =
    probeFailureSize(
      actual.error.kind,
      `[message truncated] ${UNKNOWN_OUTCOME}${unknown.join(", ")}.`,
      actual.error.line,
      reserveLogs,
      envelopeBytes,
    ) <= maxResultBytes;
  const firstFits =
    unknown.length > 0 &&
    probeFailureSize(
      actual.error.kind,
      `[message truncated] ${UNKNOWN_OUTCOME}${unknown[0]}${unknown.length > 1 ? `, ${unknown.length - 1} omitted` : ""}.`,
      actual.error.line,
      reserveLogs,
      envelopeBytes,
    ) <= maxResultBytes;
  return {
    accounted: listed.length + omitted,
    distinctNames: new Set(listed).size === listed.length,
    listedAreUnknown: listed.every((name) => unknown.includes(name)),
    keptAllThatFit: !allFit || omitted === 0,
    keptFittingName: !firstFits || listed.length > 0,
  };
}

/** What a reader must still learn from the bounded result. */
function outcomeOf(
  actual: ExecuteResult,
  input: ExecuteResult,
  maxResultBytes: number,
  envelopeBytes: number,
  unknown?: readonly string[],
): JsonValue {
  if (actual.ok) {
    if (!input.ok) {
      return { ok: true };
    }
    return successOutcomeOf(
      actual,
      {
        value: input.result,
        logs: input.logs,
        truncated: input.truncated,
      },
      maxResultBytes,
      envelopeBytes,
    );
  }
  if (input.ok) {
    return { ok: false, kind: actual.error.kind };
  }
  const normalizedLogs = input.logs.map(normalizeUtf8);
  const messageIntact = actual.error.message === normalizeUtf8(input.error.message);
  const reserveLogs = input.logs.length > 0 ? ["[logs truncated]"] : [];
  const messageCutFlagged =
    messageIntact ||
    TRUNCATION_FLAG.test(actual.error.message) ||
    (unknown !== undefined &&
      probeFailureSize(
        actual.error.kind,
        `[message truncated] ${UNKNOWN_OUTCOME}${unknown.length} omitted.`,
        actual.error.line,
        reserveLogs,
        envelopeBytes,
      ) > maxResultBytes);
  const callCutFlagged =
    input.error.call === undefined ||
    actual.error.call === normalizeUtf8(input.error.call) ||
    actual.error.call === undefined ||
    TRUNCATION_FLAG.test(actual.error.call);
  const logsCutFlagged = logsCutHandled(actual, normalizedLogs, maxResultBytes, envelopeBytes);
  if (unknown === undefined) {
    return {
      ok: false,
      kind: actual.error.kind,
      messageCutFlagged,
      logsCutFlagged,
      callCutFlagged,
    };
  }
  return {
    ok: false,
    kind: actual.error.kind,
    messageCutFlagged,
    logsCutFlagged,
    callCutFlagged,
    ...unknownOutcomeOf(actual, unknown, input.logs.length > 0, maxResultBytes, envelopeBytes),
  };
}

function expectedOutcome(testCase: Case): JsonValue {
  if (testCase.result.ok) {
    return {
      ok: true,
      valuePreservedOrCut: true,
      logsArePrefix: true,
      cutFlagged: true,
    };
  }
  if (testCase.status !== "in_doubt") {
    return {
      ok: false,
      kind: testCase.result.error.kind,
      messageCutFlagged: true,
      logsCutFlagged: true,
      callCutFlagged: true,
    };
  }
  return {
    ok: false,
    kind: testCase.result.error.kind,
    messageCutFlagged: true,
    logsCutFlagged: true,
    callCutFlagged: true,
    accounted: testCase.unknown.length,
    distinctNames: true,
    listedAreUnknown: true,
    keptAllThatFit: true,
    keptFittingName: true,
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
        const envelopeBytes = bytes(eventText) - bytes(JSON.stringify(parsed.result));
        const unknown = testCase.status === "in_doubt" ? testCase.unknown : undefined;

        expect({
          withinLimit: bytes(eventText) <= maxResultBytes,
          status: parsed.status,
          outcome: outcomeOf(
            parsed.result,
            testCase.result,
            maxResultBytes,
            envelopeBytes,
            unknown,
          ),
        }).toEqual({
          withinLimit: true,
          status: testCase.status,
          outcome: expectedOutcome(testCase),
        });
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("keeps every unknown write when the set fits and flags the cut stop reason", () => {
    const names = ["#1 notes.append", "#2 notes.publish"];
    const { result, text: boundedText } = boundResult(
      {
        ok: false,
        error: {
          kind: "capability",
          message: `${"x".repeat(300)}. Already applied: none confirmed. ${UNKNOWN_OUTCOME}${names.join(", ")}.`,
        },
        logs: [],
      },
      300,
    );

    expect(bytes(boundedText)).toBeLessThanOrEqual(300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const { listed, omitted } = unknownWrites(result.error.message);
      expect(listed).toEqual(names);
      expect(omitted).toBe(0);
      expect(result.error.message).toMatch(TRUNCATION_FLAG);
    }
  });

  it("keeps the distinct unknown writes that fit and counts the rest under a tight budget", () => {
    const names = Array.from({ length: 20 }, (_, index) => `#${index + 1} notes.append`);
    const { result, text: boundedText } = boundResult(
      {
        ok: false,
        error: {
          kind: "capability",
          message: `${"x".repeat(300)}. Already applied: none confirmed. ${UNKNOWN_OUTCOME}${names.join(", ")}.`,
        },
        logs: [],
      },
      MIN_RESULT_BYTES,
    );

    expect(bytes(boundedText)).toBeLessThanOrEqual(MIN_RESULT_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const { listed, omitted } = unknownWrites(result.error.message);
      expect(listed.length).toBeGreaterThan(0);
      expect(omitted).toBeGreaterThan(0);
      expect(listed.length + omitted).toBe(names.length);
      expect(new Set(listed).size).toBe(listed.length);
      expect(listed.every((name) => names.includes(name))).toBe(true);
    }
  });

  it("keeps a single unknown write inside the minimum 256-byte event budget", async () => {
    session += 1;
    const sessionId = `sess-min-event-${session}`;
    store.createSession({ id: sessionId, botId: "bot-1", title: sessionId });
    store.enqueueSessionEvent({
      id: `evt-min-event-${session}`,
      botId: "bot-1",
      sessionId,
      kind: "script.finished",
      payload: {
        event: "script.finished",
        executionId: "exec-1",
        status: "in_doubt",
        result: {
          ok: false,
          error: {
            kind: "capability",
            message: `${"r".repeat(300)}. Already applied: none confirmed. ${UNKNOWN_OUTCOME}#1 notes.append.`,
          },
          logs: [],
        },
      },
    });
    await createEventDelivery({
      store,
      bots: store,
      admit: (request) => store.admit(request),
      maxResultBytes: MIN_RESULT_BYTES,
    })();

    const [message] = store.listMessages(sessionId);
    const eventText = (message!.parts[0] as { text: string }).text;
    const parsed = JSON.parse(eventText) as { status: string; result: ExecuteResult };

    expect(bytes(eventText)).toBeLessThanOrEqual(MIN_RESULT_BYTES);
    expect(parsed.status).toBe("in_doubt");
    expect(parsed.result.ok).toBe(false);
    if (!parsed.result.ok) {
      expect(parsed.result.error.kind).toBe("capability");
      expect(unknownWrites(parsed.result.error.message)).toEqual({
        listed: ["#1 notes.append"],
        omitted: 0,
      });
      expect(parsed.result.error.message).toMatch(TRUNCATION_FLAG);
    }
  });
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
    value: fc.oneof(fc.jsonValue({ maxDepth: 3 }), text).map((value) => value as JsonValue),
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

function inlineOutcomeOf(
  result: ExecuteResult,
  testCase: InlineCase,
  maxResultBytes: number,
): JsonValue {
  switch (testCase.kind) {
    case "value":
      return successOutcomeOf(
        result,
        {
          value: testCase.value,
          logs: testCase.logs,
          truncated: false,
        },
        maxResultBytes,
        0,
      );
    case "throw": {
      if (result.ok) {
        return { ok: true };
      }
      const normalizedMessage = normalizeUtf8(testCase.message);
      const messageCutFlagged =
        normalizedMessage.length === 0 ||
        result.error.message.includes(normalizedMessage) ||
        TRUNCATION_FLAG.test(result.error.message);
      const logsCutFlagged = logsCutHandled(
        result,
        testCase.logs.map(normalizeUtf8),
        maxResultBytes,
        0,
      );
      return {
        ok: false,
        kind: result.error.kind,
        messageCutFlagged,
        logsCutFlagged,
      };
    }
    case "invalid":
    case "aborted":
      return result.ok ? { ok: true } : { ok: false, kind: result.error.kind };
    case "unknown": {
      if (result.ok) {
        return { ok: true };
      }
      const unknown = testCase.writes.map((id, index) => `#${index + 1} ${id}`);
      const logsCutFlagged = logsCutHandled(
        result,
        testCase.logs.map(normalizeUtf8),
        maxResultBytes,
        0,
      );
      return {
        ok: false,
        kind: result.error.kind,
        logsCutFlagged,
        ...unknownOutcomeOf(result, unknown, testCase.logs.length > 0, maxResultBytes, 0),
      };
    }
  }
}

function expectedInline(testCase: InlineCase): JsonValue {
  switch (testCase.kind) {
    case "value":
      return {
        ok: true,
        valuePreservedOrCut: true,
        logsArePrefix: true,
        cutFlagged: true,
      };
    case "throw":
      return {
        ok: false,
        kind: "script",
        messageCutFlagged: true,
        logsCutFlagged: true,
      };
    case "invalid":
      return { ok: false, kind: "script" };
    case "aborted":
      return { ok: false, kind: "cancelled" };
    case "unknown":
      return {
        ok: false,
        kind: "capability",
        logsCutFlagged: true,
        accounted: testCase.writes.length,
        distinctNames: true,
        listedAreUnknown: true,
        keptAllThatFit: true,
        keptFittingName: true,
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
        expect({
          withinLimit: bytes(JSON.stringify(result)) <= maxResultBytes,
          outcome: inlineOutcomeOf(result, testCase, maxResultBytes),
        }).toEqual({ withinLimit: true, outcome: expectedInline(testCase) });
      }),
      { numRuns: 60 },
    );
  }, 120_000);
});
