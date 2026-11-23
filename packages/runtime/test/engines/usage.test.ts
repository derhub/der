import { describe, expect, it } from "bun:test";
import type { EngineEvent, Run } from "@der/domain";
import { bridgeAdapterStream } from "@der/runtime/engines";
import type { StreamChunk } from "@tanstack/ai";

const run = { id: "run-usage", sessionId: "sess-usage" } as Run;

async function finish(finished: Record<string, unknown>): Promise<EngineEvent | undefined> {
  const chunks = [
    { type: "RUN_STARTED", threadId: "sess-usage", runId: "run-usage" },
    { type: "RUN_FINISHED", threadId: "sess-usage", runId: "run-usage", ...finished },
  ] as unknown as StreamChunk[];
  const events: EngineEvent[] = [];
  for await (const event of bridgeAdapterStream({
    run,
    stream: (async function* () {
      yield* chunks;
    })(),
    abortController: new AbortController(),
    sessionIdEventName: "session.id",
  })) {
    events.push(event);
  }
  return events.find((event) => event.type === "completed");
}

describe("map the usage a vendor reports on RUN_FINISHED", () => {
  it.each([
    {
      vendor: "Claude Code reports cache read, cache write and cost",
      usage: {
        promptTokens: 1050,
        completionTokens: 40,
        totalTokens: 1090,
        promptTokensDetails: { cachedTokens: 900, cacheWriteTokens: 50 },
        cost: 0.0123,
        providerUsageDetails: { totalCostUsd: 0.0123 },
      },
      expected: {
        inputTokens: 1050,
        cachedInputTokens: 900,
        cacheWriteTokens: 50,
        outputTokens: 40,
        reportedCostUsd: 0.0123,
      },
    },
    {
      vendor: "Codex reports cache read only and no cost",
      usage: {
        promptTokens: 2000,
        completionTokens: 150,
        totalTokens: 2150,
        promptTokensDetails: { cachedTokens: 1500 },
        completionTokensDetails: { reasoningTokens: 30 },
      },
      expected: {
        inputTokens: 2000,
        cachedInputTokens: 1500,
        cacheWriteTokens: null,
        outputTokens: 150,
        reportedCostUsd: null,
      },
    },
    {
      vendor: "ACP reports cache read and write but session cost stays out of usage.cost",
      usage: {
        promptTokens: 800,
        completionTokens: 60,
        totalTokens: 860,
        promptTokensDetails: { cachedTokens: 300, cacheWriteTokens: 20 },
        providerUsageDetails: { sessionCost: { amount: 0.5, currency: "USD" } },
      },
      expected: {
        inputTokens: 800,
        cachedInputTokens: 300,
        cacheWriteTokens: 20,
        outputTokens: 60,
        reportedCostUsd: null,
      },
    },
    {
      vendor: "an adapter reports token counts and no details",
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
      expected: {
        inputTokens: 5,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        outputTokens: 6,
        reportedCostUsd: null,
      },
    },
  ])("$vendor", async ({ usage, expected }) => {
    expect(await finish({ usage })).toEqual({ type: "completed", usage: expected });
  });

  it("completes without usage when RUN_FINISHED carries none", async () => {
    expect(await finish({})).toEqual({ type: "completed" });
  });
});
