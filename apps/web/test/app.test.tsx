import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vite-plus/test";
import { formatSseEvent, PROBLEM_DETAILS_MEDIA_TYPE, type Message } from "@der/domain";
import { App } from "@/App";

function parseJsonRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string" || init.body.length === 0) {
    return {};
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function createSseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function createFakeServerFetch(
  options: { readonly scriptRoutine?: boolean; readonly multipleApprovals?: boolean } = {},
) {
  const routineTarget = options.scriptRoutine
    ? {
        engine: "script",
        prompt: null,
        script: "return await step.run('notes.read', { key: 'a' });",
      }
    : { engine: "fixture", prompt: "direct: hourly ok", script: null };
  const admittedKeys: string[] = [];
  const approvalDecisions: Array<{ approvalId: string; body: Record<string, unknown> }> = [];
  const memoryWrites: Array<Record<string, unknown>> = [];
  const routinePatches: Array<Record<string, unknown>> = [];
  const botPatches: Array<Record<string, unknown>> = [];
  let botPolicy: Record<string, string> = {};

  let runPostCount = 0;
  let approvalStatus: "pending" | "approved" | "denied" = "pending";
  let memoryVersion = 1;
  let memoryMarkdown = "# Notes\nInitial memory.";
  let routineEnabled = true;
  let routineRevision = 1;

  const messages: Message[] = [
    {
      id: "msg-0",
      botId: "bot-fixture",
      sessionId: "sess-fixture",
      ordinal: 1,
      role: "assistant",
      parts: [{ type: "text", text: "Fixture session ready." }],
      runId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const fetcher: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, "http://127.0.0.1:5173");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);

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
          {
            engine: "codex",
            interactive: "login_required",
            unattended: "unverified",
            isolationVerified: false,
            reasons: ["Shadow home has no active login."],
            loginGuidance: "Run `codex login` inside der-home-codex.",
          },
        ],
      });
    }

    if (method === "GET" && url.pathname === "/api/capabilities") {
      return Response.json({
        capabilities: [
          {
            id: "fixture.apply",
            description: "Applies one deterministic fixture effect.",
            effect: "write",
            requiresApproval: true,
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
          {
            id: "catalog.search",
            description: "Find capabilities by query and return their declarations.",
            effect: "read",
            requiresApproval: false,
            inputSchema: { type: "string" },
            outputSchema: { type: "object" },
          },
        ],
      });
    }

    const fixtureBot = () => ({
      id: "bot-fixture",
      name: "Fixture Bot",
      persona: "Credential-free deterministic coworker.",
      defaultEngine: "fixture",
      allowedEngines: ["fixture", "codex"],
      capabilityPolicy: botPolicy,
      eventChainLimit: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    if (method === "GET" && url.pathname === "/api/bots") {
      return Response.json({ bots: [fixtureBot()] });
    }

    if (method === "PATCH" && url.pathname === "/api/bots/bot-fixture") {
      const body = parseJsonRequestBody(init);
      botPatches.push(body);
      botPolicy = body["capabilityPolicy"] as Record<string, string>;
      return Response.json(fixtureBot());
    }

    if (method === "GET" && url.pathname === "/api/bots/bot-fixture/sessions") {
      return Response.json({
        sessions: [
          {
            id: "sess-fixture",
            botId: "bot-fixture",
            title: "Fixture Session",
            engine: "fixture",
            pendingEventCount: runPostCount >= 2 ? 1 : 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }

    if (method === "GET" && url.pathname === "/api/sessions/sess-fixture/messages") {
      return Response.json({ messages });
    }

    if (method === "GET" && /^\/api\/sessions\/[^/]+\/runs$/.test(url.pathname)) {
      return Response.json({ runs: [] });
    }

    if (method === "POST" && url.pathname === "/api/sessions/sess-fixture/runs") {
      const key = headers.get("idempotency-key") ?? "";
      admittedKeys.push(key);
      runPostCount += 1;

      if (runPostCount === 1) {
        return new Response(
          JSON.stringify({
            type: "https://der.invalid/problems/restate-unavailable",
            title: "Restate ingress unavailable",
            status: 503,
            detail: "Restate ingress is temporarily unavailable.",
            instance: "/api/sessions/sess-fixture/runs",
            code: "restate.unavailable",
          }),
          {
            status: 503,
            headers: { "content-type": PROBLEM_DETAILS_MEDIA_TYPE },
          },
        );
      }

      messages.push({
        id: "msg-1",
        botId: "bot-fixture",
        sessionId: "sess-fixture",
        ordinal: 2,
        role: "user",
        parts: [{ type: "text", text: "lamp-1" }],
        runId: "run-1",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      return Response.json(
        {
          run: {
            id: "run-1",
            botId: "bot-fixture",
            sessionId: "sess-fixture",
            origin: "web",
            engine: "fixture",
            status: "waiting_approval",
            routineId: null,
            checkpoint: null,
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            finishedAt: null,
          },
          initialMessage: messages[1],
          isDuplicate: false,
          payloadFingerprint: "fp-1",
        },
        { status: 202 },
      );
    }

    if (method === "GET" && url.pathname === "/api/runs/run-1/events") {
      const lastEventId = headers.get("last-event-id");
      if (lastEventId === "5") {
        return new Response(null, { status: 204 });
      }
      return createSseResponse([
        formatSseEvent({
          id: 1,
          data: { type: "RUN_STARTED", runId: "run-1", threadId: "sess-fixture" },
        }),
        formatSseEvent({
          id: 2,
          data: { type: "TEXT_MESSAGE_START", messageId: "msg_stream_run-1", role: "assistant" },
        }),
        formatSseEvent({
          id: 3,
          data: {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "msg_stream_run-1",
            delta: "Requesting approval for lamp-1.",
          },
        }),
        formatSseEvent({
          id: 4,
          data: {
            type: "CUSTOM",
            name: "approval.requested",
            value: {
              approvalId: "apr-1",
              operationKind: "capability",
              operationId: "fixture.apply",
              prompt: "Approve fixture.apply for lamp-1?",
              deadline: "2026-01-01T00:05:00.000Z",
            },
          },
        }),
        formatSseEvent({
          id: 5,
          data: { type: "RUN_FINISHED", runId: "run-1", threadId: "sess-fixture" },
        }),
      ]);
    }

    if (method === "GET" && url.pathname === "/api/runs/run-1") {
      const approval = {
        id: "apr-1",
        botId: "bot-fixture",
        sessionId: "sess-fixture",
        runId: "run-1",
        effect: {
          runId: "run-1",
          operationKind: "capability",
          operationId: "fixture.apply",
          canonicalArguments: { target: "lamp-1", mode: "apply" },
          attemptId: "attempt-1",
        },
        prompt: "Approve fixture.apply for lamp-1?",
        awakeable: "awk-1",
        deadline: "2026-01-01T00:05:00.000Z",
        decision:
          approvalStatus === "pending"
            ? {
                status: "pending",
                awakeable: "awk-1",
                deadline: "2026-01-01T00:05:00.000Z",
              }
            : {
                status: approvalStatus,
                actor: "operator",
                decidedAt: "2026-01-01T00:00:03.000Z",
              },
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      };
      return Response.json({
        run: {
          id: "run-1",
          botId: "bot-fixture",
          sessionId: "sess-fixture",
          origin: "web",
          engine: "fixture",
          status: approvalStatus === "pending" ? "waiting_approval" : "completed",
          routineId: null,
          checkpoint: null,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
          finishedAt: approvalStatus === "pending" ? null : "2026-01-01T00:00:03.000Z",
        },
        approval,
        approvals:
          approvalStatus === "pending" && options.multipleApprovals
            ? [
                approval,
                {
                  ...approval,
                  id: "apr-2",
                  prompt: "Approve fixture.apply for lamp-2?",
                  effect: {
                    ...approval.effect,
                    canonicalArguments: { target: "lamp-2", mode: "apply" },
                    attemptId: "attempt-2",
                  },
                },
              ]
            : [],
      });
    }

    if (method === "POST" && url.pathname === "/api/approvals/apr-1/decision") {
      const body = parseJsonRequestBody(init);
      approvalDecisions.push({ approvalId: "apr-1", body });
      approvalStatus = body["status"] === "denied" ? "denied" : "approved";
      const actorName = typeof body["actor"] === "string" ? body["actor"] : "operator";
      return Response.json({
        approval: {
          id: "apr-1",
          botId: "bot-fixture",
          sessionId: "sess-fixture",
          runId: "run-1",
          effect: {
            runId: "run-1",
            operationKind: "capability",
            operationId: "fixture.apply",
            canonicalArguments: { target: "lamp-1", mode: "apply" },
            attemptId: "attempt-1",
          },
          prompt: "Approve fixture.apply for lamp-1?",
          awakeable: "awk-1",
          deadline: "2026-01-01T00:05:00.000Z",
          decision: {
            status: approvalStatus,
            actor: actorName,
            decidedAt: "2026-01-01T00:00:03.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        },
      });
    }

    if (method === "GET" && url.pathname === "/api/bots/bot-fixture/memory") {
      return Response.json({
        memory: {
          id: "mem-1",
          botId: "bot-fixture",
          version: memoryVersion,
          markdown: memoryMarkdown,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        versions: [{ version: memoryVersion, updatedAt: "2026-01-01T00:00:00.000Z" }],
      });
    }

    if (method === "PUT" && url.pathname === "/api/bots/bot-fixture/memory") {
      const body = parseJsonRequestBody(init);
      memoryWrites.push(body);
      memoryVersion += 1;
      memoryMarkdown = typeof body["markdown"] === "string" ? body["markdown"] : "";
      return Response.json({
        memory: {
          id: "mem-1",
          botId: "bot-fixture",
          version: memoryVersion,
          markdown: memoryMarkdown,
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      });
    }

    if (method === "GET" && url.pathname === "/api/skills") {
      return Response.json({
        skills: [
          {
            id: "home-audit",
            name: "home-audit",
            description: "Inspect home sensors safely.",
            relativePath: "home-audit/SKILL.md",
            license: "MIT",
          },
        ],
        rejected: [
          {
            relativePath: "broken/SKILL.md",
            reason: "SKILL.md is missing a YAML frontmatter block.",
          },
        ],
      });
    }

    if (method === "GET" && url.pathname === "/api/skills/home-audit") {
      return Response.json({
        skill: {
          id: "home-audit",
          name: "home-audit",
          description: "Inspect home sensors safely.",
          relativePath: "home-audit/SKILL.md",
          license: "MIT",
        },
        body: "# Home Audit\nRead sensor state before mutating.",
      });
    }

    if (method === "GET" && url.pathname === "/api/bots/bot-fixture/routines") {
      return Response.json({
        routines: [
          {
            id: "rt-1",
            botId: "bot-fixture",
            sessionId: "sess-fixture",
            name: "Hourly Check",
            cron: "0 * * * *",
            enabled: routineEnabled,
            revision: routineRevision,
            ...routineTarget,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }

    if (method === "GET" && url.pathname === "/api/routines/rt-1") {
      return Response.json({
        routine: {
          id: "rt-1",
          botId: "bot-fixture",
          sessionId: "sess-fixture",
          name: "Hourly Check",
          cron: "0 * * * *",
          enabled: routineEnabled,
          revision: routineRevision,
          ...routineTarget,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        slots: [
          {
            routineId: "rt-1",
            slot: "2026-01-01T01:00:00.000Z",
            revision: 1,
            disposition: "completed",
            runId: "run-0",
            recordedAt: "2026-01-01T01:00:02.000Z",
          },
        ],
      });
    }

    if (method === "PATCH" && url.pathname === "/api/routines/rt-1") {
      const body = parseJsonRequestBody(init);
      routinePatches.push(body);
      routineEnabled = Boolean(body["enabled"]);
      routineRevision += 1;
      return Response.json({
        routine: {
          id: "rt-1",
          botId: "bot-fixture",
          sessionId: "sess-fixture",
          name: "Hourly Check",
          cron: "0 * * * *",
          enabled: routineEnabled,
          revision: routineRevision,
          ...routineTarget,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
        },
        nextSlot: null,
      });
    }

    return new Response("Not found", { status: 404 });
  };

  return {
    fetcher,
    admittedKeys,
    approvalDecisions,
    memoryWrites,
    routinePatches,
    botPatches,
  };
}

function sessionOf(botId: string, id: string, title: string, pendingEventCount: number) {
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

type ListedSession = ReturnType<typeof sessionOf>;

/**
 * The fixture server with a second bot, "bot-other". `respond` answers each session listing by
 * bot and 1-based listing number; a listing it leaves `undefined` waits in `held` until the test
 * answers it, and rejects as fetch does once its request is aborted. Each answer settles its
 * `read` once the console has read the body. With `holdRunEvents`, run-1's stream stays open
 * after RUN_STARTED until `endRun`.
 */
function createSessionListsFetch(
  respond: (botId: string, listing: number) => ListedSession[] | undefined,
  options: { readonly holdRunEvents?: boolean; readonly ignoreAbort?: boolean } = {},
) {
  const server = createFakeServerFetch();
  const listings = new Map<string, number>();
  const held: {
    botId: string;
    listing: number;
    answer: (sessions: ListedSession[]) => Promise<void>;
  }[] = [];
  const reads: Promise<void>[] = [];
  let endRun = () => {};
  let runEventsOpened = false;
  const answered = (sessions: ListedSession[]) => {
    const response = Response.json({ sessions });
    const json = response.json.bind(response);
    let markRead = () => {};
    const read = new Promise<void>((resolve) => {
      markRead = resolve;
    });
    response.json = async () => {
      const body: unknown = await json();
      markRead();
      return body;
    };
    reads.push(read);
    return { response, read };
  };
  const fetcher: typeof fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, "http://127.0.0.1:5173");
    if (url.pathname === "/api/bots") {
      const { bots } = (await (await server.fetcher(input, init)).json()) as { bots: object[] };
      return Response.json({
        bots: [...bots, { ...bots[0], id: "bot-other", name: "Other Bot" }],
      });
    }
    const listed = /^\/api\/bots\/([^/]+)\/sessions$/.exec(url.pathname);
    if (listed && (init?.method ?? "GET") === "GET") {
      const botId = listed[1]!;
      const listing = (listings.get(botId) ?? 0) + 1;
      listings.set(botId, listing);
      const sessions = respond(botId, listing);
      if (sessions !== undefined) {
        return answered(sessions).response;
      }
      return new Promise<Response>((resolve, reject) => {
        if (!options.ignoreAbort) {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }
        held.push({
          botId,
          listing,
          answer: (next) => {
            const { response, read } = answered(next);
            resolve(response);
            return read;
          },
        });
      });
    }
    if (options.holdRunEvents && url.pathname === "/api/runs/run-1/events") {
      runEventsOpened = true;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              formatSseEvent({
                id: 1,
                data: { type: "RUN_STARTED", runId: "run-1", threadId: "sess-fixture" },
              }),
            ),
          );
          endRun = () => {
            try {
              controller.enqueue(
                encoder.encode(
                  formatSseEvent({
                    id: 2,
                    data: { type: "RUN_FINISHED", runId: "run-1", threadId: "sess-fixture" },
                  }),
                ),
              );
              controller.close();
            } catch {
              // The console already closed the stream.
            }
          };
          init?.signal?.addEventListener("abort", () => endRun());
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return server.fetcher(input, init);
  };
  return {
    fetcher,
    held,
    reads,
    endRun: () => endRun(),
    runEventsOpened: () => runEventsOpened,
  };
}

/** Waits until the console has read `read` and applied whatever it does with it. */
async function settled(read: Promise<unknown>) {
  await read;
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

function pendingEventCount(sessionTitle: string): number {
  const sidebar = screen.getByRole("complementary", { name: "Bots and sessions" });
  const heading = within(sidebar).getByRole("heading", { name: /^Sessions \(/ });
  const section = heading.closest("section");
  const button = section
    ? within(section)
        .queryAllByRole("button")
        .find((candidate) => candidate.textContent?.includes(sessionTitle))
    : undefined;
  const badge = button?.querySelector("[data-pending-events]");
  return badge ? Number(badge.getAttribute("data-pending-events")) : 0;
}

describe("keep the session list current", () => {
  it("shows the waiting badge after the pending count changes with no operator action", async () => {
    const server = createFakeServerFetch();
    let pending = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(rawUrl, "http://127.0.0.1:5173").pathname === "/api/bots/bot-fixture/sessions") {
        return Response.json({
          sessions: [sessionOf("bot-fixture", "sess-fixture", "Fixture Session", pending)],
        });
      }
      return server.fetcher(input, init);
    };
    render(<App fetcher={fetcher} sessionRefreshMs={20} />);

    await screen.findByText("Fixture session ready.");
    const before = pendingEventCount("Fixture Session");
    pending = 1;

    await waitFor(() => expect(pendingEventCount("Fixture Session")).toBe(1));
    expect(before).toBe(0);
  });

  it("drops a session list that arrives after its bot is no longer selected", async () => {
    const user = userEvent.setup();
    const server = createSessionListsFetch(
      (botId, listing) => {
        if (botId === "bot-other") {
          return listing === 1 ? [sessionOf(botId, "sess-other", "Other Session", 0)] : undefined;
        }
        return listing === 1 ? [sessionOf(botId, "sess-fixture", "Fixture Session", 0)] : undefined;
      },
      { ignoreAbort: true },
    );
    render(<App fetcher={server.fetcher} sessionRefreshMs={20} />);

    await screen.findAllByText("Fixture Session");
    await waitFor(() =>
      expect(server.held.some((entry) => entry.botId === "bot-fixture")).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: /^Other Bot/ }));
    await screen.findAllByText("Other Session");
    const fixtureHeld = server.held.filter((entry) => entry.botId === "bot-fixture");
    await Promise.all(
      fixtureHeld.map((entry) =>
        settled(entry.answer([sessionOf("bot-fixture", "sess-fixture", "Fixture Session", 1)])),
      ),
    );

    expect({
      fixture: screen.queryAllByText("Fixture Session").length,
      other: screen.queryAllByText("Other Session").length > 0,
    }).toEqual({ fixture: 0, other: true });
  });

  it("keeps refreshing the selected bot while a listing for the previous bot never answers", async () => {
    const user = userEvent.setup();
    let otherPending = 0;
    const server = createSessionListsFetch((botId, listing) => {
      if (botId === "bot-other") {
        return [sessionOf("bot-other", "sess-other", "Other Session", otherPending)];
      }
      return listing === 1 ? [sessionOf(botId, "sess-fixture", "Fixture Session", 0)] : undefined;
    });
    render(<App fetcher={server.fetcher} sessionRefreshMs={20} />);

    await screen.findAllByText("Fixture Session");
    await waitFor(() => expect(server.held.length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /^Other Bot/ }));
    await screen.findAllByText("Other Session");
    otherPending = 1;

    await waitFor(() => expect(pendingEventCount("Other Session")).toBe(1));
  });

  it("drops an older listing of the same bot that answers after a newer one", async () => {
    const user = userEvent.setup();
    const server = createSessionListsFetch(
      (botId, listing) => {
        if (botId !== "bot-fixture") {
          return [sessionOf(botId, "sess-other", "Other Session", 0)];
        }
        if (listing === 1) {
          return [sessionOf(botId, "sess-fixture", "Fixture Session", 0)];
        }
        if (listing === 3) {
          return [sessionOf(botId, "sess-fixture", "Fixture Session", 2)];
        }
        return undefined;
      },
      { ignoreAbort: true },
    );
    render(<App fetcher={server.fetcher} sessionRefreshMs={20} />);

    await screen.findAllByText("Fixture Session");
    await waitFor(() => expect(server.held.some((entry) => entry.listing === 2)).toBe(true));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(pendingEventCount("Fixture Session")).toBe(2));
    await settled(
      server.held
        .find((entry) => entry.listing === 2)!
        .answer([sessionOf("bot-fixture", "sess-fixture", "Fixture Session", 1)]),
    );

    expect(pendingEventCount("Fixture Session")).toBe(2);
  });

  it("drops the session list a previous bot's Run asks for after another bot is selected", async () => {
    const user = userEvent.setup();
    const server = createSessionListsFetch(
      (botId) =>
        botId === "bot-other"
          ? [sessionOf(botId, "sess-other", "Other Session", 0)]
          : [sessionOf(botId, "sess-fixture", "Fixture Session", 0)],
      { holdRunEvents: true },
    );
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");
    await user.type(screen.getByPlaceholderText("Send an instruction to Fixture Bot..."), "lamp-1");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Retry with same key" }));
    await waitFor(() => expect(server.runEventsOpened()).toBe(true));
    await user.click(screen.getByRole("button", { name: /^Other Bot/ }));
    await screen.findAllByText("Other Session");
    server.endRun();
    await settled(Promise.all(server.reads));

    expect({
      fixture: screen.queryAllByText("Fixture Session").length,
      other: screen.queryAllByText("Other Session").length > 0,
    }).toEqual({ fixture: 0, other: true });
  });
});

describe("operate der through the Web operator console", () => {
  it("renders the exact arguments for both pending Approvals of the active Run", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch({ multipleApprovals: true });
    render(<App fetcher={server.fetcher} />);

    await user.type(
      await screen.findByPlaceholderText("Send an instruction to Fixture Bot..."),
      "lamp-1",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Retry with same key" }));

    const first = await screen.findByText("Approve fixture.apply for lamp-1?");
    const second = await screen.findByText("Approve fixture.apply for lamp-2?");
    const firstArgs = JSON.parse(
      first.closest("[data-approval-id]")?.querySelector("pre")?.textContent ?? "null",
    );
    const secondArgs = JSON.parse(
      second.closest("[data-approval-id]")?.querySelector("pre")?.textContent ?? "null",
    );
    expect(firstArgs).toMatchObject({ target: "lamp-1" });
    expect(secondArgs).toMatchObject({ target: "lamp-2" });
    expect(screen.getAllByRole("button", { name: "Approve effect" })).toHaveLength(2);
  });

  it("retries failed run submission with the same Idempotency-Key, streams native chunks, and approves an exact effect", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch();
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");
    expect(screen.getByText("API healthy")).toBeTruthy();
    expect(screen.getByText("1/2 engines ready")).toBeTruthy();

    const promptInput = screen.getByPlaceholderText("Send an instruction to Fixture Bot...");
    await user.type(promptInput, "lamp-1");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const alert = await screen.findByRole("alert", { name: "Restate ingress unavailable" });
    expect(within(alert).getByText("Restate ingress unavailable")).toBeTruthy();
    expect(within(alert).getByText("restate.unavailable")).toBeTruthy();

    await user.click(within(alert).getByRole("button", { name: "Retry with same key" }));

    await waitFor(() => {
      expect(server.admittedKeys).toHaveLength(2);
    });
    expect(server.admittedKeys[0]).toBeTruthy();
    expect(server.admittedKeys[1]).toBe(server.admittedKeys[0]);

    await screen.findByText("Approve fixture.apply for lamp-1?");
    await user.click(screen.getByRole("button", { name: "Approve effect" }));

    await waitFor(() => {
      expect(server.approvalDecisions).toHaveLength(1);
    });
    expect(server.approvalDecisions[0]).toEqual({
      approvalId: "apr-1",
      body: {
        botId: "bot-fixture",
        sessionId: "sess-fixture",
        runId: "run-1",
        status: "approved",
        actor: "operator",
      },
    });
    expect(screen.getByRole("status", { name: "Operator status" }).textContent).toContain(
      "Recorded approved decision",
    );
  });

  it("shows the waiting badge once a Run of the selected bot changes the pending count", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch();
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");
    const before = pendingEventCount("Fixture Session");
    await user.type(screen.getByPlaceholderText("Send an instruction to Fixture Bot..."), "lamp-1");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Retry with same key" }));

    await waitFor(() => expect(pendingEventCount("Fixture Session")).toBe(1));
    expect(before).toBe(0);
  });

  it("saves a policy rule from the bot dialog and shows it again on reopen", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch();
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");
    await user.click(screen.getByRole("button", { name: "Edit bot Fixture Bot" }));
    await user.click(screen.getByRole("button", { name: "Add policy rule" }));
    await user.type(screen.getByLabelText("Policy selector 1"), "mcp.github");
    await user.click(screen.getByRole("combobox", { name: /Policy decision 1/ }));
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(server.botPatches).toHaveLength(1);
    });
    expect(server.botPatches[0]?.["capabilityPolicy"]).toEqual({ "mcp.github": "deny" });

    await user.click(await screen.findByRole("button", { name: "Edit bot Fixture Bot" }));
    expect((screen.getByLabelText("Policy selector 1") as HTMLInputElement).value).toBe(
      "mcp.github",
    );
    expect(screen.getByRole("combobox", { name: /Policy decision 1/ }).textContent).toContain(
      "deny",
    );
  });

  it("shows the Script of a script routine where a prompt routine shows its prompt", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch({ scriptRoutine: true });
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");
    await user.click(screen.getByRole("tab", { name: "Routines" }));

    await screen.findByText("return await step.run('notes.read', { key: 'a' });");
    expect(screen.getByText("Script")).toBeTruthy();
  });

  it("manages bot Memory, inspects Skills, toggles Routines, and shows engine Readiness diagnostics", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch();
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");

    await user.click(screen.getByRole("tab", { name: "Memory" }));
    const memoryEditor = await screen.findByLabelText("Bot memory Markdown");
    expect((memoryEditor as HTMLTextAreaElement).value).toBe("# Notes\nInitial memory.");
    await user.clear(memoryEditor);
    await user.type(memoryEditor, "# Updated memory");
    await user.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => {
      expect(server.memoryWrites).toEqual([{ markdown: "# Updated memory", expectedVersion: 1 }]);
    });

    await user.click(screen.getByRole("tab", { name: "Routines" }));
    await screen.findByText("2026-01-01T01:00:00.000Z");
    expect(screen.getAllByText("Hourly Check").length).toBeGreaterThanOrEqual(1);
    await user.click(screen.getByRole("switch", { name: "Toggle routine Hourly Check" }));
    await waitFor(() => {
      expect(server.routinePatches).toEqual([{ enabled: false, expectedRevision: 1 }]);
    });

    await user.click(screen.getByRole("tab", { name: "Readiness" }));
    await screen.findByText("Run `codex login` inside der-home-codex.");
    const fixtureGroup = screen.getByRole("region", { name: "fixture" });
    expect(within(fixtureGroup).getByText("fixture.apply")).toBeTruthy();
    expect(within(fixtureGroup).getByText("Approval required")).toBeTruthy();
    expect(within(fixtureGroup).getByText("write")).toBeTruthy();
    const catalogGroup = screen.getByRole("region", { name: "catalog" });
    expect(within(catalogGroup).getByText("catalog.search")).toBeTruthy();
    expect(within(catalogGroup).getByText("No approval")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Skills" }));
    await screen.findByText(/Read sensor state before mutating\./);
    expect(screen.getByText("broken/SKILL.md")).toBeTruthy();
  });

  it("renders execute and search call history in Astryx ChatToolCalls and creates sessions via Astryx Dialog", async () => {
    const user = userEvent.setup();
    const createdSessions: Array<Record<string, unknown>> = [];
    const base = createFakeServerFetch();

    const fetcher: typeof fetch = async (input, init) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, "http://127.0.0.1:5173");
      const method = init?.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/capabilities") {
        return Response.json({ capabilities: [] });
      }

      if (method === "GET" && url.pathname === "/api/sessions/sess-fixture/messages") {
        return Response.json({
          messages: [
            {
              id: "msg-tool",
              botId: "bot-fixture",
              sessionId: "sess-fixture",
              ordinal: 1,
              role: "assistant",
              parts: [
                {
                  type: "tool-call",
                  toolCallId: "tc-1",
                  toolName: "search",
                  arguments: { query: "append note" },
                },
                {
                  type: "tool-result",
                  toolCallId: "tc-1",
                  toolName: "search",
                  outcome: {
                    hits: [
                      {
                        id: "notes.append",
                        summary: "Append a line to a note.",
                        declaration: "declare function append(input: string): Promise<void>;",
                      },
                    ],
                    truncated: false,
                  },
                  isError: false,
                },
                {
                  type: "tool-call",
                  toolCallId: "tc-2",
                  toolName: "execute",
                  arguments: { script: 'return await step.run("notes.append", "buy milk");' },
                },
                {
                  type: "tool-result",
                  toolCallId: "tc-2",
                  toolName: "execute",
                  outcome: {
                    ok: false,
                    error: { kind: "denied", message: "Operator denied notes.append." },
                    logs: [],
                  },
                  isError: false,
                },
                { type: "text", text: "Checked container kernel." },
              ],
              runId: "run-0",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        });
      }

      if (method === "POST" && url.pathname === "/api/bots/bot-fixture/sessions") {
        const body = parseJsonRequestBody(init);
        createdSessions.push(body);
        return Response.json(
          {
            id: "sess-2",
            botId: "bot-fixture",
            title: String(body["title"] ?? "Untitled"),
            engine: "fixture",
            createdAt: "2026-01-01T00:05:00.000Z",
            updatedAt: "2026-01-01T00:05:00.000Z",
          },
          { status: 201 },
        );
      }

      if (method === "GET" && url.pathname === "/api/sessions/sess-2/messages") {
        return Response.json({ messages: [] });
      }

      return base.fetcher(input, init);
    };

    render(<App fetcher={fetcher} />);

    await screen.findByText("Checked container kernel.");
    for (const label of [/execute2$/, /search$/, /execute$/]) {
      const toggle = screen
        .getAllByRole("button", { expanded: false })
        .find((button) => label.test(button.textContent ?? ""));
      if (toggle === undefined) throw new Error(`no collapsed toggle matches ${label}`);
      await user.click(toggle);
    }
    expect(screen.getByText("append note")).toBeTruthy();
    expect(screen.getByText("notes.append")).toBeTruthy();
    expect(screen.getByText("execute")).toBeTruthy();
    expect(screen.getByText('return await step.run("notes.append", "buy milk");')).toBeTruthy();
    expect(screen.getAllByText("denied: Operator denied notes.append.").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "New session" }));
    const titleInput = await screen.findByLabelText(/^Title/);
    await user.type(titleInput, "Nightly audit");
    await user.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() => {
      expect(createdSessions).toEqual([{ title: "Nightly audit" }]);
    });
    await screen.findByText("No messages in this session");

    await user.click(screen.getByRole("tab", { name: "Readiness" }));
    await screen.findByText("No capabilities registered");
    expect(screen.getByText("Configure capability sources on the server.")).toBeTruthy();
  });
});
