import { describe, expect, it } from "bun:test";
import type { MemoryRecord, Message, Skill } from "@der/domain";
import { COMPACTION_RECORD_TYPE } from "@tanstack/ai-compaction";
import { buildRunContext, messagesToModelMessages } from "../../src/context/index";

function makeMessage(ordinal: number, role: Message["role"], text: string): Message {
  return {
    id: `msg-${ordinal}`,
    botId: "bot-1",
    sessionId: "sess-1",
    ordinal,
    role,
    parts: [{ type: "text", text }],
    runId: `run-${ordinal}`,
    createdAt: `2026-06-01T10:00:${String(ordinal).padStart(2, "0")}.000Z`,
  };
}

describe("Build future Run context with compaction while retaining source Messages", () => {
  it("compacts over-budget history for future context without mutating source Messages and emits a foldable compaction record", async () => {
    const sourceMessages: Message[] = [
      makeMessage(1, "user", "First historical request: " + "alpha ".repeat(120)),
      makeMessage(2, "assistant", "First historical answer: " + "beta ".repeat(120)),
      {
        id: "msg-3",
        botId: "bot-1",
        sessionId: "sess-1",
        ordinal: 3,
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "notes.search",
            outcome: { payload: "verbose-output ".repeat(180) },
            isError: false,
          },
        ],
        runId: "run-2",
        createdAt: "2026-06-01T10:00:03.000Z",
      },
      makeMessage(4, "user", "Second request: " + "gamma ".repeat(120)),
      makeMessage(5, "assistant", "Second answer: " + "delta ".repeat(120)),
      makeMessage(6, "user", "Latest question that must remain verbatim."),
    ];
    const snapshotBefore = structuredClone(sourceMessages);

    const memory: MemoryRecord = {
      id: "mem-1",
      botId: "bot-1",
      version: 3,
      markdown: "# Memory\n\nAlways reply in UTC.",
      updatedAt: "2026-06-01T09:00:00.000Z",
    };

    const skills: Skill[] = [
      {
        id: "deploy-check",
        name: "deploy-check",
        description: "Verify release checklist before rollout.",
        relativePath: "deploy-check/SKILL.md",
      },
    ];

    const firstContext = await buildRunContext({
      bot: { id: "bot-1", name: "Ops Bot", persona: "Terse operator assistant." },
      memory,
      skills,
      messages: sourceMessages,
      compaction: {
        maxTokens: 200,
        keepRecentTokens: 80,
        keepRecentToolResults: 0,
        threadId: "sess-1",
      },
    });

    expect(sourceMessages).toEqual(snapshotBefore);
    expect(firstContext.compacted).toBe(true);
    expect(firstContext.tokensAfter).toBeLessThan(firstContext.tokensBefore);
    expect(firstContext.tokensAfter).toBeLessThanOrEqual(200);
    expect(firstContext.sourceMessageCount).toBe(6);
    expect(firstContext.memoryVersion).toBe(3);
    expect(firstContext.skillIds).toEqual(["deploy-check"]);
    expect(firstContext.compactionRecord?.type).toBe(COMPACTION_RECORD_TYPE);

    const systemText = firstContext.systemPrompts.join("\n");
    expect(systemText).toContain("Terse operator assistant.");
    expect(systemText).toContain("Always reply in UTC.");
    expect(systemText).toContain("deploy-check");
    expect(systemText).not.toContain("/home/");

    const lastModelMsg = firstContext.messages[firstContext.messages.length - 1];
    expect(lastModelMsg?.role).toBe("user");
    expect(lastModelMsg?.content).toBe("Latest question that must remain verbatim.");

    const followUpMessages = [
      ...sourceMessages,
      makeMessage(7, "assistant", "Short reply."),
      makeMessage(8, "user", "Follow-up after compaction."),
    ];
    const nextContext = await buildRunContext({
      bot: { id: "bot-1", name: "Ops Bot", persona: "Terse operator assistant." },
      memory,
      skills,
      messages: followUpMessages,
      compaction: {
        maxTokens: 2000,
        priorRecords: firstContext.compactionRecord ? [firstContext.compactionRecord] : [],
        threadId: "sess-1",
      },
    });

    expect(nextContext.compacted).toBe(false);
    expect(nextContext.messages.length).toBeLessThan(followUpMessages.length);
    expect(nextContext.messages[nextContext.messages.length - 1]?.content).toBe(
      "Follow-up after compaction.",
    );
  });

  it("maps domain Message parts into ModelMessages without loss on under-budget conversations", async () => {
    const messages: Message[] = [
      makeMessage(1, "user", "Check lamp"),
      {
        id: "msg-2",
        botId: "bot-1",
        sessionId: "sess-1",
        ordinal: 2,
        role: "assistant",
        parts: [
          { type: "text", text: "Checking" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "home_assistant.get_state",
            arguments: { entityId: "light.desk" },
          },
        ],
        runId: "run-1",
        createdAt: "2026-06-01T10:00:02.000Z",
      },
      {
        id: "msg-3",
        botId: "bot-1",
        sessionId: "sess-1",
        ordinal: 3,
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "home_assistant.get_state",
            outcome: { state: "on" },
            isError: false,
          },
        ],
        runId: "run-1",
        createdAt: "2026-06-01T10:00:03.000Z",
      },
    ];

    const converted = messagesToModelMessages(messages);
    expect(converted).toHaveLength(3);
    expect(converted[1]?.toolCalls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "home_assistant.get_state",
          arguments: '{"entityId":"light.desk"}',
        },
      },
    ]);
    expect(converted[2]?.role).toBe("tool");
    expect(converted[2]?.toolCallId).toBe("call-1");
    expect(converted[2]?.content).toBe('{"state":"on"}');
  });
});
