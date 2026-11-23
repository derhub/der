import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { formatSseEvent, type Bot, type Session } from "@der/domain";
import { ChatWorkspace } from "@/components/chat-workspace";
import { createOperatorApi } from "@/lib/operator-api";

const bot: Bot = {
  id: "bot-1",
  name: "Usage Bot",
  persona: "Counts tokens.",
  defaultEngine: "fixture",
  allowedEngines: ["fixture"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const session: Session = {
  id: "sess-1",
  botId: "bot-1",
  title: "Usage Session",
  engine: "fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function runRecord(id: string, extra: Record<string, unknown>) {
  return {
    id,
    botId: "bot-1",
    sessionId: "sess-1",
    origin: "web",
    engine: "fixture",
    status: "completed",
    routineId: null,
    checkpoint: null,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    finishedAt: "2026-01-01T00:00:03.000Z",
    ...extra,
  };
}

function usage(inputTokens: number, extra: Record<string, unknown> = {}) {
  return {
    inputTokens,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    outputTokens: 7,
    reportedCostUsd: null,
    ...extra,
  };
}

function renderWithRuns(runs: readonly Record<string, unknown>[]) {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      "http://127.0.0.1:5173",
    );
    if (url.pathname === "/api/sessions/sess-1/messages") {
      return Response.json({ messages: [] });
    }
    if (url.pathname === "/api/sessions/sess-1/runs") {
      return Response.json({ runs });
    }
    return new Response("Not found", { status: 404 });
  };
  render(
    <ChatWorkspace
      api={createOperatorApi({ fetcher })}
      fetcher={fetcher}
      bot={bot}
      session={session}
      actor="operator"
      onAnnounce={() => {}}
    />,
  );
}

describe("show usage for a session's Runs", () => {
  it("per Run: renders four token counts and the context mode, dashes for null fields", async () => {
    renderWithRuns([
      runRecord("run-a", {
        usage: usage(1200, { cachedInputTokens: 800, outputTokens: 45 }),
        contextMode: "resumed",
      }),
    ]);

    expect(
      await screen.findByText(
        "run-a · input 1200 · cached 800 · cache write - · output 45 · resumed",
      ),
    ).toBeTruthy();
  });

  it("per Run: renders the reported cost as the vendor's running figure", async () => {
    renderWithRuns([
      runRecord("run-a", {
        usage: usage(10, { reportedCostUsd: 0.25 }),
        contextMode: "rebuilt",
      }),
    ]);

    expect(
      await screen.findByText(
        "run-a · input 10 · cached - · cache write - · output 7 · rebuilt · vendor running cost $0.25",
      ),
    ).toBeTruthy();
  });

  it("per Run: renders no usage line for a Run with usage null", async () => {
    renderWithRuns([
      runRecord("run-a", { usage: usage(5), contextMode: "rebuilt" }),
      runRecord("run-script", { usage: null, contextMode: null }),
    ]);

    await screen.findByText(/^run-a · input 5/);
    expect(screen.queryByText(/run-script/)).toBeNull();
  });

  it("totals: sums input tokens over the session's Runs and renders no cost total", async () => {
    renderWithRuns([
      runRecord("run-3", {
        usage: usage(300, { reportedCostUsd: 3 }),
        contextMode: "resumed",
      }),
      runRecord("run-2", {
        usage: usage(200, { reportedCostUsd: 2 }),
        contextMode: "resumed",
      }),
      runRecord("run-1", {
        usage: usage(100, { reportedCostUsd: 1 }),
        contextMode: "rebuilt",
      }),
    ]);

    expect(
      await screen.findByText("Session total · input 600 · cached - · cache write - · output 21"),
    ).toBeTruthy();
    expect(screen.queryByText(/total cost/i)).toBeNull();
  });
});

describe("show usage for a Run that just finished", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function finishRunWhileRunListsReturn(
    runListResponses: readonly (readonly Record<string, unknown>[])[],
  ): Promise<() => number> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let runListFetches = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://127.0.0.1:5173",
      );
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/sessions/sess-1/messages") {
        return Response.json({ messages: [] });
      }
      if (method === "GET" && url.pathname === "/api/sessions/sess-1/runs") {
        const runs = runListResponses[Math.min(runListFetches, runListResponses.length - 1)];
        runListFetches += 1;
        return Response.json({ runs });
      }
      if (method === "POST" && url.pathname === "/api/sessions/sess-1/runs") {
        return Response.json(
          {
            run: runRecord("run-1", { status: "running", finishedAt: null }),
            initialMessage: {
              id: "msg-1",
              botId: "bot-1",
              sessionId: "sess-1",
              ordinal: 1,
              role: "user",
              parts: [{ type: "text", text: "count" }],
              runId: "run-1",
              createdAt: "2026-01-01T00:00:01.000Z",
            },
            isDuplicate: false,
            payloadFingerprint: "fp-1",
          },
          { status: 202 },
        );
      }
      if (url.pathname === "/api/runs/run-1/events") {
        const body = [
          formatSseEvent({
            id: 1,
            data: { type: "RUN_STARTED", runId: "run-1", threadId: "sess-1" },
          }),
          formatSseEvent({
            id: 2,
            data: { type: "RUN_FINISHED", runId: "run-1", threadId: "sess-1" },
          }),
        ].join("");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/runs/run-1") {
        return Response.json({
          run: runRecord("run-1", { usage: null, contextMode: null }),
          approval: null,
        });
      }
      return new Response("Not found", { status: 404 });
    };
    render(
      <ChatWorkspace
        api={createOperatorApi({ fetcher })}
        fetcher={fetcher}
        bot={bot}
        session={session}
        actor="operator"
        onAnnounce={() => {}}
      />,
    );
    await waitFor(() => expect(runListFetches).toBe(1));

    const prompt = screen.getByPlaceholderText("Send an instruction to Usage Bot...");
    fireEvent.change(prompt, { target: { value: "count" } });
    fireEvent.keyDown(prompt, { key: "Enter" });
    await waitFor(() => expect(runListFetches).toBe(2));
    return () => runListFetches;
  }

  it("re-fetches the session's Runs when the watched Run settles before its usage is saved", async () => {
    const runListFetches = await finishRunWhileRunListsReturn([
      [],
      [runRecord("run-1", { usage: null, contextMode: null })],
      [runRecord("run-1", { usage: usage(42), contextMode: "resumed" })],
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    await waitFor(() => expect(runListFetches()).toBe(3));
    expect(
      await screen.findByText("run-1 · input 42 · cached - · cache write - · output 7 · resumed"),
    ).toBeTruthy();
  });

  it("re-fetches the session's Runs when the stream closes while the watched Run still reads running", async () => {
    const runListFetches = await finishRunWhileRunListsReturn([
      [],
      [runRecord("run-1", { status: "running", finishedAt: null, usage: null, contextMode: null })],
      [runRecord("run-1", { usage: usage(42), contextMode: "resumed" })],
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    await waitFor(() => expect(runListFetches()).toBe(3));
    expect(
      await screen.findByText("run-1 · input 42 · cached - · cache write - · output 7 · resumed"),
    ).toBeTruthy();
  });

  it("stops re-fetching after three more tries when the watched Run never shows usage", async () => {
    const runListFetches = await finishRunWhileRunListsReturn([
      [],
      [runRecord("run-1", { status: "running", finishedAt: null, usage: null, contextMode: null })],
    ]);
    for (const expected of [3, 4, 5]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await waitFor(() => expect(runListFetches()).toBe(expected));
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(runListFetches()).toBe(5);
  });
});

describe("show usage for a reloaded Run whose stream is resumed by hand", () => {
  it("re-fetches the session's Runs when the resumed stream settles", async () => {
    window.sessionStorage.setItem(
      "der:activeRun:sess-1",
      JSON.stringify({ runId: "run-1", cursor: 0 }),
    );
    const runLists = [[], [runRecord("run-1", { usage: usage(42), contextMode: "resumed" })]];
    let runListFetches = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://127.0.0.1:5173",
      );
      if (url.pathname === "/api/sessions/sess-1/messages") {
        return Response.json({ messages: [] });
      }
      if (url.pathname === "/api/sessions/sess-1/runs") {
        const runs = runLists[Math.min(runListFetches, runLists.length - 1)];
        runListFetches += 1;
        return Response.json({ runs });
      }
      if (url.pathname === "/api/runs/run-1/events") {
        return new Response(
          formatSseEvent({
            id: 1,
            data: { type: "RUN_FINISHED", runId: "run-1", threadId: "sess-1" },
          }),
          { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } },
        );
      }
      if (url.pathname === "/api/runs/run-1") {
        return Response.json({
          run: runRecord("run-1", { status: "running", finishedAt: null, usage: null }),
          approval: null,
        });
      }
      return new Response("Not found", { status: 404 });
    };
    render(
      <ChatWorkspace
        api={createOperatorApi({ fetcher })}
        fetcher={fetcher}
        bot={bot}
        session={session}
        actor="operator"
        onAnnounce={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Resume stream" }));

    expect(
      await screen.findByText("run-1 · input 42 · cached - · cache write - · output 7 · resumed"),
    ).toBeTruthy();
  });
});
