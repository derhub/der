import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { formatSseEvent } from "@der/domain";
import { App } from "@/App";

const REFRESH_MS = 5_000;

interface FakeSession {
  id: string;
  botId: string;
  title: string;
  engine: "fixture";
  pendingEventCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PendingReply {
  readonly id: number;
  readonly botId: string;
  readonly delayMs: number;
  readonly settled: boolean;
}

function makeBot(id: string, name: string) {
  return {
    id,
    name,
    persona: "Property test bot.",
    defaultEngine: "fixture",
    allowedEngines: ["fixture"],
    capabilityPolicy: {},
    eventChainLimit: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeSession(botId: string, id: string, title: string, pendingEventCount = 0): FakeSession {
  return {
    id,
    botId,
    title,
    engine: "fixture",
    pendingEventCount,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

interface ScheduledServerOptions {
  readonly listDelaysMs: readonly number[];
  readonly createDelayMs?: number;
  readonly runEndDelayMs?: number;
  readonly ignoreAbort?: boolean;
}

function createScheduledConsoleServer(options: ScheduledServerOptions) {
  const bots = [makeBot("bot-a", "Alpha Bot"), makeBot("bot-b", "Beta Bot")];
  const sessionsByBot = new Map<string, FakeSession[]>([
    ["bot-a", [makeSession("bot-a", "sess-a-0", "Alpha 0", 0)]],
    ["bot-b", [makeSession("bot-b", "sess-b-0", "Beta 0", 0)]],
  ]);

  let listCallIndex = 0;
  let nextSessionSeq = 1;
  let nextRunSeq = 1;
  let activeInFlightLists = 0;
  const completedRuns = new Map<string, { botId: string; sessionId: string; finished: boolean }>();
  const pendingReplies: PendingReply[] = [];

  const nextListDelay = () => {
    const idx = listCallIndex;
    listCallIndex += 1;
    if (options.listDelaysMs.length === 0) {
      return 10;
    }
    return options.listDelaysMs[idx % options.listDelaysMs.length] ?? 10;
  };

  function delayResponse(
    ms: number,
    signal: AbortSignal | null | undefined,
    build: () => Response,
  ): Promise<Response> {
    if (ms <= 0) {
      return Promise.resolve(build());
    }
    return new Promise<Response>((resolve, reject) => {
      if (!options.ignoreAbort && signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        if (!options.ignoreAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(build());
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (!options.ignoreAbort && signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function snapshotOf(botId: string): FakeSession[] {
    return (sessionsByBot.get(botId) ?? []).map((entry) => ({ ...entry }));
  }

  function bumpPending(botId: string, delta: number) {
    const list = sessionsByBot.get(botId);
    const target = list?.[0];
    if (!target) {
      return;
    }
    target.pendingEventCount = Math.max(0, target.pendingEventCount + delta);
  }

  function setPending(botId: string, sessionId: string, count: number) {
    const target = (sessionsByBot.get(botId) ?? []).find((entry) => entry.id === sessionId);
    if (target) {
      target.pendingEventCount = Math.max(0, count);
    }
  }

  const fetcher: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, "http://127.0.0.1:5173");
    const method = init?.method ?? "GET";

    if (method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok", timestamp: "2026-01-01T00:00:00.000Z" });
    }
    if (method === "GET" && url.pathname === "/api/engines") {
      return Response.json({
        engines: [
          {
            engine: "fixture",
            interactive: "ready",
            unattended: "ready",
            isolationVerified: true,
            reasons: [],
          },
        ],
      });
    }
    if (method === "GET" && url.pathname === "/api/capabilities") {
      return Response.json({ capabilities: [] });
    }
    if (method === "GET" && url.pathname === "/api/bots") {
      return Response.json({ bots });
    }

    const sessionsMatch = /^\/api\/bots\/([^/]+)\/sessions$/.exec(url.pathname);
    if (sessionsMatch && method === "GET") {
      const botId = decodeURIComponent(sessionsMatch[1]!);
      // Snapshot at request start time so a slow reply can predate later creates/updates.
      const snapshot = snapshotOf(botId);
      const delayMs = nextListDelay();
      const entry = {
        id: listCallIndex,
        botId,
        delayMs,
        settled: false,
      };
      pendingReplies.push(entry);
      activeInFlightLists += 1;
      try {
        return await delayResponse(delayMs, init?.signal, () =>
          Response.json({ sessions: snapshot }),
        );
      } finally {
        activeInFlightLists -= 1;
        entry.settled = true;
      }
    }

    if (sessionsMatch && method === "POST") {
      const botId = decodeURIComponent(sessionsMatch[1]!);
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { title?: string }) : {};
      const title = body.title ?? `Session ${nextSessionSeq}`;
      const delayMs = options.createDelayMs ?? 10;
      return delayResponse(delayMs, init?.signal, () => {
        const created = makeSession(botId, `sess-${botId}-${nextSessionSeq++}`, title, 0);
        const list = sessionsByBot.get(botId) ?? [];
        list.push(created);
        sessionsByBot.set(botId, list);
        return Response.json(created, { status: 201 });
      });
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (messagesMatch && method === "GET") {
      return Response.json({ messages: [] });
    }

    const runAdmitMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(url.pathname);
    if (runAdmitMatch && method === "POST") {
      const sessionId = decodeURIComponent(runAdmitMatch[1]!);
      let ownerBotId = "bot-a";
      for (const [botId, list] of sessionsByBot.entries()) {
        if (list.some((entry) => entry.id === sessionId)) {
          ownerBotId = botId;
          break;
        }
      }
      const runId = `run-${nextRunSeq++}`;
      completedRuns.set(runId, { botId: ownerBotId, sessionId, finished: false });
      bumpPending(ownerBotId, 1);
      return Response.json(
        {
          run: {
            id: runId,
            botId: ownerBotId,
            sessionId,
            origin: "web",
            engine: "fixture",
            status: "running",
            routineId: null,
            checkpoint: null,
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            finishedAt: null,
          },
          initialMessage: {
            id: `msg-${runId}`,
            botId: ownerBotId,
            sessionId,
            ordinal: 1,
            role: "user",
            parts: [{ type: "text", text: "ping" }],
            runId,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          isDuplicate: false,
          payloadFingerprint: `fp-${runId}`,
        },
        { status: 202 },
      );
    }

    const runEventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (runEventsMatch && method === "GET") {
      const runId = decodeURIComponent(runEventsMatch[1]!);
      const info = completedRuns.get(runId);
      const encoder = new TextEncoder();
      const endDelay = options.runEndDelayMs ?? 150;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({
                id: 1,
                data: { type: "RUN_STARTED", runId, threadId: info?.sessionId ?? "sess-a-0" },
              }),
            ),
          );
          const finish = () => {
            if (info && !info.finished) {
              info.finished = true;
              bumpPending(info.botId, 1);
            }
            try {
              controller.enqueue(
                encoder.encode(
                  formatSseEvent({
                    id: 2,
                    data: { type: "RUN_FINISHED", runId, threadId: info?.sessionId ?? "sess-a-0" },
                  }),
                ),
              );
              controller.close();
            } catch {
              // Stream already closed.
            }
          };
          const timer = setTimeout(finish, endDelay);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              try {
                controller.close();
              } catch {
                // Stream already closed.
              }
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }

    const runDetailMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (runDetailMatch && method === "GET") {
      const runId = decodeURIComponent(runDetailMatch[1]!);
      const info = completedRuns.get(runId);
      return Response.json({
        run: {
          id: runId,
          botId: info?.botId ?? "bot-a",
          sessionId: info?.sessionId ?? "sess-a-0",
          origin: "web",
          engine: "fixture",
          status: info?.finished ? "completed" : "running",
          routineId: null,
          checkpoint: null,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
          finishedAt: info?.finished ? "2026-01-01T00:00:02.000Z" : null,
        },
        approval: null,
        approvals: [],
      });
    }

    return new Response("Not found", { status: 404 });
  };

  return {
    fetcher,
    snapshotOf,
    bumpPending,
    setPending,
    inFlightLists: () => activeInFlightLists,
    listCalls: () => listCallIndex,
  };
}

function parseSessionButton(button: Element): { title: string; waiting: number } {
  const children = Array.from(button.children);
  const title = children[0]?.textContent?.trim() ?? "";
  const badge = button.querySelector("[data-pending-events]");
  const waiting = badge ? Number(badge.getAttribute("data-pending-events")) : 0;
  return { title, waiting };
}

function readShownSessions(): Array<{ title: string; waiting: number }> {
  const sidebar = screen.getByRole("complementary", { name: "Bots and sessions" });
  const heading = within(sidebar).getByRole("heading", { name: /^Sessions \(/ });
  const section = heading.closest("section");
  if (!section) {
    return [];
  }
  const buttons = within(section)
    .queryAllByRole("button")
    .filter((button) => button.textContent?.trim() !== "New session");
  return buttons.map(parseSessionButton);
}

function readSelectedSessionTitle(): string | null {
  const sidebar = screen.getByRole("complementary", { name: "Bots and sessions" });
  const heading = within(sidebar).getByRole("heading", { name: /^Sessions \(/ });
  const section = heading.closest("section");
  if (!section) {
    return null;
  }
  const current = section.querySelector<HTMLButtonElement>('button[aria-current="true"]');
  if (!current) {
    return null;
  }
  return parseSessionButton(current).title;
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number) {
  await flushMicrotasks();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flushMicrotasks();
}

async function switchBot(botName: "Alpha Bot" | "Beta Bot") {
  const button = screen.getByRole("button", { name: new RegExp(`^${botName}`) });
  await act(async () => {
    fireEvent.click(button);
  });
}

async function createSessionViaDialog(title: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
  });
  const input = screen.getByLabelText(/^Title/);
  await act(async () => {
    fireEvent.change(input, { target: { value: title } });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  });
}

async function startRunIfWorkspaceReady(botName: "Alpha Bot" | "Beta Bot") {
  const textarea = screen.queryByPlaceholderText(`Send an instruction to ${botName}...`);
  if (!textarea) {
    return false;
  }
  const sendButton = screen.queryByRole("button", { name: "Send" }) as HTMLButtonElement | null;
  if (!sendButton) {
    return false;
  }
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "ping" } });
  });
  if (sendButton.disabled) {
    return false;
  }
  await act(async () => {
    fireEvent.click(sendButton);
  });
  return true;
}

type Op =
  | { readonly type: "switch"; readonly botId: "bot-a" | "bot-b" }
  | { readonly type: "create"; readonly label: string }
  | { readonly type: "pending"; readonly botId: "bot-a" | "bot-b"; readonly delta: number }
  | { readonly type: "run" }
  | { readonly type: "tick"; readonly ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom<"bot-a" | "bot-b">("bot-a", "bot-b").map((botId) => ({
      type: "switch" as const,
      botId,
    })),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 1, max: 999 }).map((n) => ({
      type: "create" as const,
      label: `Created ${n}`,
    })),
  },
  {
    weight: 3,
    arbitrary: fc
      .record({
        botId: fc.constantFrom<"bot-a" | "bot-b">("bot-a", "bot-b"),
        delta: fc.integer({ min: 1, max: 3 }),
      })
      .map(({ botId, delta }) => ({ type: "pending" as const, botId, delta })),
  },
  {
    weight: 2,
    arbitrary: fc.constant({ type: "run" as const }),
  },
  {
    weight: 4,
    arbitrary: fc.integer({ min: 500, max: 6_500 }).map((ms) => ({
      type: "tick" as const,
      ms,
    })),
  },
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("console session server-state invariants", () => {
  it("preserves a newly created session when a pre-create list snapshot arrives next", async () => {
    vi.useFakeTimers();
    const server = createScheduledConsoleServer({
      listDelaysMs: [40, 2_000, 40],
      createDelayMs: 20,
    });
    render(<App fetcher={server.fetcher} sessionRefreshMs={REFRESH_MS} />);
    await advance(100);
    expect(readShownSessions()).toEqual([{ title: "Alpha 0", waiting: 0 }]);

    // Trigger the 5 s poll so a pre-create list request is in flight for 2 s.
    await advance(REFRESH_MS);
    expect(server.inFlightLists()).toBe(1);

    // Create a session while the pre-create list request is still in flight.
    await createSessionViaDialog("Fresh Session");
    await advance(50);
    expect(readShownSessions().map((s) => s.title)).toContain("Fresh Session");

    // Let the pre-create list snapshot arrive.
    await advance(2_100);
    expect(readShownSessions().map((s) => s.title)).toEqual(["Alpha 0", "Fresh Session"]);
    expect(readSelectedSessionTitle()).toBe("Fresh Session");
  });

  it("keeps refreshing and selects the initial session when every list reply takes longer than 5 s", async () => {
    vi.useFakeTimers();
    const server = createScheduledConsoleServer({
      listDelaysMs: [6_000],
    });
    render(<App fetcher={server.fetcher} sessionRefreshMs={REFRESH_MS} />);

    // First load takes 6 s (> 5 s refresh interval).
    await advance(5_100);
    await advance(1_500);

    expect(readShownSessions()).toEqual([{ title: "Alpha 0", waiting: 0 }]);
    expect(readSelectedSessionTitle()).toBe("Alpha 0");
    expect(screen.getByPlaceholderText("Send an instruction to Alpha Bot...")).toBeTruthy();

    // Background pending count changes while subsequent replies also take 6 s.
    server.setPending("bot-a", "sess-a-0", 3);
    await advance(REFRESH_MS);
    await advance(6_500);

    expect(readShownSessions()).toEqual([{ title: "Alpha 0", waiting: 3 }]);
  });

  it("pauses interval polling while the tab is hidden and resumes when visible", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "visibilityState",
    );
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    try {
      const server = createScheduledConsoleServer({ listDelaysMs: [20] });
      render(<App fetcher={server.fetcher} sessionRefreshMs={REFRESH_MS} />);
      await advance(50);
      const callsBeforeHide = server.listCalls();

      visibility = "hidden";
      window.dispatchEvent(new Event("visibilitychange"));
      await advance(REFRESH_MS * 3);
      expect(server.listCalls()).toBe(callsBeforeHide);

      visibility = "visible";
      window.dispatchEvent(new Event("visibilitychange"));
      await advance(REFRESH_MS + 50);
      expect(server.listCalls()).toBeGreaterThan(callsBeforeHide);
    } finally {
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        delete (document as unknown as Record<string, unknown>)["visibilityState"];
      }
    }
  });

  it("keeps refreshing when every reply is slower than the interval under random schedules", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 5_200, max: 8_500 }), { minLength: 2, maxLength: 4 }),
        fc.integer({ min: 1, max: 5 }),
        async (slowDelaysMs, targetPending) => {
          vi.useFakeTimers();
          try {
            const maxDelay = Math.max(...slowDelaysMs);
            const server = createScheduledConsoleServer({ listDelaysMs: slowDelaysMs });
            render(<App fetcher={server.fetcher} sessionRefreshMs={REFRESH_MS} />);

            await advance(maxDelay + 500);
            expect(readShownSessions()).toEqual([{ title: "Alpha 0", waiting: 0 }]);
            expect(readSelectedSessionTitle()).toBe("Alpha 0");

            server.setPending("bot-a", "sess-a-0", targetPending);
            await advance(REFRESH_MS + maxDelay + 500);
            expect(readShownSessions()).toEqual([{ title: "Alpha 0", waiting: targetPending }]);
          } finally {
            cleanup();
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 10, seed: 20261126 },
    );
  });

  it("converges to server state for the selected bot without losing created sessions under random delays and operator actions", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 50, max: 7_000 }), { minLength: 3, maxLength: 8 }),
        fc.array(opArb, { minLength: 3, maxLength: 10 }),
        fc.boolean(),
        async (listDelaysMs, ops, ignoreAbort) => {
          vi.useFakeTimers();
          try {
            const maxDelay = Math.max(...listDelaysMs, 100);
            const server = createScheduledConsoleServer({
              listDelaysMs,
              createDelayMs: 25,
              runEndDelayMs: 200,
              ignoreAbort,
            });
            render(<App fetcher={server.fetcher} sessionRefreshMs={REFRESH_MS} />);
            await advance(1);

            let selectedBotId: "bot-a" | "bot-b" = "bot-a";
            const createdByBot = new Map<"bot-a" | "bot-b", Set<string>>([
              ["bot-a", new Set()],
              ["bot-b", new Set()],
            ]);
            let createCounter = 0;

            for (const op of ops) {
              if (op.type === "switch") {
                selectedBotId = op.botId;
                await switchBot(op.botId === "bot-a" ? "Alpha Bot" : "Beta Bot");
                await flushMicrotasks();
              } else if (op.type === "create") {
                const title = `${op.label}-${++createCounter}`;
                await createSessionViaDialog(title);
                await advance(50);
                createdByBot.get(selectedBotId)!.add(title);
                const titlesNow = readShownSessions().map((s) => s.title);
                expect(titlesNow).toContain(title);
              } else if (op.type === "pending") {
                server.bumpPending(op.botId, op.delta);
              } else if (op.type === "run") {
                await startRunIfWorkspaceReady(
                  selectedBotId === "bot-a" ? "Alpha Bot" : "Beta Bot",
                );
                await flushMicrotasks();
              } else if (op.type === "tick") {
                await advance(op.ms);
              }

              // Created sessions for the currently selected bot must never vanish once created.
              const shownTitles = new Set(readShownSessions().map((s) => s.title));
              for (const title of createdByBot.get(selectedBotId)!) {
                expect(shownTitles.has(title)).toBe(true);
              }
            }

            // Let all in-flight requests and at least one fresh poll cycle complete.
            const settleStep = maxDelay + REFRESH_MS + 500;
            await advance(settleStep);
            await advance(settleStep);

            const expected = server.snapshotOf(selectedBotId).map((s) => ({
              title: s.title,
              waiting: s.pendingEventCount,
            }));
            expect(readShownSessions()).toEqual(expected);
            expect(readSelectedSessionTitle()).not.toBeNull();
          } finally {
            cleanup();
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 25, seed: 20261125 },
    );
  });
});
