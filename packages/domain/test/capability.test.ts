import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";
import {
  defineCapability,
  defineIntegration,
  IntegrationRegistry,
  type Capability,
} from "@der/domain";

const appendNote = defineCapability({
  id: "notes.append",
  description: "Append a note to the journal.\nUse for short entries.",
  input: z.object({
    text: z.string().describe("Body of the note"),
    tags: z.array(z.string()).optional(),
  }),
  output: z.object({ id: z.string(), count: z.number() }),
  effect: "write",
  approval: "none",
  example: 'await der.notes.append({ text: "buy milk" })',
  execute: async () => ({ id: "n1", count: 1 }),
});

const readWeather = defineCapability({
  id: "weather.read",
  description: "Current temperature for a city.",
  input: z.object({ city: z.string() }),
  output: z.unknown(),
  effect: "read",
  approval: "none",
  execute: async (input) => ({ city: input.city, celsius: 21 }),
});

async function registryWith(...capabilities: readonly Capability[]) {
  const registry = new IntegrationRegistry();
  await registry.register(defineIntegration({ id: "fixture", setup: () => ({ capabilities }) }));
  return registry;
}

describe("render a capability declaration", () => {
  it("names the input and output types and carries the description as a doc comment", async () => {
    const registry = await registryWith(appendNote);

    expect(registry.catalog.search("journal")[0]?.declaration).toBe(
      [
        "type NotesAppendInput = {",
        "  /** Body of the note */",
        "  text: string;",
        "  tags?: string[];",
        "};",
        "type NotesAppendOutput = {",
        "  id: string;",
        "  count: number;",
        "};",
        "/** Append a note to the journal. Use for short entries. */",
        "declare function der.notes.append(input: NotesAppendInput): Promise<NotesAppendOutput>;",
      ].join("\n"),
    );
  });

  it("renders an unknown output for a capability without an output shape", async () => {
    const registry = await registryWith(readWeather);

    expect(registry.catalog.search("temperature")[0]?.declaration).toBe(
      [
        "type WeatherReadInput = {",
        "  city: string;",
        "};",
        "type WeatherReadOutput = unknown;",
        "/** Current temperature for a city. */",
        "declare function der.weather.read(input: WeatherReadInput): Promise<WeatherReadOutput>;",
      ].join("\n"),
    );
  });
});

describe("search the catalog", () => {
  it("returns the id, first description line, declaration and example for a word in the description", async () => {
    const registry = await registryWith(appendNote, readWeather);

    const hits = registry.catalog.search("journal");

    expect(hits.map(({ declaration: _declaration, ...rest }) => rest)).toEqual([
      {
        id: "notes.append",
        summary: "Append a note to the journal.",
        example: 'await der.notes.append({ text: "buy milk" })',
      },
    ]);
  });

  it("ranks an id match above a description match", async () => {
    const mentionsWeather = defineCapability({
      id: "reports.daily",
      description: "Daily report including the weather.",
      input: z.object({}),
      output: z.unknown(),
      effect: "read",
      approval: "none",
      execute: async () => null,
    });
    const registry = await registryWith(mentionsWeather, readWeather);

    expect(registry.catalog.search("weather").map((hit) => hit.id)).toEqual([
      "weather.read",
      "reports.daily",
    ]);
  });

  it("matches a word in the example", async () => {
    const registry = await registryWith(appendNote, readWeather);

    expect(registry.catalog.search("milk").map((hit) => hit.id)).toEqual(["notes.append"]);
  });

  it("returns no hits for a query that matches nothing or is blank", async () => {
    const registry = await registryWith(appendNote, readWeather);

    expect(registry.catalog.search("zebra")).toEqual([]);
    expect(registry.catalog.search("   ")).toEqual([]);
  });

  it("caps the hits at the limit", async () => {
    const registry = await registryWith(appendNote, readWeather);

    expect(registry.catalog.search("a", 1)).toHaveLength(1);
  });
});

describe("list the catalog", () => {
  it("describes each capability with its effect, approval need and JSON schemas, sorted by id", async () => {
    const gated = defineCapability({
      id: "notes.delete",
      description: "Delete a note.",
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effect: "write",
      approval: "always",
      execute: async () => ({ ok: true }),
    });
    const registry = await registryWith(readWeather, gated);

    expect(registry.catalog.list()).toEqual([
      {
        id: "notes.delete",
        description: "Delete a note.",
        effect: "write",
        requiresApproval: true,
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        outputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      {
        id: "weather.read",
        description: "Current temperature for a city.",
        effect: "read",
        requiresApproval: false,
        inputSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
      },
    ]);
  });
});

describe("decide whether a call needs approval", () => {
  const transfer = defineCapability({
    id: "bank.transfer",
    description: "Move money.",
    input: z.object({ amount: z.number() }),
    output: z.object({ ok: z.boolean() }),
    effect: "write",
    approval: (input) => input.amount > 100,
    execute: async () => ({ ok: true }),
  });
  const removeNote = defineCapability({
    id: "notes.delete",
    description: "Delete a note.",
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    effect: "write",
    approval: "always",
    execute: async () => ({ ok: true }),
  });

  it.each([
    { id: "bank.transfer", input: { amount: 500 }, expected: true },
    { id: "bank.transfer", input: { amount: 5 }, expected: false },
    { id: "notes.append", input: { text: "x" }, expected: false },
    { id: "notes.delete", input: { id: "n1" }, expected: true },
    { id: "weather.read", input: { city: "Oslo" }, expected: false },
  ])("answers $expected for $id with $input", async ({ id, input, expected }) => {
    const registry = await registryWith(transfer, removeNote, appendNote, readWeather);

    expect(registry.catalog.requiresApproval(id, input)).toBe(expected);
  });

  it("answers false for input the capability rejects, because invoke fails before any effect", async () => {
    const registry = await registryWith(transfer);

    expect(registry.catalog.requiresApproval("bank.transfer", { amount: "lots" })).toBe(false);
  });

  it("rejects an unknown capability id", async () => {
    const registry = await registryWith(transfer);

    expect(() => registry.catalog.requiresApproval("bank.unknown", {})).toThrow(
      'Capability "bank.unknown" is not registered.',
    );
  });
});

describe("invoke a capability", () => {
  it("validates the input and returns the output", async () => {
    const registry = await registryWith(readWeather);

    await expect(registry.catalog.invoke("weather.read", { city: "Oslo" }, {})).resolves.toEqual({
      city: "Oslo",
      celsius: 21,
    });
  });

  it("rejects input that fails the schema", async () => {
    const registry = await registryWith(readWeather);

    await expect(registry.catalog.invoke("weather.read", { city: 7 }, {})).rejects.toMatchObject({
      code: "capability.invalid_input",
    });
  });

  it("rejects an unknown capability id", async () => {
    const registry = await registryWith(readWeather);

    await expect(registry.catalog.invoke("weather.nope", {}, {})).rejects.toMatchObject({
      code: "capability.unknown",
    });
  });
});

describe("register capabilities", () => {
  it("fails when one integration contributes two capabilities with the same id", async () => {
    await expect(registryWith(readWeather, readWeather)).rejects.toMatchObject({
      code: "integration.duplicate_capability_id",
    });
  });

  it("fails when a second integration contributes an id already registered", async () => {
    const registry = await registryWith(readWeather);

    await expect(
      registry.register(
        defineIntegration({ id: "other", setup: () => ({ capabilities: [readWeather] }) }),
      ),
    ).rejects.toMatchObject({ code: "integration.duplicate_capability_id" });
  });

  it("adds the capabilities an integration lists at start", async () => {
    const registry = await registryWith(readWeather);
    await registry.register(
      defineIntegration({
        id: "remote",
        setup: () => ({ listCapabilities: async () => [appendNote] }),
      }),
    );

    await registry.start();

    expect(registry.catalog.list().map((entry) => entry.id)).toEqual([
      "notes.append",
      "weather.read",
    ]);
  });

  it("fails start when a listed capability reuses a registered id and adds none of that integration's capabilities", async () => {
    const registry = await registryWith(readWeather);
    await registry.register(
      defineIntegration({
        id: "remote",
        setup: () => ({ listCapabilities: async () => [appendNote, readWeather] }),
      }),
    );

    await expect(registry.start()).rejects.toMatchObject({
      code: "integration.duplicate_capability_id",
    });
    expect(registry.catalog.list().map((entry) => entry.id)).toEqual(["weather.read"]);
  });
});

describe("define a capability", () => {
  it.each(["write", "weather.read.", "9a.b", "a-b.c", ""])(
    "rejects the id %j that is not a namespaced identifier path",
    (id) => {
      expect(() => defineCapability({ ...readWeather, id })).toThrow(
        /must be dot-separated identifiers/,
      );
    },
  );

  it("rejects a read that asks for approval", () => {
    expect(() => defineCapability({ ...readWeather, approval: "always" })).toThrow(
      'Capability "weather.read" is a read and cannot require approval; declare it as a write.',
    );
  });
});
