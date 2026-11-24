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
  example: 'await step.run("notes.append", { text: "buy milk" })',
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

describe("render a capability declaration", () => {
  it("names the input and output types and carries the description as a doc comment", async () => {
    const registry = await registryWith(appendNote);

    const declaration = registry.catalog.search("journal")[0]?.declaration ?? "";

    expect(parseDeclaration(declaration)).toEqual({
      types: {
        NotesAppendInput: {
          text: { type: "string", optional: false, doc: "Body of the note" },
          tags: { type: "string[]", optional: true, doc: "" },
        },
        NotesAppendOutput: {
          id: { type: "string", optional: false, doc: "" },
          count: { type: "number", optional: false, doc: "" },
        },
      },
      stepRun: {
        id: "notes.append",
        inputType: "NotesAppendInput",
        outputType: "NotesAppendOutput",
        doc: "Append a note to the journal. Use for short entries.",
      },
    });
  });

  it("renders an unknown output for a capability without an output shape", async () => {
    const registry = await registryWith(readWeather);

    const declaration = registry.catalog.search("temperature")[0]?.declaration ?? "";

    expect(parseDeclaration(declaration)).toEqual({
      types: {
        WeatherReadInput: {
          city: { type: "string", optional: false, doc: "" },
        },
        WeatherReadOutput: "unknown",
      },
      stepRun: {
        id: "weather.read",
        inputType: "WeatherReadInput",
        outputType: "WeatherReadOutput",
        doc: "Current temperature for a city.",
      },
    });
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
        example: 'await step.run("notes.append", { text: "buy milk" })',
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

describe("validate capability input", () => {
  it("uses the capability refinement without executing the capability", async () => {
    let invocations = 0;
    const registry = await registryWith(
      defineCapability({
        ...readWeather,
        input: z.object({ city: z.string().refine((city) => city !== "Atlantis") }),
        execute: async () => ++invocations,
      }),
    );
    expect(registry.catalog.list()[0]?.inputSchema).toMatchObject({
      properties: { city: { type: "string" } },
    });
    let thrown: unknown;
    try {
      registry.catalog.validateInput("weather.read", { city: "Atlantis" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "capability.invalid_input", status: 400 });
    expect(registry.catalog.validateInput("weather.read", { city: "Oslo" })).toEqual({
      city: "Oslo",
    });
    expect(invocations).toBe(0);
  });
});
