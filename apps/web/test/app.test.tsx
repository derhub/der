import { render, screen, waitFor, within } from "@testing-library/react";
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

function createFakeServerFetch(options: { readonly scriptRoutine?: boolean } = {}) {
  const routineTarget = options.scriptRoutine
    ? { engine: "script", prompt: null, script: "return await der.notes.read({ key: 'a' });" }
    : { engine: "fixture", prompt: "direct: hourly ok", script: null };
  const admittedKeys: string[] = [];
  const approvalDecisions: Array<{ approvalId: string; body: Record<string, unknown> }> = [];
  const memoryWrites: Array<Record<string, unknown>> = [];
  const routinePatches: Array<Record<string, unknown>> = [];

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

    if (method === "GET" && url.pathname === "/api/bots") {
      return Response.json({
        bots: [
          {
            id: "bot-fixture",
            name: "Fixture Bot",
            persona: "Credential-free deterministic coworker.",
            defaultEngine: "fixture",
            allowedEngines: ["fixture", "codex"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }

    if (method === "GET" && url.pathname === "/api/bots/bot-fixture/sessions") {
      return Response.json({
        sessions: [
          {
            id: "sess-fixture",
            botId: "bot-fixture",
            title: "Fixture Session",
            engine: "fixture",
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
        },
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
  };
}

describe("operate der through the Web operator console", () => {
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

  it("shows the Script of a script routine where a prompt routine shows its prompt", async () => {
    const user = userEvent.setup();
    const server = createFakeServerFetch({ scriptRoutine: true });
    render(<App fetcher={server.fetcher} />);

    await screen.findByText("Fixture session ready.");
    await user.click(screen.getByRole("tab", { name: "Routines" }));

    await screen.findByText("return await der.notes.read({ key: 'a' });");
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
                  arguments: { script: 'return await der.notes.append("buy milk");' },
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
    expect(screen.getByText('return await der.notes.append("buy milk");')).toBeTruthy();
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
