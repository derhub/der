import * as z from "zod";
import type { CloudEvent } from "../protocol/cloud-events";
import { DomainError } from "../protocol/problem-details";
import type { EffectIdentity, EffectOperationKind } from "../schemas/approval";
import type { DeliveryResult, OutboxDestination } from "../schemas/channel";
import type { JsonValue } from "../schemas/common";
import {
  toolDescriptor,
  toolOperation,
  toolResult,
  type ToolDescriptor,
  type ToolOperation,
  type ToolResult,
} from "../schemas/execution";
import { CapabilityCatalog, type Capability, type Catalog } from "./capability";
import type { Tools } from "./tools";

export interface ToolExecutionContext {
  readonly effect: EffectIdentity;
  readonly signal?: AbortSignal;
}

export type ToolApprovalPolicy<TInput = unknown> = "none" | "always" | ((input: TInput) => boolean);

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly operationKind: EffectOperationKind;
  readonly name?: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly descriptorInputSchema?: JsonValue;
  readonly approval: ToolApprovalPolicy<z.infer<TInput>>;
  execute(input: z.infer<TInput>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export function defineTool<TInput extends z.ZodType>(
  def: ToolDefinition<TInput>,
): ToolDefinition<TInput> {
  if (def.id.trim().length === 0) {
    throw new DomainError({
      type: "https://der.invalid/problems/invalid-tool-definition",
      title: "Invalid tool definition",
      status: 400,
      detail: "Tool id must be a non-empty string.",
      instance: "/integrations/tools",
      code: "integration.invalid_tool",
    });
  }
  return def;
}

export interface OutboxSink {
  readonly kind: string;
  deliver(destination: OutboxDestination, event: CloudEvent): Promise<DeliveryResult>;
}

export interface IntegrationContext {
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface IntegrationContribution {
  readonly tools?: readonly ToolDefinition[];
  readonly capabilities?: readonly Capability[];
  readonly outboxSinks?: readonly OutboxSink[];
  readonly listTools?: () => Promise<readonly ToolDefinition[]>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface Integration {
  readonly id: string;
  setup(ctx: IntegrationContext): Promise<IntegrationContribution> | IntegrationContribution;
}

export function defineIntegration(def: Integration): Integration {
  if (def.id.trim().length === 0) {
    throw new DomainError({
      type: "https://der.invalid/problems/invalid-integration-definition",
      title: "Invalid integration definition",
      status: 400,
      detail: "Integration id must be a non-empty string.",
      instance: "/integrations",
      code: "integration.invalid_definition",
    });
  }
  return def;
}

export type ToolApprovalVerifier = (effect: EffectIdentity) => Promise<boolean> | boolean;

export interface IntegrationRegistryOptions {
  readonly verifyApproval?: ToolApprovalVerifier;
}

function deniedResult(
  code: "tool.unrecognized_operation" | "tool.approval_required" | "tool.invalid_arguments",
  detail: string,
): ToolResult {
  return toolResult.parse({
    ok: false,
    isError: true,
    outcome: {
      denied: true,
      code,
    },
    detail,
  });
}

function toJsonSchema(def: ToolDefinition): JsonValue {
  if (def.descriptorInputSchema !== undefined) {
    return def.descriptorInputSchema;
  }
  try {
    return JSON.parse(JSON.stringify(z.toJSONSchema(def.inputSchema))) as JsonValue;
  } catch {
    return { type: "object" };
  }
}

function toDescriptor(def: ToolDefinition): ToolDescriptor {
  return toolDescriptor.parse({
    kind: def.operationKind,
    id: def.id,
    name: def.name ?? def.id,
    description: def.description,
    requiresApproval: def.approval !== "none",
    inputSchema: toJsonSchema(def),
  });
}

function requiresApprovalFor(def: ToolDefinition, parsedInput: unknown): boolean {
  if (def.approval === "always") {
    return true;
  }
  if (def.approval === "none") {
    return false;
  }
  return def.approval(parsedInput);
}

interface RegisteredIntegration {
  readonly id: string;
  readonly contribution: IntegrationContribution;
}

export class IntegrationRegistry implements Tools {
  private readonly integrations = new Map<string, RegisteredIntegration>();
  private readonly pendingIntegrationIds = new Set<string>();
  private readonly staticTools = new Map<string, ToolDefinition>();
  private readonly dynamicTools = new Map<string, ToolDefinition>();
  private readonly outboxSinks = new Map<string, OutboxSink>();
  private readonly capabilityCatalog = new CapabilityCatalog();
  private readonly verifyApproval: ToolApprovalVerifier | undefined;
  private dynamicLoaded = false;

  constructor(options?: IntegrationRegistryOptions) {
    this.verifyApproval = options?.verifyApproval;
  }

  private assertUniqueIntegration(id: string): void {
    if (this.integrations.has(id) || this.pendingIntegrationIds.has(id)) {
      throw new DomainError({
        type: "https://der.invalid/problems/duplicate-integration-id",
        title: "Duplicate integration ID",
        status: 409,
        detail: `Integration "${id}" is already registered.`,
        instance: `/integrations/${id}`,
        code: "integration.duplicate_id",
      });
    }
  }

  get catalog(): Catalog {
    return this.capabilityCatalog;
  }

  private registerContribution(integrationId: string, contribution: IntegrationContribution): void {
    const newTools: ToolDefinition[] = [];
    const seenToolIds = new Set<string>();
    for (const tool of contribution.tools ?? []) {
      if (
        this.staticTools.has(tool.id) ||
        this.dynamicTools.has(tool.id) ||
        seenToolIds.has(tool.id)
      ) {
        throw new DomainError({
          type: "https://der.invalid/problems/duplicate-tool-id",
          title: "Duplicate tool ID",
          status: 409,
          detail: `Tool "${tool.id}" is already registered.`,
          instance: `/integrations/${integrationId}/tools/${tool.id}`,
          code: "integration.duplicate_tool_id",
        });
      }
      seenToolIds.add(tool.id);
      newTools.push(tool);
    }

    const newSinks: OutboxSink[] = [];
    const seenSinkKinds = new Set<string>();
    for (const sink of contribution.outboxSinks ?? []) {
      if (this.outboxSinks.has(sink.kind) || seenSinkKinds.has(sink.kind)) {
        throw new DomainError({
          type: "https://der.invalid/problems/duplicate-outbox-sink",
          title: "Duplicate outbox sink kind",
          status: 409,
          detail: `Outbox sink "${sink.kind}" is already registered.`,
          instance: `/integrations/${integrationId}/outbox/${sink.kind}`,
          code: "integration.duplicate_outbox_sink",
        });
      }
      seenSinkKinds.add(sink.kind);
      newSinks.push(sink);
    }

    const newCapabilities = contribution.capabilities ?? [];
    const seenCapabilityIds = new Set<string>();
    for (const capability of newCapabilities) {
      if (this.capabilityCatalog.has(capability.id) || seenCapabilityIds.has(capability.id)) {
        throw new DomainError({
          type: "https://der.invalid/problems/duplicate-capability-id",
          title: "Duplicate capability ID",
          status: 409,
          detail: `Capability "${capability.id}" is already registered.`,
          instance: `/integrations/${integrationId}/capabilities/${capability.id}`,
          code: "integration.duplicate_capability_id",
        });
      }
      seenCapabilityIds.add(capability.id);
    }

    this.integrations.set(integrationId, { id: integrationId, contribution });
    for (const capability of newCapabilities) {
      this.capabilityCatalog.add(capability);
    }
    for (const tool of newTools) {
      this.staticTools.set(tool.id, tool);
    }
    for (const sink of newSinks) {
      this.outboxSinks.set(sink.kind, sink);
    }
  }

  async register(integration: Integration, ctx: IntegrationContext = {}): Promise<void> {
    this.assertUniqueIntegration(integration.id);
    this.pendingIntegrationIds.add(integration.id);
    try {
      const contribution = await integration.setup(ctx);
      this.registerContribution(integration.id, contribution);
    } finally {
      this.pendingIntegrationIds.delete(integration.id);
    }
  }

  registerSync(integration: Integration, ctx: IntegrationContext = {}): void {
    this.assertUniqueIntegration(integration.id);
    const contribution = integration.setup(ctx);
    if (contribution instanceof Promise) {
      throw new DomainError({
        type: "https://der.invalid/problems/async-integration-setup",
        title: "Asynchronous integration setup",
        status: 500,
        detail: `Integration "${integration.id}" returned a Promise from setup(); use register() instead of registerSync().`,
        instance: `/integrations/${integration.id}`,
        code: "integration.async_setup_unsupported",
      });
    }
    this.registerContribution(integration.id, contribution);
  }

  async start(): Promise<void> {
    for (const entry of this.integrations.values()) {
      await entry.contribution.start?.();
    }
    await this.refreshDynamicTools();
  }

  async stop(): Promise<void> {
    const entries = [...this.integrations.values()].reverse();
    const errors: unknown[] = [];
    for (const entry of entries) {
      try {
        await entry.contribution.stop?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.dynamicTools.clear();
    this.dynamicLoaded = false;
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to stop ${errors.length} integrations.`);
    }
  }

  private async refreshDynamicTools(): Promise<void> {
    const nextDynamic = new Map<string, ToolDefinition>();

    for (const entry of this.integrations.values()) {
      if (!entry.contribution.listTools) {
        continue;
      }
      const listed = await entry.contribution.listTools();
      for (const tool of listed) {
        if (this.staticTools.has(tool.id) || nextDynamic.has(tool.id)) {
          throw new DomainError({
            type: "https://der.invalid/problems/duplicate-tool-id",
            title: "Duplicate tool ID",
            status: 409,
            detail: `Tool "${tool.id}" is already registered.`,
            instance: `/integrations/${entry.id}/tools/${tool.id}`,
            code: "integration.duplicate_tool_id",
          });
        }
        nextDynamic.set(tool.id, tool);
      }
    }

    this.dynamicTools.clear();
    for (const [id, tool] of nextDynamic.entries()) {
      this.dynamicTools.set(id, tool);
    }
    this.dynamicLoaded = true;
  }

  async list(): Promise<readonly ToolDescriptor[]> {
    await this.refreshDynamicTools();
    const descriptors: ToolDescriptor[] = [];
    for (const tool of this.staticTools.values()) {
      descriptors.push(toDescriptor(tool));
    }
    for (const tool of this.dynamicTools.values()) {
      descriptors.push(toDescriptor(tool));
    }
    descriptors.sort((a, b) => a.id.localeCompare(b.id));
    return descriptors;
  }

  async invoke(operation: ToolOperation): Promise<ToolResult> {
    const parsedOp = toolOperation.safeParse(operation);
    if (!parsedOp.success) {
      return deniedResult(
        "tool.invalid_arguments",
        `Invalid tool operation payload: ${parsedOp.error.message}`,
      );
    }

    const { effect } = parsedOp.data;
    let tool =
      this.staticTools.get(effect.operationId) ?? this.dynamicTools.get(effect.operationId);
    if (!tool && !this.dynamicLoaded) {
      await this.refreshDynamicTools();
      tool = this.dynamicTools.get(effect.operationId);
    }

    if (!tool || tool.operationKind !== effect.operationKind) {
      return deniedResult(
        "tool.unrecognized_operation",
        `Host operation "${effect.operationKind}:${effect.operationId}" is unrecognized and denied by default.`,
      );
    }

    const parsedInput = tool.inputSchema.safeParse(effect.canonicalArguments);
    if (!parsedInput.success) {
      return deniedResult(
        "tool.invalid_arguments",
        `Invalid arguments for tool "${tool.id}": ${parsedInput.error.message}`,
      );
    }

    if (requiresApprovalFor(tool, parsedInput.data)) {
      if (this.verifyApproval === undefined) {
        throw new DomainError({
          type: "https://der.invalid/problems/approval-verifier-missing",
          title: "Approval verifier not configured",
          status: 403,
          detail: `Tool "${tool.id}" requires approval, but IntegrationRegistry has no verifyApproval verifier configured.`,
          instance: `/integrations/tools/${tool.id}`,
          code: "tool.approval_verifier_missing",
        });
      }
      const authorized = await this.verifyApproval(effect);
      if (!authorized) {
        return deniedResult(
          "tool.approval_required",
          `Exact-operation approval is required for tool "${tool.id}".`,
        );
      }
    }

    return tool.execute(parsedInput.data, { effect });
  }

  getOutboxSink(kind: string): OutboxSink | undefined {
    return this.outboxSinks.get(kind);
  }

  listOutboxSinks(): readonly OutboxSink[] {
    return [...this.outboxSinks.values()];
  }
}
