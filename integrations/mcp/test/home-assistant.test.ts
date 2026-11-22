import { afterEach, describe, expect, it } from "bun:test";
import type { EffectIdentity } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import {
  createExactApprovalVerifier,
  createHomeAssistantTools,
  ToolEffectUncertainError,
} from "../src/index";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.stop(true);
    }
  }
});

describe("Home Assistant tools adapter with credential isolation, allowlists, and uncertain write errors", () => {
  it("lists typed descriptors without exposing tokens, reads allowed entities, and enforces exact approval and service allowlists", async () => {
    const token = "ha-super-secret-token-abc";
    const serviceCalls: Array<{ path: string; body: unknown; auth: string | null }> = [];
    let nextServiceStatus = 200;

    const fakeHa = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${token}`) {
          return new Response(`Unauthorized token ${token}`, { status: 401 });
        }
        if (req.method === "GET" && url.pathname === "/api/states/light.desk") {
          return Response.json({
            entity_id: "light.desk",
            state: "on",
            attributes: { brightness: 180 },
          });
        }
        if (req.method === "GET" && url.pathname === "/api/states") {
          return Response.json([
            { entity_id: "light.desk", state: "on" },
            { entity_id: "lock.front_door", state: "locked" },
          ]);
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/services/")) {
          const body = await req.json();
          serviceCalls.push({ path: url.pathname, body, auth });
          if (nextServiceStatus === 503) {
            return new Response(`Upstream timeout for ${token}`, { status: 503 });
          }
          if (nextServiceStatus === 400) {
            return new Response(`Invalid service payload for ${token}`, { status: 400 });
          }
          return Response.json([{ entity_id: "light.desk", state: "off" }]);
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    servers.push(fakeHa);

    const approvedWrite: EffectIdentity = {
      runId: "run-ha-1",
      operationKind: "home-assistant",
      operationId: "home_assistant.call_service",
      canonicalArguments: {
        domain: "light",
        service: "turn_off",
        entityId: "light.desk",
      },
      attemptId: "attempt-ha-1",
    };
    const uncertainWrite: EffectIdentity = {
      runId: "run-ha-2",
      operationKind: "home-assistant",
      operationId: "home_assistant.call_service",
      canonicalArguments: {
        domain: "light",
        service: "turn_off",
        entityId: "light.desk",
      },
      attemptId: "attempt-ha-2",
    };
    const rejectedWrite: EffectIdentity = {
      runId: "run-ha-3",
      operationKind: "home-assistant",
      operationId: "home_assistant.call_service",
      canonicalArguments: {
        domain: "light",
        service: "turn_off",
        entityId: "light.desk",
      },
      attemptId: "attempt-ha-3",
    };

    const ha = createHomeAssistantTools({
      baseUrl: `http://127.0.0.1:${fakeHa.port}`,
      token,
      allowedServices: ["light.turn_on", "light.turn_off"],
      allowedEntities: ["light.desk"],
      verifyApproval: createExactApprovalVerifier([approvedWrite, uncertainWrite, rejectedWrite]),
    });

    const descriptors = await ha.list();
    expect(descriptors.map((d) => ({ id: d.id, requiresApproval: d.requiresApproval }))).toEqual([
      { id: "home_assistant.get_state", requiresApproval: false },
      { id: "home_assistant.list_states", requiresApproval: false },
      { id: "home_assistant.call_service", requiresApproval: true },
    ]);
    for (const descriptor of descriptors) {
      expect(compiledParsers.toolDescriptor.safeParse(descriptor).success).toBe(true);
      expect(JSON.stringify(descriptor)).not.toContain(token);
    }

    const readState = await ha.invoke({
      effect: {
        runId: "run-ha-1",
        operationKind: "home-assistant",
        operationId: "home_assistant.get_state",
        canonicalArguments: { entityId: "light.desk" },
        attemptId: "read-1",
      },
    });
    expect(compiledParsers.toolResult.parse(readState)).toEqual({
      ok: true,
      isError: false,
      outcome: { entity_id: "light.desk", state: "on", attributes: { brightness: 180 } },
    });

    const listed = await ha.invoke({
      effect: {
        runId: "run-ha-1",
        operationKind: "home-assistant",
        operationId: "home_assistant.list_states",
        canonicalArguments: {},
        attemptId: "read-2",
      },
    });
    expect(listed.ok).toBe(true);
    expect(listed.outcome).toEqual([{ entity_id: "light.desk", state: "on" }]);

    const deniedService = await ha.invoke({
      effect: {
        runId: "run-ha-1",
        operationKind: "home-assistant",
        operationId: "home_assistant.call_service",
        canonicalArguments: { domain: "lock", service: "unlock", entityId: "lock.front_door" },
        attemptId: "attempt-denied-service",
      },
    });
    expect(deniedService.ok).toBe(false);
    expect(deniedService.outcome).toEqual({
      denied: true,
      code: "tool.unrecognized_operation",
    });
    expect(serviceCalls).toHaveLength(0);

    const unapproved = await ha.invoke({
      effect: {
        ...approvedWrite,
        attemptId: "attempt-different",
      },
    });
    expect(unapproved.ok).toBe(false);
    expect(unapproved.outcome).toEqual({
      denied: true,
      code: "tool.approval_required",
    });
    expect(serviceCalls).toHaveLength(0);

    const writeResult = await ha.invoke({ effect: approvedWrite });
    expect(compiledParsers.toolResult.parse(writeResult)).toEqual({
      ok: true,
      isError: false,
      outcome: {
        domain: "light",
        service: "turn_off",
        changedStates: [{ entity_id: "light.desk", state: "off" }],
      },
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]?.path).toBe("/api/services/light/turn_off");

    nextServiceStatus = 400;
    const badReq = await ha.invoke({ effect: rejectedWrite });
    expect(badReq.ok).toBe(false);
    expect(badReq.isError).toBe(true);
    expect(badReq.detail).not.toContain(token);

    nextServiceStatus = 503;
    let uncertainErr: unknown;
    try {
      await ha.invoke({ effect: uncertainWrite });
    } catch (error) {
      uncertainErr = error;
    }
    expect(uncertainErr).toBeInstanceOf(ToolEffectUncertainError);
    expect((uncertainErr as ToolEffectUncertainError).code).toBe("effect.outcome_uncertain");
    expect((uncertainErr as ToolEffectUncertainError).message).not.toContain(token);
  });
});
