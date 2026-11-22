import type { Bot, MemoryRecord, Message, MessagePart, Skill } from "@der/domain";
import type { ModelMessage, ToolCall } from "@tanstack/ai";
import {
  clearToolResults,
  COMPACTION_RECORD_TYPE,
  composeStrategies,
  estimateMessageTokens,
  evictOldest,
  projectCompaction,
  type CompactionContext,
  type CompactionRecord,
  type CompactionStrategy,
} from "@tanstack/ai-compaction";
import { renderCatalog, type ModelFamily, type SkillMetadata } from "@tanstack/ai-skills";

export interface RunContextBot {
  readonly id: Bot["id"];
  readonly name: Bot["name"];
  readonly persona: Bot["persona"];
}

export interface RunContextCompactionOptions {
  readonly maxTokens: number;
  readonly keepRecentTokens?: number;
  readonly keepRecentToolResults?: number;
  readonly strategy?: CompactionStrategy;
  readonly priorRecords?: readonly CompactionRecord[];
  readonly threadId?: string;
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface BuildRunContextInput {
  readonly bot: RunContextBot;
  readonly memory?: MemoryRecord;
  readonly skills?: readonly Skill[];
  readonly modelFamily?: ModelFamily;
  readonly messages: readonly Message[];
  readonly compaction: RunContextCompactionOptions;
}

export interface BuiltRunContext {
  readonly systemPrompts: readonly string[];
  readonly messages: readonly ModelMessage[];
  readonly compacted: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly compactionRecord: CompactionRecord | undefined;
  readonly sourceMessageCount: number;
  readonly memoryVersion: number | undefined;
  readonly skillIds: readonly string[];
}

function formatPartText(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "data":
      return JSON.stringify({ mimeType: part.mimeType, data: part.data });
    case "tool-result":
      return JSON.stringify(part.outcome);
    case "tool-call":
      return "";
  }
}

export function messagesToModelMessages(messages: readonly Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      continue;
    }

    if (msg.role === "tool") {
      const toolResultParts = msg.parts.filter((part) => part.type === "tool-result");
      if (toolResultParts.length > 0) {
        for (const part of toolResultParts) {
          result.push({
            id: msg.id,
            role: "tool",
            toolCallId: part.toolCallId,
            name: part.toolName,
            content: JSON.stringify(part.outcome),
            ...(part.isError ? { error: "tool_error" } : {}),
          });
        }
      } else {
        const text = msg.parts.map(formatPartText).filter(Boolean).join("\n");
        result.push({
          id: msg.id,
          role: "tool",
          content: text,
        });
      }
      continue;
    }

    const textSegments: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of msg.parts) {
      if (part.type === "tool-call") {
        toolCalls.push({
          id: part.toolCallId,
          type: "function",
          function: {
            name: part.toolName,
            arguments: JSON.stringify(part.arguments),
          },
        });
      } else {
        const rendered = formatPartText(part);
        if (rendered.length > 0) {
          textSegments.push(rendered);
        }
      }
    }

    const content = textSegments.join("\n");
    if (msg.role === "assistant") {
      result.push({
        id: msg.id,
        role: "assistant",
        content: content.length > 0 || toolCalls.length === 0 ? content : null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
    } else {
      result.push({
        id: msg.id,
        role: "user",
        content,
      });
    }
  }

  return result;
}

function estimateListTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

function messagesEqual(a: ModelMessage, b: ModelMessage): boolean {
  if (a.id !== undefined && b.id !== undefined) {
    return a.id === b.id && a.role === b.role && a.content === b.content;
  }
  return (
    a.role === b.role &&
    a.toolCallId === b.toolCallId &&
    a.name === b.name &&
    JSON.stringify(a.content) === JSON.stringify(b.content) &&
    JSON.stringify(a.toolCalls ?? null) === JSON.stringify(b.toolCalls ?? null)
  );
}

function createCompactionRecord(input: {
  readonly reason: "threshold" | "forced";
  readonly before: readonly ModelMessage[];
  readonly after: readonly ModelMessage[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}): CompactionRecord {
  let matchedSuffix = 0;
  while (
    matchedSuffix < input.before.length &&
    matchedSuffix < input.after.length &&
    messagesEqual(
      input.before[input.before.length - 1 - matchedSuffix]!,
      input.after[input.after.length - 1 - matchedSuffix]!,
    )
  ) {
    matchedSuffix += 1;
  }

  const from = input.before.length - matchedSuffix;
  const head = input.after.slice(0, input.after.length - matchedSuffix);
  const firstKept = input.before[from];

  return {
    type: COMPACTION_RECORD_TYPE,
    reason: input.reason,
    tokensBefore: input.tokensBefore,
    tokensAfter: input.tokensAfter,
    head: [...head],
    from,
    ...(firstKept?.id !== undefined ? { firstKeptId: firstKept.id } : {}),
  };
}

function toSkillMetadata(skill: Skill): SkillMetadata {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.license !== undefined ? { license: skill.license } : {}),
    ...(skill.compatibility !== undefined ? { compatibility: skill.compatibility } : {}),
    ...(skill.metadata !== undefined ? { metadata: skill.metadata } : {}),
    ...(skill.allowedTools !== undefined ? { allowedTools: [...skill.allowedTools] } : {}),
  };
}

export function renderSafeSkillCatalog(
  skills: readonly Skill[],
  family: ModelFamily = "other",
): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }
  return renderCatalog(skills.map(toSkillMetadata), family);
}

export async function buildRunContext(input: BuildRunContextInput): Promise<BuiltRunContext> {
  const systemPrompts: string[] = [];

  if (input.bot.persona.trim().length > 0) {
    systemPrompts.push(input.bot.persona.trim());
  }

  for (const msg of input.messages) {
    if (msg.role !== "system") {
      continue;
    }
    const text = msg.parts.map(formatPartText).filter(Boolean).join("\n").trim();
    if (text.length > 0) {
      systemPrompts.push(text);
    }
  }

  if (input.memory && input.memory.markdown.trim().length > 0) {
    systemPrompts.push(`[Bot Memory v${input.memory.version}]\n${input.memory.markdown.trim()}`);
  }

  const skills = input.skills ?? [];
  const renderedSkills = renderSafeSkillCatalog(skills, input.modelFamily ?? "other");
  if (renderedSkills && renderedSkills.trim().length > 0) {
    systemPrompts.push(renderedSkills.trim());
  }

  let currentMessages: ModelMessage[] = messagesToModelMessages(input.messages);

  for (const record of input.compaction.priorRecords ?? []) {
    const projected = projectCompaction({
      messages: currentMessages,
      record,
    });
    if (projected) {
      currentMessages = projected;
    }
  }

  const tokensBefore = estimateListTokens(currentMessages);
  const shouldCompact =
    input.compaction.force === true || tokensBefore > input.compaction.maxTokens;

  if (!shouldCompact) {
    return {
      systemPrompts,
      messages: currentMessages,
      compacted: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      compactionRecord: undefined,
      sourceMessageCount: input.messages.length,
      memoryVersion: input.memory?.version,
      skillIds: skills.map((entry) => entry.id),
    };
  }

  const strategy: CompactionStrategy =
    input.compaction.strategy ??
    composeStrategies(
      clearToolResults({
        keepRecentToolResults: input.compaction.keepRecentToolResults ?? 2,
      }),
      evictOldest({
        keepRecentTokens:
          input.compaction.keepRecentTokens ?? Math.floor(input.compaction.maxTokens / 2),
      }),
    );

  const ctx: CompactionContext = {
    maxTokens: input.compaction.maxTokens,
    estimate: estimateMessageTokens,
    addUsage: () => {},
    threadId: input.compaction.threadId ?? input.bot.id,
    ...(input.compaction.signal !== undefined ? { signal: input.compaction.signal } : {}),
  };

  const compactedMessages = await strategy(currentMessages, ctx);
  if (!compactedMessages) {
    return {
      systemPrompts,
      messages: currentMessages,
      compacted: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      compactionRecord: undefined,
      sourceMessageCount: input.messages.length,
      memoryVersion: input.memory?.version,
      skillIds: skills.map((entry) => entry.id),
    };
  }

  const tokensAfter = estimateListTokens(compactedMessages);
  const record = createCompactionRecord({
    reason: input.compaction.force === true ? "forced" : "threshold",
    before: currentMessages,
    after: compactedMessages,
    tokensBefore,
    tokensAfter,
  });

  return {
    systemPrompts,
    messages: compactedMessages,
    compacted: true,
    tokensBefore,
    tokensAfter,
    compactionRecord: record,
    sourceMessageCount: input.messages.length,
    memoryVersion: input.memory?.version,
    skillIds: skills.map((entry) => entry.id),
  };
}
