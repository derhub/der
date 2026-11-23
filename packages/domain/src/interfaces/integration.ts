import type { CloudEvent } from "../protocol/cloud-events";
import { DomainError } from "../protocol/problem-details";
import type { DeliveryResult, OutboxDestination } from "../schemas/channel";
import { CapabilityCatalog, type Capability, type Catalog } from "./capability";

export interface OutboxSink {
  readonly kind: string;
  deliver(destination: OutboxDestination, event: CloudEvent): Promise<DeliveryResult>;
}

export interface IntegrationContext {
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface IntegrationContribution {
  readonly capabilities?: readonly Capability[];
  readonly outboxSinks?: readonly OutboxSink[];
  readonly listCapabilities?: () => Promise<readonly Capability[]>;
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

interface RegisteredIntegration {
  readonly id: string;
  readonly contribution: IntegrationContribution;
}

export class IntegrationRegistry {
  private readonly integrations = new Map<string, RegisteredIntegration>();
  private readonly pendingIntegrationIds = new Set<string>();
  private readonly outboxSinks = new Map<string, OutboxSink>();
  private readonly capabilityCatalog = new CapabilityCatalog();

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

  private assertNewCapabilities(integrationId: string, capabilities: readonly Capability[]): void {
    const seenCapabilityIds = new Set<string>();
    for (const capability of capabilities) {
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
  }

  private registerContribution(integrationId: string, contribution: IntegrationContribution): void {
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
    this.assertNewCapabilities(integrationId, newCapabilities);

    this.integrations.set(integrationId, { id: integrationId, contribution });
    for (const capability of newCapabilities) {
      this.capabilityCatalog.add(capability);
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
    for (const entry of this.integrations.values()) {
      const listed = (await entry.contribution.listCapabilities?.()) ?? [];
      this.assertNewCapabilities(entry.id, listed);
      for (const capability of listed) {
        this.capabilityCatalog.add(capability);
      }
    }
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
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to stop ${errors.length} integrations.`);
    }
  }

  getOutboxSink(kind: string): OutboxSink | undefined {
    return this.outboxSinks.get(kind);
  }

  listOutboxSinks(): readonly OutboxSink[] {
    return [...this.outboxSinks.values()];
  }
}
