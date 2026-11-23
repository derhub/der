import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { formatSseEvent, type Bot, type Session } from "@der/domain";
import { ChatWorkspace } from "@/components/chat-workspace";
import { createOperatorApi } from "@/lib/operator-api";

const bot: Bot = {
  id: "bot-1",
  name: "Reset Bot",
  persona: "Retries.",
  defaultEngine: "fixture",
  allowedEngines: ["fixture"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const session: Session = {
  id: "sess-1",
  botId: "bot-1",
  title: "Reset Session",
  engine: "fixture",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const runningRun = {
  id: "run-1",
  botId: "bot-1",
  sessionId: "sess-1",
  origin: "web",
  engine: "fixture",
  status: "running",
  routineId: null,
  checkpoint: null,
  createdAt: "2026-01-01T00:00:01.000Z",
  updatedAt: "2026-01-01T00:00:02.000Z",
  finishedAt: null,
  usage: null,
  contextMode: null,
};

const messageId = "msg_stream_run-1";

/** Run events of an engine step that was abandoned mid-reply and retried; the stream stays open. */
function openRunEvents(signal: AbortSignal | null | undefined): Response {
  const frames = [
    { type: "RUN_STARTED", runId: "run-1", threadId: "sess-1" },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "PARTIAL" },
    { type: "CUSTOM", name: "der.attempt-reset" },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "answer 3" },
  ].map((data, index) => formatSseEvent({ id: index + 1, data }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join("")));
      signal?.addEventListener("abort", () => controller.close());
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

describe("stream a Run whose engine step restarted", () => {
  it("renders only the new attempt's reply after an attempt reset", async () => {
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
        return Response.json({ runs: [] });
      }
      if (method === "POST" && url.pathname === "/api/sessions/sess-1/runs") {
        return Response.json(
          {
            run: runningRun,
            initialMessage: {
              id: "msg-1",
              botId: "bot-1",
              sessionId: "sess-1",
              ordinal: 1,
              role: "user",
              parts: [{ type: "text", text: "third question" }],
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
        return openRunEvents(init?.signal);
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

    const prompt = screen.getByPlaceholderText("Send an instruction to Reset Bot...");
    fireEvent.change(prompt, { target: { value: "third question" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    expect(await screen.findByText("answer 3")).toBeTruthy();
    expect(screen.queryByText(/PARTIAL/)).toBeNull();
  });
});
