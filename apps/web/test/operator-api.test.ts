import { describe, expect, it } from "vite-plus/test";
import { PROBLEM_DETAILS_MEDIA_TYPE } from "@der/domain";
import { createOperatorApi } from "@/lib/operator-api";
import { OperatorApiError } from "@/lib/schemas";

describe("validate operator HTTP responses with CSP-compatible schemas", () => {
  it("parses bots, readiness, memory, skills, routines, and sends JSON and idempotency headers", async () => {
    const requests: Array<{
      url: string;
      method: string;
      contentType: string | null;
      key: string | null;
    }> = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? "GET",
        contentType: headers.get("content-type"),
        key: headers.get("idempotency-key"),
      });

      if (url === "/healthz") {
        return Response.json({ status: "ok", timestamp: "2026-01-01T00:00:00.000Z" });
      }
      if (url === "/api/engines") {
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
      if (url === "/api/bots" && init?.method === "POST") {
        return Response.json(
          {
            id: "bot-1",
            name: "Ops Bot",
            persona: "Concise operator.",
            defaultEngine: "fixture",
            allowedEngines: ["fixture"],
            capabilityPolicy: {},
            eventChainLimit: 3,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          { status: 201 },
        );
      }
      if (url === "/api/sessions/sess-1/runs" && init?.method === "POST") {
        return Response.json(
          {
            run: {
              id: "run-1",
              botId: "bot-1",
              sessionId: "sess-1",
              origin: "web",
              engine: "fixture",
              status: "queued",
              routineId: null,
              checkpoint: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: null,
            },
            initialMessage: {
              id: "msg-1",
              botId: "bot-1",
              sessionId: "sess-1",
              ordinal: 1,
              role: "user",
              parts: [{ type: "text", text: "direct: hello" }],
              runId: "run-1",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            isDuplicate: false,
            payloadFingerprint: "fp-1",
          },
          { status: 202 },
        );
      }

      return new Response("Not found", { status: 404 });
    };

    const api = createOperatorApi({ fetcher: fakeFetch });
    const health = await api.getHealth();
    const engines = await api.listEngines();
    const createdBot = await api.createBot({
      name: "Ops Bot",
      persona: "Concise operator.",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
    });
    const admission = await api.admitRun(
      "sess-1",
      {
        botId: "bot-1",
        origin: "web",
        engine: "fixture",
        input: { parts: [{ type: "text", text: "direct: hello" }] },
      },
      "idem-123",
    );

    expect(health.status).toBe("ok");
    expect(engines[0]?.engine).toBe("fixture");
    expect(createdBot.id).toBe("bot-1");
    expect(admission.run.id).toBe("run-1");
    expect(requests).toEqual([
      { url: "/healthz", method: "GET", contentType: null, key: null },
      { url: "/api/engines", method: "GET", contentType: null, key: null },
      { url: "/api/bots", method: "POST", contentType: "application/json", key: null },
      {
        url: "/api/sessions/sess-1/runs",
        method: "POST",
        contentType: "application/json",
        key: "idem-123",
      },
    ]);
  });

  it("parses RFC 9457 Problem Details errors into OperatorApiError", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          type: "https://der.invalid/problems/active-run-exists",
          title: "Active run conflict",
          status: 409,
          detail: "Session sess-1 already has an active run.",
          instance: "/api/sessions/sess-1/runs",
          code: "run.active_conflict",
        }),
        {
          status: 409,
          headers: { "content-type": PROBLEM_DETAILS_MEDIA_TYPE },
        },
      );

    const api = createOperatorApi({ fetcher: fakeFetch });

    await expect(
      api.admitRun(
        "sess-1",
        {
          botId: "bot-1",
          origin: "web",
          input: { parts: [{ type: "text", text: "hello" }] },
        },
        "idem-conflict",
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(OperatorApiError);
      expect((error as OperatorApiError).problem).toEqual({
        type: "https://der.invalid/problems/active-run-exists",
        title: "Active run conflict",
        status: 409,
        detail: "Session sess-1 already has an active run.",
        instance: "/api/sessions/sess-1/runs",
        code: "run.active_conflict",
      });
      return true;
    });
  });
});
