import { describe, expect, it } from "bun:test";
import * as z from "zod";
import {
  defineCapability,
  fingerprintJson,
  formatUtcTimestamp,
  type NewStep,
  type StepOutcome,
} from "@der/domain";
import { openScriptFixture } from "./fixtures/script-host";

const source = `
  const a = await step.run("notes.read", { key: "a" });
  await step.run("notes.append", { text: a.value });
  const b = await step.run("notes.read", { key: "b" });
  await step.run("notes.append", { text: b.value });
  return await step.run("notes.read", { key: "c" });
`;

const scenario = [
  { capability: "notes.read", effect: "read", input: { key: "a" }, result: { value: "value-a" } },
  { capability: "notes.append", effect: "write", input: { text: "value-a" }, result: { count: 1 } },
  { capability: "notes.read", effect: "read", input: { key: "b" }, result: { value: "value-b" } },
  { capability: "notes.append", effect: "write", input: { text: "value-b" }, result: { count: 2 } },
  { capability: "notes.read", effect: "read", input: { key: "c" }, result: { value: "value-c" } },
] as const;

describe("recover Scripts from SQLite", () => {
  it.each([
    { position: 1, phase: "registered" },
    { position: 1, phase: "completed" },
    { position: 1, phase: "delivered" },
    { position: 2, phase: "registered" },
    { position: 2, phase: "ledger" },
    { position: 2, phase: "completed" },
    { position: 2, phase: "delivered" },
    { position: 3, phase: "registered" },
    { position: 3, phase: "completed" },
    { position: 3, phase: "delivered" },
    { position: 4, phase: "registered" },
    { position: 4, phase: "ledger" },
    { position: 4, phase: "completed" },
    { position: 4, phase: "delivered" },
    { position: 5, phase: "registered" },
    { position: 5, phase: "completed" },
    { position: 5, phase: "delivered" },
  ])(
    "resumes step $position at $phase without repeating a stored read or write",
    async ({ position, phase }) => {
      const fixture = await openScriptFixture();
      const first = fixture.openDriver();
      const execution = first.acquire(source);
      let restarted: ReturnType<typeof fixture.open> | undefined;
      let second: ReturnType<typeof fixture.openDriver> | undefined;
      try {
        const { scripts } = first;
        for (const [index, entry] of scenario.slice(0, position).entries()) {
          const n = index + 1;
          const step: NewStep = {
            position: n,
            capability: entry.capability,
            effect: entry.effect,
            decision: "allow",
            input: entry.input,
            inputHash: await fingerprintJson(entry.input),
          };
          scripts.registerSteps(execution.id, [step]);
          if (n === position && phase === "registered") break;
          if (entry.effect === "write") {
            fixture.host.appended.push(entry.input.text);
            const begun = await fixture.store.beginEffect({
              runId: fixture.run.id,
              operationKind: "capability",
              operationId: entry.capability,
              canonicalArguments: entry.input,
              attemptId: `${execution.id}:${n}`,
            });
            await fixture.store.completeEffect(begun.effect.id, { ok: true, value: entry.result });
            if (n === position && phase === "ledger") break;
          } else {
            fixture.host.reads.push(entry.input.key);
          }
          scripts.completeStep(execution.id, n, { status: "done", result: entry.result });
          if (n === position && phase === "completed") break;
          scripts.markDelivered(execution.id, [n]);
        }
        await first.driver.close();
        fixture.store.close();

        restarted = fixture.open();
        second = fixture.openDriver(restarted);
        await second.driver.kick(execution.id);

        expect(second.scripts.load(execution.id).execution.result).toEqual({
          ok: true,
          result: { value: "value-c" },
          logs: [],
          truncated: false,
        });
        expect(fixture.host.reads).toEqual(["a", "b", "c"]);
        expect(fixture.host.appended).toEqual(["value-a", "value-b"]);
      } finally {
        await first.driver.close();
        await second?.driver.close();
        (restarted ?? fixture.store).close();
        fixture.database.cleanup();
      }
    },
  );

  it("does not repeat an ambiguous write, applies its sibling, and blocks a different execution's write", async () => {
    const fixture = await openScriptFixture();
    const first = fixture.openDriver();
    const { id } = first.acquire(`
      return await step.all([
        step.run("notes.append", { text: "ambiguous" }),
        step.run("notes.append", { text: "sibling" }),
      ]);
    `);
    const input = { text: "ambiguous" };
    first.scripts.registerSteps(id, [
      {
        position: 1,
        capability: "notes.append",
        effect: "write",
        decision: "allow",
        input,
        inputHash: await fingerprintJson(input),
      },
    ]);
    const effect = {
      runId: fixture.run.id,
      operationKind: "capability",
      operationId: "notes.append",
      canonicalArguments: input,
      attemptId: `${id}:1`,
    } as const;
    await fixture.store.beginEffect(effect);
    await first.driver.close();
    fixture.store.close();

    const reopened = fixture.open();
    const second = fixture.openDriver(reopened);
    try {
      await second.driver.kick(id);
      const { execution, steps } = second.scripts.load(id);
      expect(execution.status).toBe("in_doubt");
      expect(steps.map(({ status, seq }) => [status, seq])).toEqual([
        ["unknown", null],
        ["done", 1],
      ]);
      expect(reopened.getEffect(effect)?.status).toBe("unknown");

      const foreign = second.acquire('return await step.run("notes.append", { text: "foreign" });');
      await second.driver.kick(foreign.id);
      expect(second.scripts.load(foreign.id).execution.result).toMatchObject({
        ok: false,
        error: {
          kind: "capability",
          message: expect.stringContaining("notes.append"),
        },
      });
      expect(fixture.host.appended).toEqual(["sibling"]);
    } finally {
      await second.driver.close();
      reopened.close();
      fixture.database.cleanup();
    }
  });

  it("skips saved writes and withdraws Approval when a requested input differs", async () => {
    const fixture = await openScriptFixture();
    const { scripts, driver, acquire } = fixture.openDriver();
    try {
      const { id } = acquire('return await step.run("notes.publish", { text: "changed" });');
      const input = { text: "original" };
      scripts.registerSteps(id, [
        {
          position: 1,
          capability: "notes.publish",
          effect: "write",
          decision: "ask",
          input,
          inputHash: await fingerprintJson(input),
          round: 1,
        },
      ]);
      const { approval } = await fixture.store.requestApproval({
        id: `appr_${id}_1`,
        botId: fixture.run.botId,
        sessionId: fixture.run.sessionId,
        runId: fixture.run.id,
        effect: {
          runId: fixture.run.id,
          operationKind: "capability",
          operationId: "notes.publish",
          canonicalArguments: input,
          attemptId: `${id}:1`,
        },
        awakeable: `script:${id}`,
        deadline: formatUtcTimestamp(new Date("2026-11-24T02:00:00Z")),
        prompt: "Publish original",
      });
      await driver.kick(id);
      expect(scripts.load(id)).toMatchObject({
        execution: {
          status: "failed",
          result: {
            ok: false,
            error: {
              kind: "nondeterministic",
              message: expect.any(String),
            },
          },
        },
        steps: [{ status: "skipped" }],
      });
      expect(fixture.store.getApproval(approval.id)?.decision.status).toBe("expired");
      expect(fixture.host.published).toEqual([]);
    } finally {
      await driver.close();
      fixture.store.close();
      fixture.database.cleanup();
    }
  });

  it("replays six asynchronous branches in recorded order across different read completion orders", async () => {
    const fixture = await openScriptFixture();
    const first = fixture.openDriver();
    const { id } = first.acquire(`
      return await Promise.all(["a","b","c","d","e","f"].map(async (key) => {
        const first = await step.run("notes.read", { key });
        const second = await step.run("notes.read", { key: first.value });
        return await step.run("notes.publish", { text: second.value });
      }));
    `);
    try {
      // The first wave completed in reverse branch order. Its undelivered next read
      // is durable even though the restarted fixture would invoke reads in call order.
      const initial = ["a", "b", "c", "d", "e", "f"];
      const requests = await Promise.all(
        initial.map(async (key, index): Promise<NewStep> => ({
          position: index + 1,
          capability: "notes.read",
          effect: "read",
          decision: "allow",
          input: { key },
          inputHash: await fingerprintJson({ key }),
        })),
      );
      first.scripts.registerSteps(id, requests);
      for (const [index, key] of initial.entries()) {
        first.scripts.completeStep(id, index + 1, {
          status: "done",
          result: { value: `value-${key}` },
        });
      }
      first.scripts.markDelivered(id, [6, 5, 4]);
      for (const [index, key] of ["value-e", "value-d"].entries()) {
        const input = { key };
        first.scripts.registerSteps(id, [
          {
            position: index + 8,
            capability: "notes.read",
            input,
            inputHash: await fingerprintJson(input),
            effect: "read",
            decision: "allow",
          },
        ]);
      }
      first.scripts.markDelivered(id, [3, 2, 1]);
      const input = { key: "value-f" };
      first.scripts.registerSteps(id, [
        {
          position: 7,
          capability: "notes.read",
          input,
          inputHash: await fingerprintJson(input),
          effect: "read",
          decision: "allow",
        },
      ]);
      const outcome: StepOutcome = { status: "done", result: { value: "value-value-f" } };
      first.scripts.completeStep(id, 7, outcome);
      await first.driver.close();

      const reopened = fixture.open();
      const second = fixture.openDriver(reopened);
      try {
        await second.driver.kick(id);
        const approvals = reopened.listPendingApprovalsForRun(fixture.run.id);
        expect(approvals).toHaveLength(6);
        for (const approval of approvals) {
          await second.driver.decide(fixture.decide(approval, "approved"));
        }
        await second.driver.wait(id, AbortSignal.timeout(3000));
        expect(
          second.scripts
            .load(id)
            .steps.slice(6, 12)
            .map(({ input: args }) => args),
        ).toEqual([
          { key: "value-f" },
          { key: "value-e" },
          { key: "value-d" },
          { key: "value-c" },
          { key: "value-b" },
          { key: "value-a" },
        ]);
        expect(fixture.host.reads).toEqual(["value-e", "value-d", "value-c", "value-b", "value-a"]);
        expect(fixture.host.published).toEqual([
          "value-value-f",
          "value-value-e",
          "value-value-d",
          "value-value-c",
          "value-value-b",
          "value-value-a",
        ]);
      } finally {
        await second.driver.close();
        reopened.close();
      }
    } finally {
      await first.driver.close();
      fixture.store.close();
      fixture.database.cleanup();
    }
  });

  it("keeps six branches at their recorded positions when the external read order changes after restart", async () => {
    const fixture = await openScriptFixture();
    const keys = ["a", "b", "c", "d", "e", "f"];
    const gates = new Map(keys.map((key) => [key, Promise.withResolvers<void>()]));
    const secondReads = new Map(keys.map((key) => [key, Promise.withResolvers<void>()]));
    const allStarted = Promise.withResolvers<void>();
    const reads: string[] = [];
    let restarted = false;
    fixture.host.catalog.add(
      defineCapability({
        id: "notes.branch",
        description: "Read a branch from the external store.",
        input: z.string(),
        output: z.string(),
        effect: "read",
        approval: "none",
        async execute(key) {
          reads.push(key);
          if (reads.length === 6) allStarted.resolve();
          if (restarted) {
            // The replacement transport returns initial reads immediately in call order.
            return key;
          }
          await gates.get(key)?.promise;
          secondReads.get(key.slice(1))?.resolve();
          return key;
        },
      }),
    );
    const first = fixture.openDriver();
    const { id } = first.acquire(`
      return await Promise.all(["a","b","c","d","e","f"].map(async (key) => {
        const first = await step.run("notes.branch", key);
        const second = await step.run("notes.branch", ":" + first);
        return await step.run("notes.publish", { text: second });
      }));
    `);
    let reopened: ReturnType<typeof fixture.open> | undefined;
    let second: ReturnType<typeof fixture.openDriver> | undefined;
    try {
      const driving = first.driver.kick(id);
      await allStarted.promise;
      for (const key of ["f", "e", "d", "c", "b", "a"]) {
        gates.get(key)!.resolve();
        await secondReads.get(key)!.promise;
      }
      await driving;
      const stored = first.scripts
        .load(id)
        .steps.map(({ position, capability, input }) => ({ position, capability, input }));
      expect(
        stored
          .filter(({ capability, position }) => capability === "notes.branch" && position > 6)
          .map(({ input }) => input),
      ).toEqual([":f", ":e", ":d", ":c", ":b", ":a"]);
      await first.driver.close();
      fixture.store.close();

      restarted = true;
      reopened = fixture.open();
      second = fixture.openDriver(reopened);
      await second.driver.kick(id);
      const approvals = reopened.listPendingApprovalsForRun(fixture.run.id);
      expect(approvals.map(({ effect }) => effect.canonicalArguments)).toEqual([
        { text: ":f" },
        { text: ":e" },
        { text: ":d" },
        { text: ":c" },
        { text: ":b" },
        { text: ":a" },
      ]);
      for (const approval of approvals) {
        await second.driver.decide(fixture.decide(approval, "approved"));
      }
      expect(await second.driver.wait(id, AbortSignal.timeout(3000))).toMatchObject({ ok: true });
      expect(
        second.scripts
          .load(id)
          .steps.map(({ position, capability, input }) => ({ position, capability, input })),
      ).toEqual(stored);
      expect(reads).toEqual(["a", "b", "c", "d", "e", "f", ":f", ":e", ":d", ":c", ":b", ":a"]);
      expect(fixture.host.published).toEqual([":f", ":e", ":d", ":c", ":b", ":a"]);
    } finally {
      await first.driver.close();
      await second?.driver.close();
      (reopened ?? fixture.store).close();
      fixture.database.cleanup();
    }
  });

  it("drops the driver while a write is in flight and resumes its independent sibling after reopening", async () => {
    const fixture = await openScriptFixture();
    const first = fixture.openDriver();
    const invoked = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<string>();
    const attempts: string[] = [];
    fixture.host.catalog.add(
      defineCapability({
        id: "notes.pending",
        description: "Wait for an external acknowledgement.",
        input: z.string(),
        output: z.string(),
        effect: "write",
        approval: "none",
        async execute(value) {
          attempts.push(value);
          invoked.resolve();
          return reply.promise;
        },
      }),
    );
    const { id } = first.acquire(`
      return await step.all([
        step.run("notes.pending", "slow"),
        step.run("notes.append", { text: "sibling" }),
      ]);
    `);
    const driving = first.driver.kick(id);
    const stopped = driving.catch((error: unknown) => error);
    await invoked.promise;
    await first.driver.close();
    expect(await stopped).toMatchObject({ name: "AbortError" });
    expect(first.scripts.load(id).steps.map(({ status }) => status)).toEqual([
      "pending",
      "pending",
    ]);
    fixture.store.close();

    const reopened = fixture.open();
    const second = fixture.openDriver(reopened);
    try {
      await second.driver.kick(id);
      expect(second.scripts.load(id)).toMatchObject({
        execution: { status: "in_doubt" },
        steps: [
          { status: "unknown", seq: null },
          { status: "done", seq: 1 },
        ],
      });
      expect(attempts).toEqual(["slow"]);
      expect(fixture.host.appended).toEqual(["sibling"]);
    } finally {
      reply.resolve("late");
      await second.driver.close();
      reopened.close();
      fixture.database.cleanup();
    }
  });

  it.each([
    {
      case: "a stored read whose capability now declares write",
      capability: "notes.publish",
      effect: "read",
    },
    {
      case: "a stored write whose capability now declares read",
      capability: "notes.read",
      effect: "write",
    },
    {
      case: "a stored step whose capability no longer exists",
      capability: "notes.removed",
      effect: "read",
    },
  ] as const)("fails the re-run of $case before invoking anything", async (testCase) => {
    const fixture = await openScriptFixture();
    const first = fixture.openDriver();
    const input = { text: "x", key: "x" };
    const { id } = first.acquire(
      `return await step.run(${JSON.stringify(testCase.capability)}, ${JSON.stringify(input)});`,
    );
    first.scripts.registerSteps(id, [
      {
        position: 1,
        capability: testCase.capability,
        effect: testCase.effect,
        decision: "allow",
        input,
        inputHash: await fingerprintJson(input),
      },
    ]);
    await first.driver.close();
    fixture.store.close();

    const reopened = fixture.open();
    const second = fixture.openDriver(reopened);
    try {
      await second.driver.kick(id);

      expect({
        execution: second.scripts.load(id).execution.status,
        result: second.scripts.load(id).execution.result,
        invoked: [...fixture.host.reads, ...fixture.host.appended, ...fixture.host.published],
        approvals: reopened.listPendingApprovalsForRun(fixture.run.id),
      }).toMatchObject({
        execution: "failed",
        result: {
          ok: false,
          error: {
            kind: "nondeterministic",
            message: expect.stringContaining(testCase.capability),
          },
          logs: [],
        },
        invoked: [],
        approvals: [],
      });
    } finally {
      await second.driver.close();
      reopened.close();
      fixture.database.cleanup();
    }
  });

  it.each([
    {
      case: "a removed capability",
      second: "notes.removed",
      limits: {},
      kind: "nondeterministic",
    },
    {
      case: "the step limit",
      second: "notes.read",
      limits: { maxSteps: 1 },
      kind: "limit",
    },
  ] as const)(
    "ends in doubt and interrupts the Run when a re-run stops on $case after a write that started",
    async (testCase) => {
      const fixture = await openScriptFixture();
      const first = fixture.openDriver();
      const write = { text: "x" };
      const read = { key: "x" };
      const { id } = first.acquire(`
        return await step.all([
          step.run("notes.append", ${JSON.stringify(write)}),
          step.run(${JSON.stringify(testCase.second)}, ${JSON.stringify(read)}),
        ]);
      `);
      first.scripts.registerSteps(id, [
        {
          position: 1,
          capability: "notes.append",
          effect: "write",
          decision: "allow",
          input: write,
          inputHash: await fingerprintJson(write),
        },
        ...(testCase.second === "notes.removed"
          ? [
              {
                position: 2,
                capability: "notes.removed",
                effect: "read" as const,
                decision: "allow" as const,
                input: read,
                inputHash: await fingerprintJson(read),
              },
            ]
          : []),
      ]);
      const effect = {
        runId: fixture.run.id,
        operationKind: "capability",
        operationId: "notes.append",
        canonicalArguments: write,
        attemptId: `${id}:1`,
      } as const;
      await fixture.store.beginEffect(effect);
      await first.driver.close();
      fixture.store.close();

      const reopened = fixture.open();
      const second = fixture.openDriver(reopened, testCase.limits);
      try {
        const result = await second.driver.wait(id, new AbortController().signal);

        expect({
          execution: second.scripts.load(id).execution.status,
          result,
          effect: reopened.getEffect(effect)?.status,
          run: reopened.getRun(fixture.run.id)?.status,
          appended: fixture.host.appended,
        }).toMatchObject({
          execution: "in_doubt",
          result: {
            ok: false,
            error: {
              kind: testCase.kind,
              message: expect.stringMatching(/Unknown outcome:.*notes\.append/),
            },
            logs: [],
          },
          effect: "unknown",
          run: "interrupted",
          appended: [],
        });
      } finally {
        await second.driver.close();
        reopened.close();
        fixture.database.cleanup();
      }
    },
  );

  it("interrupts at startup the active Run of an execution that ended in doubt", async () => {
    const fixture = await openScriptFixture();
    const first = fixture.openDriver();
    const input = { text: "x" };
    const { id } = first.acquire('return await step.run("notes.append", { text: "x" });');
    first.scripts.registerSteps(id, [
      {
        position: 1,
        capability: "notes.append",
        effect: "write",
        decision: "allow",
        input,
        inputHash: await fingerprintJson(input),
      },
    ]);
    const { effect } = await fixture.store.beginEffect({
      runId: fixture.run.id,
      operationKind: "capability",
      operationId: "notes.append",
      canonicalArguments: input,
      attemptId: `${id}:1`,
    });
    await fixture.store.markEffectUnknown(effect.id);
    const message = "Write 1 (notes.append) has an unknown outcome: process stopped";
    first.scripts.completeStep(id, 1, {
      status: "unknown",
      error: { kind: "failed", message: "process stopped" },
    });
    first.scripts.finish(id, {
      status: "in_doubt",
      result: { ok: false, error: { kind: "capability", message }, logs: [] },
    });
    await first.driver.close();
    fixture.store.close();

    const reopened = fixture.open();
    const second = fixture.openDriver(reopened);
    try {
      await second.driver.sweep();

      expect({
        run: reopened.getRun(fixture.run.id)?.status,
        checkpoint: reopened.getRun(fixture.run.id)?.checkpoint,
      }).toEqual({
        run: "interrupted",
        checkpoint: { interruptedEffectId: effect.id, recordedAt: "2026-11-24T01:00:00.000Z" },
      });
    } finally {
      await second.driver.close();
      reopened.close();
      fixture.database.cleanup();
    }
  });

  it("keeps the registered Approval decision when the capability predicate changes on restart", async () => {
    const fixture = await openScriptFixture();
    let asks = true;
    fixture.host.catalog.add(
      defineCapability({
        id: "notes.policy",
        description: "Write a note.",
        input: z.string(),
        output: z.string(),
        effect: "write",
        approval: () => asks,
        async execute(text) {
          fixture.host.appended.push(text);
          return text;
        },
      }),
    );
    const first = fixture.openDriver();
    const { id } = first.acquire('return await step.run("notes.policy", "entry");');
    let reopened: ReturnType<typeof fixture.open> | undefined;
    let second: ReturnType<typeof fixture.openDriver> | undefined;
    try {
      await first.driver.kick(id);
      const [approval] = fixture.store.listPendingApprovalsForRun(fixture.run.id);
      await first.driver.close();
      fixture.store.close();

      asks = false;
      reopened = fixture.open();
      second = fixture.openDriver(reopened);
      await second.driver.kick(id);
      expect(
        reopened.listPendingApprovalsForRun(fixture.run.id).map(({ id: approvalId }) => approvalId),
      ).toEqual([approval!.id]);
      expect(fixture.host.appended).toEqual([]);

      await second.driver.decide(fixture.decide(approval!, "approved"));
      expect(await second.driver.wait(id, AbortSignal.timeout(3000))).toEqual({
        ok: true,
        result: "entry",
        logs: [],
        truncated: false,
      });
      expect(fixture.host.appended).toEqual(["entry"]);
    } finally {
      await first.driver.close();
      await second?.driver.close();
      (reopened ?? fixture.store).close();
      fixture.database.cleanup();
    }
  });

  it("leaves a live lease alone and resumes after its deadline in the sweep", async () => {
    const fixture = await openScriptFixture();
    const { scripts, driver, acquire } = fixture.openDriver();
    try {
      const { id } = acquire('return await step.run("notes.append", { text: "recovered" });');
      expect(
        scripts.takeLease(
          id,
          "previous-driver",
          formatUtcTimestamp(new Date("2026-11-24T01:00:02Z")),
        ),
      ).toBe(true);
      await driver.kick(id);
      expect(scripts.load(id).steps).toEqual([]);
      fixture.advance(2001);
      await driver.sweep();
      expect(await driver.wait(id, AbortSignal.timeout(3000))).toEqual({
        ok: true,
        result: { count: 1 },
        logs: [],
        truncated: false,
      });
      expect(fixture.host.appended).toEqual(["recovered"]);
    } finally {
      await driver.close();
      fixture.store.close();
      fixture.database.cleanup();
    }
  });

  it("two drivers kicked together apply each write once", async () => {
    const fixture = await openScriptFixture();
    const reopened = fixture.open();
    const first = fixture.openDriver();
    const second = fixture.openDriver(reopened);
    try {
      const { id } = first.acquire(source);
      await Promise.all([first.driver.kick(id), second.driver.kick(id)]);
      expect(fixture.host.appended).toEqual(["value-a", "value-b"]);
      expect(fixture.host.reads).toEqual(["a", "b", "c"]);
      expect(second.scripts.load(id).execution.status).toBe("completed");
    } finally {
      await Promise.all([first.driver.close(), second.driver.close()]);
      reopened.close();
      fixture.store.close();
      fixture.database.cleanup();
    }
  });
});
