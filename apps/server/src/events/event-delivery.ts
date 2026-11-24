import type {
  BotStore,
  ExecuteResult,
  JsonValue,
  RunAdmission,
  RunRequest,
  SessionEvent,
  SessionEventStore,
} from "@der/domain";
import { fitResult } from "../code-mode/execute";

const encoder = new TextEncoder();

export interface EventDeliveryDeps {
  readonly store: SessionEventStore;
  readonly bots: Pick<BotStore, "getBot">;
  readonly admit: (request: RunRequest) => Promise<RunAdmission>;
  readonly maxResultBytes: number;
  readonly logError?: (error: unknown) => void;
}

export type DeliverEvents = () => Promise<void>;

/**
 * Admits one event Run per idle session, oldest event first. An event waits while
 * its session has an active Run or its bot's chain limit is reached; the next
 * pass (sweep, or a Run finishing) releases it. Passes never overlap; a pass that
 * fails rejects only its own caller, and the next pass runs as usual.
 */
export function createEventDelivery(deps: EventDeliveryDeps): DeliverEvents {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const pass = tail.then(() => deliverPass(deps));
    tail = pass.catch(() => undefined);
    return pass;
  };
}

/**
 * The event Run's text: the payload as JSON. A finished Script's result is fitted to
 * the size `execute` returns inline, less the rest of the payload, so a long result
 * cannot flood the Run.
 */
function eventText(payload: JsonValue, maxResultBytes: number): string {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const { result } = payload;
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      const envelope = encoder.encode(JSON.stringify({ ...payload, result: null })).byteLength - 4;
      const fitted = fitResult(
        result as unknown as ExecuteResult,
        Math.max(0, maxResultBytes - envelope),
        payload["status"] === "in_doubt",
      );
      return JSON.stringify({ ...payload, result: fitted });
    }
  }
  return JSON.stringify(payload);
}

async function deliverPass(deps: EventDeliveryDeps): Promise<void> {
  const sessions = new Set<string>();
  for (const event of deps.store.listPendingSessionEvents()) {
    if (sessions.has(event.sessionId)) {
      continue;
    }
    sessions.add(event.sessionId);
    try {
      await deliverOne(deps, event);
    } catch (error) {
      deps.logError?.(error);
    }
  }
}

function eventRequest(event: SessionEvent, maxResultBytes: number): RunRequest {
  return {
    botId: event.botId,
    sessionId: event.sessionId,
    origin: "event",
    idempotencyKey: event.id,
    input: { parts: [{ type: "text", text: eventText(event.payload, maxResultBytes) }] },
  };
}

/**
 * An event that already has a Run was admitted before a crash. A Run still queued never
 * started; admitting the same request again starts it, as admission is idempotent per event.
 */
async function deliverOne(deps: EventDeliveryDeps, event: SessionEvent): Promise<void> {
  const { store } = deps;
  if (event.runId !== null) {
    const active = store.getActiveRun(event.sessionId);
    if (active?.id === event.runId && active.status === "queued") {
      await deps.admit(eventRequest(event, deps.maxResultBytes));
    }
    store.markSessionEventDelivered(event.id, event.runId);
    return;
  }
  if (store.getActiveRun(event.sessionId) !== undefined) {
    return;
  }
  const bot = await deps.bots.getBot(event.botId);
  if (bot === undefined || store.countEventChain(event.sessionId) >= bot.eventChainLimit) {
    return;
  }
  const admission = await deps.admit(eventRequest(event, deps.maxResultBytes));
  store.markSessionEventDelivered(event.id, admission.run.id);
}
