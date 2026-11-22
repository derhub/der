import type { ChannelIntegration, Messaging } from "@der/domain";
import type { SqliteStore } from "@der/storage";
import { processChannelUpdate, type ChannelCallbackAcknowledger } from "./intake";
import { createOutboxSender, type OutboxSender } from "./outbox-sender";
import type { DurableWorkflow } from "../workflows/index";

const DEFAULT_TELEGRAM_CONSUMER = "telegram-default";
const DEFAULT_POLL_RETRY_INITIAL_MS = 1_000;
const DEFAULT_POLL_RETRY_MAX_MS = 30_000;

export interface MessagingRuntimeOptions {
  readonly store: SqliteStore;
  readonly workflow: DurableWorkflow;
  readonly adapters: ReadonlyMap<ChannelIntegration, Messaging & ChannelCallbackAcknowledger>;
  readonly telegramConsumer?: string;
  readonly pollRetryInitialBackoffMs?: number;
  readonly pollRetryMaxBackoffMs?: number;
  readonly outboxPollIntervalMs?: number;
  readonly outboxInitialBackoffMs?: number;
  readonly outboxMaxBackoffMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface MessagingRuntime {
  readonly outbox: OutboxSender;
  start(): void;
  stop(): Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMessagingRuntime(options: MessagingRuntimeOptions): MessagingRuntime {
  const consumer = options.telegramConsumer ?? DEFAULT_TELEGRAM_CONSUMER;
  const pollRetryInitialMs = options.pollRetryInitialBackoffMs ?? DEFAULT_POLL_RETRY_INITIAL_MS;
  const pollRetryMaxMs = options.pollRetryMaxBackoffMs ?? DEFAULT_POLL_RETRY_MAX_MS;
  const sleepFn = options.sleep ?? abortableSleep;

  const outbox = createOutboxSender({
    store: options.store,
    adapters: options.adapters,
    ...(options.outboxPollIntervalMs !== undefined
      ? { pollIntervalMs: options.outboxPollIntervalMs }
      : {}),
    ...(options.outboxInitialBackoffMs !== undefined
      ? { initialBackoffMs: options.outboxInitialBackoffMs }
      : {}),
    ...(options.outboxMaxBackoffMs !== undefined
      ? { maxBackoffMs: options.outboxMaxBackoffMs }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  let abortController: AbortController | null = null;
  let intakeTask: Promise<void> | null = null;

  async function runTelegramIntakeLoop(
    adapter: Messaging & ChannelCallbackAcknowledger,
    signal: AbortSignal,
  ): Promise<void> {
    let consecutiveRetries = 0;

    while (!signal.aborted) {
      let shouldBackoff = false;
      const durableCursor = options.store.getChannelCursor("telegram", consumer)?.position;

      try {
        for await (const update of adapter.poll(durableCursor)) {
          if (signal.aborted) {
            return;
          }

          const outcome = await processChannelUpdate(
            {
              store: options.store,
              workflow: options.workflow,
              consumer,
              messaging: adapter,
              ...(options.now !== undefined ? { now: options.now } : {}),
              onCallbackAckError: (error) => {
                options.onError?.(error);
              },
            },
            update,
          );

          if (outcome.status === "retryable") {
            shouldBackoff = true;
            break;
          }
          consecutiveRetries = 0;
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        options.onError?.(error);
        shouldBackoff = true;
      }

      if (signal.aborted) {
        return;
      }

      consecutiveRetries += 1;
      const delayMs = shouldBackoff
        ? Math.min(pollRetryMaxMs, pollRetryInitialMs * 2 ** Math.max(0, consecutiveRetries - 1))
        : pollRetryInitialMs;
      await sleepFn(delayMs, signal);
    }
  }

  return {
    outbox,
    start(): void {
      if (abortController !== null) {
        return;
      }
      abortController = new AbortController();
      outbox.start();

      const telegramAdapter = options.adapters.get("telegram");
      if (telegramAdapter !== undefined) {
        intakeTask = runTelegramIntakeLoop(telegramAdapter, abortController.signal);
      }
    },
    async stop(): Promise<void> {
      const controller = abortController;
      abortController = null;
      controller?.abort();

      const runningIntake = intakeTask;
      intakeTask = null;
      if (runningIntake !== null) {
        await runningIntake;
      }
      await outbox.stop();
    },
  };
}
