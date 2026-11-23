import { describe, expect, it } from "bun:test";
import type { MemoryRecord, Skill } from "@der/domain";
import { buildRunContext, type BuildRunContextInput } from "@der/runtime/context";

const MEMORY_POINTER = "[truncated: the rest is available through the memory capability]";
const SKILLS_POINTER = "[truncated: the rest is available through the skills capability]";

function memoryOf(markdown: string, version = 1): MemoryRecord {
  return {
    id: "mem-1",
    botId: "bot-1",
    version,
    markdown,
    updatedAt: "2026-06-01T09:00:00.000Z",
  };
}

function build(overrides: Partial<BuildRunContextInput> = {}) {
  return buildRunContext({
    bot: { id: "bot-1", name: "Ops Bot", persona: "Terse operator assistant." },
    messages: [],
    compaction: { maxTokens: 1_000_000 },
    ...overrides,
  });
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function manySkills(count: number): Skill[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `skill-${index}`,
    name: `skill-${index}`,
    description: `Does thing number ${index} for the operator.`,
    relativePath: `skill-${index}/SKILL.md`,
  }));
}

describe("cap memory and the skill catalog in the system prompt", () => {
  it("cuts 30,000 bytes of memory to at most 24,000 on a line boundary and ends with the pointer line", async () => {
    const markdown = "abcdefghi\n".repeat(3000).trim();
    const context = await build({
      memory: memoryOf(markdown),
      caps: { memoryMaxBytes: 24_000 },
    });

    const memoryPart = context.systemPrompts[1]!;
    const lines = memoryPart.split("\n");
    expect(bytes(memoryPart)).toBeLessThanOrEqual(24_000);
    expect(bytes(memoryPart)).toBeGreaterThan(23_980);
    expect(lines.at(-1)).toBe(MEMORY_POINTER);
    expect(lines[0]).toBe("[Bot Memory v1]");
    expect(lines.slice(1, -1).every((line) => line === "abcdefghi")).toBe(true);
  });

  it("returns memory under the cap byte-identical", async () => {
    const context = await build({
      memory: memoryOf("# Memory\n\nAlways reply in UTC.", 3),
      caps: { memoryMaxBytes: 24_000 },
    });

    expect(context.systemPrompts[1]).toBe("[Bot Memory v3]\n# Memory\n\nAlways reply in UTC.");
  });

  it("never splits a multi-byte character when cutting memory", async () => {
    const context = await build({
      memory: memoryOf("ééééé\n".repeat(5000).trim()),
      caps: { memoryMaxBytes: 100 },
    });

    const memoryPart = context.systemPrompts[1]!;
    const lines = memoryPart.split("\n");
    expect(bytes(memoryPart)).toBeLessThanOrEqual(100);
    expect(lines.at(-1)).toBe(MEMORY_POINTER);
    expect(lines.slice(1, -1).every((line) => line === "ééééé")).toBe(true);
    expect(lines.length).toBeGreaterThan(2);
  });

  it("keeps only the header and pointer line when the first memory line alone exceeds the cap", async () => {
    const context = await build({
      memory: memoryOf("x".repeat(500)),
      caps: { memoryMaxBytes: 200 },
    });

    expect(context.systemPrompts[1]).toBe(`[Bot Memory v1]\n${MEMORY_POINTER}`);
  });

  it("cuts the skill catalog to the cap and ends with the skills pointer line", async () => {
    const context = await build({
      skills: manySkills(80),
      caps: { skillCatalogMaxBytes: 800 },
    });

    const catalog = context.systemPrompts[1]!;
    expect(bytes(catalog)).toBeLessThanOrEqual(800);
    expect(catalog.split("\n").at(-1)).toBe(SKILLS_POINTER);
  });

  it("leaves memory and the catalog uncut when no caps are given", async () => {
    const markdown = "abcdefghi\n".repeat(3000).trim();
    const context = await build({ memory: memoryOf(markdown) });

    expect(context.systemPrompts[1]).toBe(`[Bot Memory v1]\n${markdown}`);
  });

  it("keeps the system prompt order persona, system messages, memory, catalog, code mode", async () => {
    const context = await build({
      memory: memoryOf("remember", 2),
      skills: manySkills(1),
      messages: [
        {
          id: "m-1",
          botId: "bot-1",
          sessionId: "sess-1",
          ordinal: 1,
          role: "system",
          parts: [{ type: "text", text: "session rule" }],
          runId: "run-1",
          createdAt: "2026-06-01T10:00:01.000Z",
        },
      ],
      codeModeInstructions: "code mode text",
    });

    expect(context.systemPrompts.length).toBe(5);
    expect(context.systemPrompts[0]).toBe("Terse operator assistant.");
    expect(context.systemPrompts[1]).toBe("session rule");
    expect(context.systemPrompts[2]).toBe("[Bot Memory v2]\nremember");
    expect(context.systemPrompts[3]).toContain("skill-0");
    expect(context.systemPrompts[4]).toBe("code mode text");
    expect(context.contextBlock).toBe(`${context.systemPrompts[2]}\n\n${context.systemPrompts[3]}`);
  });
});

describe("hash the base and context parts of the system prompt", () => {
  it("gives the same two hashes for the same inputs and pins the algorithm to sha256 of the JSON parts", async () => {
    const input = {
      bot: { id: "bot-1", name: "Ops Bot", persona: "P" },
    };
    const first = await build(input);
    const second = await build(input);

    expect(first.baseHash).toBe("b73ac37eef017a4488487374f282993d8c3615ad1ea3e43298fc3a2b7251519f");
    expect(first.contextHash).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(second.baseHash).toBe(first.baseHash);
    expect(second.contextHash).toBe(first.contextHash);
  });

  it("changes the context hash only when memory is edited", async () => {
    const before = await build({ memory: memoryOf("one") });
    const after = await build({ memory: memoryOf("two") });

    expect(after.baseHash).toBe(before.baseHash);
    expect(after.contextHash).not.toBe(before.contextHash);
  });

  it("changes the base hash only when the persona is edited", async () => {
    const before = await build({ memory: memoryOf("one") });
    const after = await build({
      bot: { id: "bot-1", name: "Ops Bot", persona: "Verbose assistant." },
      memory: memoryOf("one"),
    });

    expect(after.contextHash).toBe(before.contextHash);
    expect(after.baseHash).not.toBe(before.baseHash);
  });

  it("changes the base hash when the code mode text changes", async () => {
    const before = await build({ codeModeInstructions: "a" });
    const after = await build({ codeModeInstructions: "b" });

    expect(after.baseHash).not.toBe(before.baseHash);
    expect(after.contextHash).toBe(before.contextHash);
  });

  it("hashes the capped context block so a cut memory hashes differently from a full one", async () => {
    const markdown = "abcdefghi\n".repeat(30).trim();
    const full = await build({ memory: memoryOf(markdown) });
    const capped = await build({ memory: memoryOf(markdown), caps: { memoryMaxBytes: 100 } });

    expect(capped.contextHash).not.toBe(full.contextHash);
  });
});
