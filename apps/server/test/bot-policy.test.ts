import { afterEach, describe, expect, it } from "bun:test";
import * as z from "zod";
import { defineCapability, type CapabilityPolicy } from "@der/domain";
import { openScriptFixture } from "./fixtures/script-host";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(policy: CapabilityPolicy) {
  const fixture = await openScriptFixture();
  fixture.store.updateBot("bot-script", { capabilityPolicy: policy });
  const execution = fixture.openDriver(fixture.store);
  const applied: string[] = [];
  fixture.host.catalog.add(
    defineCapability({
      id: "notes.audit",
      description: "Audit a note",
      input: z.object({ text: z.string() }),
      output: z.object({ audited: z.boolean() }),
      effect: "write",
      approval: "none",
      async execute({ text }) {
        applied.push(text);
        return { audited: true };
      },
    }),
  );
  cleanups.push(async () => {
    await execution.driver.close();
    fixture.store.close();
    fixture.database.cleanup();
  });
  return { ...fixture, ...execution, audited: applied };
}

describe("apply a bot policy to Script steps", () => {
  it("applies a write declared always with no Approval when the policy allows it", async () => {
    const { host, store, run, acquire, driver, scripts } = await setup({
      "notes.publish": "allow",
    });
    const { id } = acquire(`return await step.run("notes.publish", { text: "release" });`);
    await driver.kick(id);

    expect(host.published).toEqual(["release"]);
    expect(store.listPendingApprovalsForRun(run.id)).toEqual([]);
    expect(scripts.load(id).execution.status).toBe("completed");
    expect(scripts.load(id).steps.map(({ decision }) => decision)).toEqual(["allow"]);
  });

  it("holds a write declared none for an Approval of its exact arguments when the policy asks", async () => {
    const { host, store, run, acquire, driver, scripts, decide } = await setup({
      "notes.append": "ask",
    });
    const { id } = acquire(`return await step.run("notes.append", { text: "careful" });`);
    await driver.kick(id);

    const pending = store.listPendingApprovalsForRun(run.id);
    expect(pending.map(({ effect }) => effect.canonicalArguments)).toEqual([{ text: "careful" }]);
    expect(host.appended).toEqual([]);

    await driver.decide(decide(pending[0]!, "approved"));
    await driver.wait(id, AbortSignal.timeout(3000));
    expect(host.appended).toEqual(["careful"]);
    expect(scripts.load(id).execution.status).toBe("completed");
  });

  it("settles the other writes of a group when the policy denies one, and ends the Script failed", async () => {
    const { host, audited, acquire, driver, scripts } = await setup({
      "notes.audit": "deny",
      "notes.publish": "allow",
    });
    const { id } = acquire(`
      await step.all([
        step.run("notes.append", { text: "a" }),
        step.run("notes.audit", { text: "b" }),
        step.run("notes.publish", { text: "c" }),
      ]);
    `);
    await driver.kick(id);

    expect(host.appended).toEqual(["a"]);
    expect(host.published).toEqual(["c"]);
    expect(audited).toEqual([]);
    const { execution, steps } = scripts.load(id);
    expect(execution.status).toBe("failed");
    expect(steps.map(({ status }) => status)).toEqual(["done", "failed", "done"]);
    expect(steps[1]).toMatchObject({
      error: { kind: "refused", step: 2, capability: "notes.audit", input: { text: "b" } },
    });
  });

  it("lets a Script catch a refusal as kind refused and end completed", async () => {
    const { audited, acquire, driver, scripts } = await setup({ "notes.audit": "deny" });
    const { id } = acquire(`
      try {
        return await step.run("notes.audit", { text: "b" });
      } catch (error) {
        return { kind: error.kind, step: error.step };
      }
    `);
    await driver.kick(id);

    expect(scripts.load(id).execution).toMatchObject({
      status: "completed",
      result: { ok: true, result: { kind: "refused", step: 1 } },
    });
    expect(audited).toEqual([]);
  });

  it("refuses a read the policy denies without invoking it", async () => {
    const { host, acquire, driver, scripts } = await setup({ notes: "deny" });
    const { id } = acquire(`return await step.run("notes.read", { key: "k" });`);
    await driver.kick(id);

    expect(host.reads).toEqual([]);
    expect(scripts.load(id).steps[0]).toMatchObject({
      decision: "deny",
      status: "failed",
      error: { kind: "refused" },
    });
  });

  it("runs a read the policy asks about without an Approval", async () => {
    const { host, store, run, acquire, driver } = await setup({ "notes.read": "ask" });
    const { id } = acquire(`return await step.run("notes.read", { key: "k" });`);
    await driver.kick(id);

    expect(host.reads).toEqual(["k"]);
    expect(store.listPendingApprovalsForRun(run.id)).toEqual([]);
  });

  it("keeps a stored step's decision when the policy changes before a re-run", async () => {
    const { host, store, run, acquire, driver, scripts, decide } = await setup({
      "notes.publish": "ask",
    });
    const { id } = acquire(`return await step.run("notes.publish", { text: "release" });`);
    await driver.kick(id);
    const [approval] = store.listPendingApprovalsForRun(run.id);
    expect(approval).toBeDefined();

    store.updateBot("bot-script", { capabilityPolicy: { "notes.publish": "deny" } });
    await driver.kick(id);

    expect(scripts.load(id).steps.map(({ decision }) => decision)).toEqual(["ask"]);
    expect(host.published).toEqual([]);
    await driver.decide(decide(approval!, "approved"));
    await driver.wait(id, AbortSignal.timeout(3000));
    expect(host.published).toEqual(["release"]);
    expect(scripts.load(id).execution.status).toBe("completed");
  });
});
