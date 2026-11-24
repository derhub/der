import { describe, expect, it } from "bun:test";
import type { EngineSession, Message, MessagePart } from "@der/domain";
import {
  baseHashWithModel,
  composeResumeText,
  planTurn,
  type TurnPlan,
} from "@der/runtime/context";

const STORED: EngineSession = {
  sessionId: "sess-1",
  engine: "claude-code",
  vendorSessionId: "vendor-1",
  baseHash: "base-a",
  contextHash: "ctx-a",
  lastOrdinal: 4,
  pendingRunId: null,
  updatedAt: "2026-11-23T10:00:00.000Z",
};

function userText(ordinal: number, text: string): Message {
  return message(ordinal, "user", [{ type: "text", text }]);
}

function message(ordinal: number, role: Message["role"], parts: MessagePart[]): Message {
  return {
    id: `msg-${ordinal}`,
    botId: "bot-1",
    sessionId: "sess-1",
    ordinal,
    role,
    parts,
    runId: null,
    createdAt: "2026-11-23T10:00:00.000Z",
  };
}

function plan(overrides: Partial<Parameters<typeof planTurn>[0]> = {}): TurnPlan {
  return planTurn({
    engineResumable: true,
    stored: STORED,
    runId: "run-2",
    baseHash: "base-a",
    contextHash: "ctx-a",
    contextBlock: "[Bot Memory v2]\nlikes tea",
    messagesAfterLastOrdinal: [userText(5, "next question")],
    ...overrides,
  });
}

describe("decide whether a Run resumes the vendor session or rebuilds", () => {
  it("resumes without a context note when base and context are unchanged", () => {
    expect(plan()).toEqual({ mode: "resume", vendorSessionId: "vendor-1", contextNote: null });
  });

  it("resumes with a context note when memory or skills changed", () => {
    expect(plan({ contextHash: "ctx-b" })).toEqual({
      mode: "resume",
      vendorSessionId: "vendor-1",
      contextNote:
        "[Context update: memory and skills changed since your last turn]\n[Bot Memory v2]\nlikes tea",
    });
  });

  it("resumes with an emptied-context note when memory and skills were removed", () => {
    expect(plan({ contextHash: "ctx-b", contextBlock: "" })).toEqual({
      mode: "resume",
      vendorSessionId: "vendor-1",
      contextNote: "[Context update: memory and skills are now empty]",
    });
  });

  it("resumes when the pending mark belongs to an earlier Run", () => {
    expect(plan({ stored: { ...STORED, pendingRunId: "run-1" } })).toEqual({
      mode: "resume",
      vendorSessionId: "vendor-1",
      contextNote: null,
    });
  });

  it.each<{ name: string; input: Partial<Parameters<typeof planTurn>[0]>; plan: TurnPlan }>([
    {
      name: "the engine cannot resume",
      input: { engineResumable: false },
      plan: { mode: "rebuild", reason: "not-resumable" },
    },
    {
      name: "the session has no stored vendor session for this engine",
      input: { stored: null },
      plan: { mode: "rebuild", reason: "none" },
    },
    {
      name: "the stored row was marked pending by this very Run",
      input: { stored: { ...STORED, pendingRunId: "run-2" } },
      plan: { mode: "rebuild", reason: "replayed" },
    },
    {
      name: "the persona, system messages, code-mode text or model changed",
      input: { baseHash: "base-b" },
      plan: { mode: "rebuild", reason: "base-changed" },
    },
    {
      name: "an assistant message from another engine sits after the last ordinal",
      input: {
        messagesAfterLastOrdinal: [
          message(5, "assistant", [{ type: "text", text: "from codex" }]),
          userText(6, "next question"),
        ],
      },
      plan: { mode: "rebuild", reason: "gap" },
    },
    {
      name: "a new user message carries a non-text part",
      input: {
        messagesAfterLastOrdinal: [
          message(5, "user", [
            { type: "text", text: "see attachment" },
            { type: "data", mimeType: "image/png", data: "AAAA" },
          ]),
        ],
      },
      plan: { mode: "rebuild", reason: "gap" },
    },
    {
      name: "a system message was added after the last ordinal",
      input: {
        messagesAfterLastOrdinal: [
          message(5, "system", [{ type: "text", text: "be brief" }]),
          userText(6, "next question"),
        ],
      },
      plan: { mode: "rebuild", reason: "gap" },
    },
    {
      name: "no message follows the last ordinal",
      input: { messagesAfterLastOrdinal: [] },
      plan: { mode: "rebuild", reason: "gap" },
    },
  ])("rebuilds when $name", ({ input, plan: expected }) => {
    expect(plan(input)).toEqual(expected);
  });

  it("reports not-resumable ahead of none when the engine cannot resume and has no row", () => {
    expect(plan({ engineResumable: false, stored: null })).toEqual({
      mode: "rebuild",
      reason: "not-resumable",
    });
  });
});

describe("compose the one user message of a resumed turn", () => {
  it("joins several new user messages in order", () => {
    expect(composeResumeText(null, [userText(5, "first"), userText(6, "second")])).toBe(
      "first\n\nsecond",
    );
  });

  it("puts the context note before the new user text", () => {
    expect(composeResumeText("[note]", [userText(5, "first")])).toBe("[note]\n\nfirst");
  });
});

describe("fold the engine model into the base hash", () => {
  it("keeps a base hash stable for one model and changes it for another", () => {
    expect([
      baseHashWithModel("base-a", "claude-sonnet-4-5") ===
        baseHashWithModel("base-a", "claude-sonnet-4-5"),
      baseHashWithModel("base-a", "claude-sonnet-4-5") ===
        baseHashWithModel("base-a", "claude-opus-4-5"),
      baseHashWithModel("base-a", "claude-sonnet-4-5") ===
        baseHashWithModel("base-b", "claude-sonnet-4-5"),
    ]).toEqual([true, false, false]);
  });
});
