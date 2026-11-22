import {
  formatUtcTimestamp,
  type ChannelBinding,
  type ChannelIntegration,
  type DeliveryResult,
  type Messaging,
  type OutboxEvent,
} from "@der/domain";
import type { SqliteStore } from "@der/storage";
import { redactTelegramSecret } from "@der/telegram";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_BATCH_LIMIT = 50;

export interface OutboxSenderOptions {
  readonly store: SqliteStore;
  readonly adapters: ReadonlyMap<ChannelIntegration, Messaging>;
  readonly pollIntervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly batchLimit?: number;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface OutboxFlushReport {
  readonly attempted: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly failed: number;
  readonly retained: number;
}

export interface OutboxSender {
  flushOnce(): Promise<OutboxFlushReport>;
  start(): void;
  stop(): Promise<void>;
}

function isOutboxDue(event: OutboxEvent, nowMs: number): boolean {
  if (event.state === "pending") {
    return true;
  }
  if (event.state === "retrying") {
    return event.nextRetryAt === null || Date.parse(event.nextRetryAt) <= nowMs;
  }
  return false;
}

export function createOutboxSender(options: OutboxSenderOptions): OutboxSender {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const nowFn = options.now ?? (() => options.store.database.now());

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let serializedQueue: Promise<unknown> = Promise.resolve();

  function computeRetryBackoff(previousAttempts: number): number {
    return Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.max(0, previousAttempts));
  }

  async function executeFlush(): Promise<OutboxFlushReport> {
    const nowDate = nowFn();
    const nowMs = nowDate.getTime();
    const nowUtc = formatUtcTimestamp(nowDate);

    if (options.adapters.size === 0) {
      const retained = options.store.listDueOutboxEvents(nowUtc, batchLimit).length;
      return { attempted: 0, delivered: 0, retrying: 0, failed: 0, retained };
    }

    const allBindings = options.store.listChannelBindings();
    const bindingsById = new Map<string, ChannelBinding>();
    const activeBindings: ChannelBinding[] = [];
    for (const binding of allBindings) {
      bindingsById.set(binding.id, binding);
      if (binding.enabled && options.adapters.has(binding.integration)) {
        activeBindings.push(binding);
      }
    }

    let retained = 0;
    for (const due of options.store.listDueOutboxEvents(nowUtc, batchLimit)) {
      const binding = bindingsById.get(due.bindingId);
      if (binding === undefined || !binding.enabled || !options.adapters.has(binding.integration)) {
        retained += 1;
      }
    }

    const candidates: { readonly binding: ChannelBinding; readonly event: OutboxEvent }[] = [];
    for (const binding of activeBindings) {
      const bindingRows = options.store.listOutboxEvents({ bindingId: binding.id });
      for (const row of bindingRows) {
        if (isOutboxDue(row, nowMs)) {
          candidates.push({ binding, event: row });
        }
      }
    }

    candidates.sort((left, right) => {
      if (left.event.createdAt !== right.event.createdAt) {
        return left.event.createdAt < right.event.createdAt ? -1 : 1;
      }
      return left.event.id < right.event.id ? -1 : left.event.id > right.event.id ? 1 : 0;
    });

    const batch = candidates.slice(0, batchLimit);
    let attempted = 0;
    let delivered = 0;
    let retrying = 0;
    let failed = 0;

    for (const { binding, event } of batch) {
      const adapter = options.adapters.get(binding.integration);
      if (adapter === undefined) {
        retained += 1;
        continue;
      }

      attempted += 1;
      let result: DeliveryResult;
      try {
        result = await adapter.deliver(binding, event);
      } catch (error) {
        const detail = redactTelegramSecret(error instanceof Error ? error.message : String(error));
        result = {
          status: "retryable",
          retryAfterMs: computeRetryBackoff(event.attempts),
          detail: `Delivery raised unexpected error: ${detail}`,
        };
      }

      if (result.status === "retryable" && result.retryAfterMs === undefined) {
        result = {
          ...result,
          retryAfterMs: computeRetryBackoff(event.attempts),
        };
      }

      const persisted = await options.store.recordOutboxDelivery(event.id, result);
      if (persisted.state === "delivered") {
        delivered += 1;
      } else if (persisted.state === "retrying") {
        retrying += 1;
      } else if (persisted.state === "failed") {
        failed += 1;
      }
    }

    return { attempted, delivered, retrying, failed, retained };
  }

  function flushOnce(): Promise<OutboxFlushReport> {
    const next = serializedQueue.then(executeFlush, executeFlush);
    serializedQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function scheduleNext(): void {
    if (!running) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (!running) {
        return;
      }
      void flushOnce()
        .catch((error) => {
          options.onError?.(error);
        })
        .finally(() => {
          scheduleNext();
        });
    }, pollIntervalMs);
  }

  return {
    flushOnce,
    start(): void {
      if (running) {
        return;
      }
      running = true;
      void flushOnce()
        .catch((error) => {
          options.onError?.(error);
        })
        .finally(() => {
          scheduleNext();
        });
    },
    async stop(): Promise<void> {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await serializedQueue;
    },
  };
}
