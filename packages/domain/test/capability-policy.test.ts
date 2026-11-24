import { describe, expect, it } from "vite-plus/test";
import { createBotInput, resolvePolicy, type CapabilityPolicy } from "@der/domain";

describe("resolve a capability policy", () => {
  it.each<{
    name: string;
    policy: CapabilityPolicy;
    id: string;
    effect: "read" | "write";
    declaredAsks: boolean;
    expected: "allow" | "ask" | "deny";
  }>([
    {
      name: "falls back to allow when nothing matches and the declaration does not ask",
      policy: { "mcp.git": "deny" },
      id: "notes.append",
      effect: "write",
      declaredAsks: false,
      expected: "allow",
    },
    {
      name: "falls back to ask when nothing matches and the declaration asks",
      policy: {},
      id: "notes.publish",
      effect: "write",
      declaredAsks: true,
      expected: "ask",
    },
    {
      name: "lets an exact id beat its namespace",
      policy: { notes: "deny", "notes.append": "allow" },
      id: "notes.append",
      effect: "write",
      declaredAsks: false,
      expected: "allow",
    },
    {
      name: "lets a longer namespace beat a shorter one",
      policy: { mcp: "deny", "mcp.github": "allow" },
      id: "mcp.github.addComment",
      effect: "write",
      declaredAsks: true,
      expected: "allow",
    },
    {
      name: "matches a namespace on a dot boundary",
      policy: { "mcp.github": "deny" },
      id: "mcp.github.addComment",
      effect: "write",
      declaredAsks: false,
      expected: "deny",
    },
    {
      name: "does not match mcp.git against mcp.github.addComment",
      policy: { "mcp.git": "deny" },
      id: "mcp.github.addComment",
      effect: "write",
      declaredAsks: false,
      expected: "allow",
    },
    {
      name: "overrides a declaration that asks with allow",
      policy: { "notes.publish": "allow" },
      id: "notes.publish",
      effect: "write",
      declaredAsks: true,
      expected: "allow",
    },
    {
      name: "resolves ask on a read to allow",
      policy: { notes: "ask" },
      id: "notes.read",
      effect: "read",
      declaredAsks: false,
      expected: "allow",
    },
    {
      name: "keeps deny on a read",
      policy: { notes: "deny" },
      id: "notes.read",
      effect: "read",
      declaredAsks: false,
      expected: "deny",
    },
    {
      name: "ignores inherited object keys",
      policy: {},
      id: "constructor.name",
      effect: "write",
      declaredAsks: false,
      expected: "allow",
    },
  ])("$name", ({ policy, id, effect, declaredAsks, expected }) => {
    expect(resolvePolicy(policy, id, effect, declaredAsks)).toBe(expected);
  });
});

describe("validate a bot policy", () => {
  const base = { name: "Bot", defaultEngine: "fixture", allowedEngines: ["fixture"] } as const;

  it("defaults to an empty policy and a chain limit of 3", () => {
    expect(createBotInput.parse(base)).toEqual({
      ...base,
      persona: "",
      capabilityPolicy: {},
      eventChainLimit: 3,
    });
  });

  it.each([
    { name: "a key with a space", capabilityPolicy: { "notes append": "allow" } },
    { name: "a key with an empty segment", capabilityPolicy: { "notes.": "allow" } },
    { name: "an unknown decision", capabilityPolicy: { notes: "maybe" } },
  ])("rejects $name", ({ capabilityPolicy }) => {
    expect(createBotInput.safeParse({ ...base, capabilityPolicy }).success).toBe(false);
  });
});
