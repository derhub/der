import { describe, expect, it } from "bun:test";
import type { EffectIdentity } from "@der/domain";
import type { AcpPermissionRequest } from "@tanstack/ai-acp";
import type { ProvisionedBridge, ToolBridgeProvisionOptions } from "@tanstack/ai-sandbox";
import {
  createApprovalBridge,
  createDurableApprovalBridgeProvisioner,
  type ApprovalBroker,
  type ApprovalDecisionOutcome,
} from "@der/runtime/engines";

function sampleAcpPermissionRequest(
  overrides?: Partial<AcpPermissionRequest>,
): AcpPermissionRequest {
  return {
    sessionId: "acp-sess-1",
    toolCall: {
      toolCallId: "tc-1",
      title: "Run shell command",
      kind: "execute",
      rawInput: { b: 2, a: 1 },
    },
    options: [
      { optionId: "opt-always", name: "Allow Always", kind: "allow_always" },
      { optionId: "opt-once", name: "Allow Once", kind: "allow_once" },
      { optionId: "opt-reject", name: "Reject Once", kind: "reject_once" },
    ],
    ...overrides,
  };
}

describe("bridge live ACP permission callbacks to durable exact-operation approvals", () => {
  it("selects allow_once (never allow_always) for an approved exact operation and canonicalizes arguments", async () => {
    const requested: Array<{ readonly effect: EffectIdentity; readonly prompt: string }> = [];
    const broker: ApprovalBroker = {
      async requestApproval(input) {
        requested.push({ effect: input.effect, prompt: input.prompt });
        return {
          status: "approved",
          approvalId: "apr-1",
          effect: input.effect,
        };
      },
    };

    const bridge = createApprovalBridge({
      runId: "run-acp-1",
      engine: "antigravity",
      callbackContinuity: "verified",
      broker,
    });

    const outcome = await bridge.mediateAcpPermission(sampleAcpPermissionRequest());

    expect(outcome).toEqual({ outcome: "selected", optionId: "opt-once" });
    expect(requested).toHaveLength(1);
    expect(requested[0]?.effect.runId).toBe("run-acp-1");
    expect(requested[0]?.effect.operationKind).toBe("engine-permission");
    expect(requested[0]?.effect.operationId).toBe("antigravity:execute:Run shell command");
    expect(requested[0]?.effect.canonicalArguments).toEqual({ a: 1, b: 2 });
    expect(JSON.stringify(requested[0]?.effect.canonicalArguments)).toBe('{"a":1,"b":2}');
  });

  it("selects reject_once on denial and cancelled on expiry or missing allow_once option", async () => {
    const deniedBridge = createApprovalBridge({
      runId: "run-acp-2",
      engine: "antigravity",
      callbackContinuity: "verified",
      broker: {
        async requestApproval(input) {
          return { status: "denied", approvalId: "apr-2", effect: input.effect };
        },
      },
    });
    expect(await deniedBridge.mediateAcpPermission(sampleAcpPermissionRequest())).toEqual({
      outcome: "selected",
      optionId: "opt-reject",
    });

    const expiredBridge = createApprovalBridge({
      runId: "run-acp-3",
      engine: "antigravity",
      callbackContinuity: "verified",
      broker: {
        async requestApproval(input) {
          return { status: "expired", approvalId: "apr-3", effect: input.effect };
        },
      },
    });
    expect(await expiredBridge.mediateAcpPermission(sampleAcpPermissionRequest())).toEqual({
      outcome: "cancelled",
    });

    const onlyAlwaysBridge = createApprovalBridge({
      runId: "run-acp-4",
      engine: "antigravity",
      callbackContinuity: "verified",
      broker: {
        async requestApproval(input) {
          return { status: "approved", approvalId: "apr-4", effect: input.effect };
        },
      },
    });
    expect(
      await onlyAlwaysBridge.mediateAcpPermission(
        sampleAcpPermissionRequest({
          options: [{ optionId: "opt-always", name: "Allow Always", kind: "allow_always" }],
        }),
      ),
    ).toEqual({ outcome: "cancelled" });
  });

  it("fails closed when callback continuity is unverified and discards stale decisions after transport loss", async () => {
    let brokerCalls = 0;
    const unverifiedBridge = createApprovalBridge({
      runId: "run-unverified",
      engine: "antigravity",
      callbackContinuity: "unverified",
      broker: {
        async requestApproval(input) {
          brokerCalls += 1;
          return { status: "approved", approvalId: "apr-never", effect: input.effect };
        },
      },
    });

    expect(await unverifiedBridge.mediateAcpPermission(sampleAcpPermissionRequest())).toEqual({
      outcome: "cancelled",
    });
    expect(brokerCalls).toBe(0);

    let resolveDecision: ((decision: ApprovalDecisionOutcome) => void) | undefined;
    let notifyBrokerCalled: (() => void) | undefined;
    const brokerCalled = new Promise<void>((resolve) => {
      notifyBrokerCalled = resolve;
    });
    let capturedEffect: EffectIdentity | undefined;
    const lostBridge = createApprovalBridge({
      runId: "run-lost",
      engine: "antigravity",
      callbackContinuity: "verified",
      broker: {
        requestApproval(input) {
          capturedEffect = input.effect;
          notifyBrokerCalled?.();
          return new Promise<ApprovalDecisionOutcome>((resolve) => {
            resolveDecision = resolve;
          });
        },
      },
    });

    const pendingOutcome = lostBridge.mediateAcpPermission(sampleAcpPermissionRequest());
    await brokerCalled;
    lostBridge.markTransportLost("ACP stdio closed");
    expect(await pendingOutcome).toEqual({ outcome: "cancelled" });

    if (resolveDecision && capturedEffect) {
      resolveDecision({
        status: "approved",
        approvalId: "apr-stale",
        effect: capturedEffect,
      });
    }
    await Promise.resolve();
    expect(lostBridge.discardedStaleDecisionCount()).toBe(1);
  });
});

describe("bridge Claude Code permission-prompt-tool callbacks through ToolBridgeProvisioner", () => {
  it("routes Claude permission prompts through the durable approval bridge and denies unrecognized host operations", async () => {
    const requestedEffects: EffectIdentity[] = [];
    const bridge = createApprovalBridge({
      runId: "run-claude-1",
      engine: "claude-code",
      callbackContinuity: "verified",
      allowedOperationIds: new Set(["claude-code:Bash", "claude-code:Write"]),
      broker: {
        async requestApproval(input) {
          requestedEffects.push(input.effect);
          return {
            status: input.effect.operationId === "claude-code:Bash" ? "approved" : "denied",
            approvalId: `apr-${requestedEffects.length}`,
            effect: input.effect,
          };
        },
      },
    });

    let capturedOptions: ToolBridgeProvisionOptions | undefined;
    const fakeProvisioner = {
      async provision(
        _tools: unknown[],
        options: ToolBridgeProvisionOptions,
      ): Promise<ProvisionedBridge> {
        capturedOptions = options;
        return {
          name: "tanstack",
          url: "http://127.0.0.1:9999/mcp",
          token: "tok",
          async close() {},
        };
      },
    };

    const durableProvisioner = createDurableApprovalBridgeProvisioner(bridge, fakeProvisioner);
    await durableProvisioner.provision([], {
      provider: "docker",
      threadId: "sess-1",
      permission: {
        toolName: "approval_prompt",
        resolve: () => ({ behavior: "deny", message: "default" }),
      },
    });

    expect(capturedOptions?.permission).toBeDefined();
    const allowResult = await capturedOptions!.permission!.resolve({
      tool_name: "Bash",
      input: { command: "ls -la" },
    });
    expect(allowResult).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls -la" },
    });

    const denyResult = await capturedOptions!.permission!.resolve({
      tool_name: "Write",
      input: { file_path: "/workspace/a.txt" },
    });
    expect(denyResult.behavior).toBe("deny");

    const unknownResult = await capturedOptions!.permission!.resolve({
      tool_name: "HostReboot",
      input: {},
    });
    expect(unknownResult.behavior).toBe("deny");
    expect(unknownResult.message).toContain("Unrecognized");
    expect(requestedEffects).toHaveLength(2);
  });
});
