import type {
  Bot,
  ChannelBinding,
  EffectIdentity,
  Engine,
  EngineKind,
  Session,
  ToolResult,
  Tools,
} from "@der/domain";
import { openSqliteStore, type SqliteStore, type StorageMigration } from "@der/storage";
import { parseServerConfig, type ServerConfig } from "./config";
import { createHttpHandler, type ExtraHttpHandler } from "./http/index";
import {
  createDirectWorkflow,
  createFixtureEngine,
  createFixtureTools,
  createRestateFetchHandler,
  createRestateWorkflowClient,
  type AnyRestateService,
  type DurableWorkflow,
  type WorkflowDeps,
} from "./workflows/index";

export interface SeededFixtureRecords {
  readonly bot: Bot;
  readonly session: Session;
  readonly binding: ChannelBinding;
}

export function seedFixtureRecords(store: SqliteStore): SeededFixtureRecords {
  const bot =
    store.getBot("bot-fixture") ??
    store.createBot({
      id: "bot-fixture",
      name: "Fixture Bot",
      persona: "Credential-free deterministic coworker.",
      defaultEngine: "fixture",
      allowedEngines: ["fixture"],
    });

  const session =
    store.getSession("sess-fixture") ??
    store.createSession({
      id: "sess-fixture",
      botId: bot.id,
      title: "Fixture Session",
      engine: "fixture",
    });

  const binding = store.upsertChannelBinding({
    id: "bind-fixture",
    integration: "fixture",
    externalChatId: "fixture-chat-1",
    externalActorId: "fixture-actor-1",
    botId: bot.id,
    sessionId: session.id,
    enabled: true,
  });

  return { bot, session, binding };
}

export interface CreateServerOptions {
  readonly config?: Partial<ServerConfig>;
  readonly store?: SqliteStore;
  readonly extraMigrations?: readonly StorageMigration[];
  readonly now?: () => Date;
  readonly engines?: ReadonlyMap<EngineKind, Engine>;
  readonly tools?: Tools;
  readonly extraRestateServices?: readonly AnyRestateService[];
  readonly extraHttpHandler?: ExtraHttpHandler;
  readonly reconcileEffect?: (effect: EffectIdentity) => Promise<ToolResult | undefined>;
}

export interface RunningServer {
  readonly config: ServerConfig;
  readonly store: SqliteStore;
  readonly workflow: DurableWorkflow;
  readonly url: string;
  readonly restateUrl: string;
  readonly seededFixture?: SeededFixtureRecords;
  readonly close: () => Promise<void>;
}

export function startServer(options: CreateServerOptions = {}): RunningServer {
  const config = parseServerConfig(options.config);
  const ownsStore = options.store === undefined;
  const store =
    options.store ??
    openSqliteStore({
      filename: config.databasePath,
      ...(options.extraMigrations ? { extraMigrations: options.extraMigrations } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

  const seededFixture = config.seedFixture ? seedFixtureRecords(store) : undefined;

  const engines = new Map<EngineKind, Engine>(options.engines);
  if (!engines.has("fixture")) {
    engines.set("fixture", createFixtureEngine(store));
  }
  const tools = options.tools ?? createFixtureTools();

  const workflowDeps: WorkflowDeps = {
    store,
    engines,
    tools,
    approvalTimeoutMs: config.approvalTimeoutMs,
    ...(options.reconcileEffect ? { reconcileEffect: options.reconcileEffect } : {}),
  };

  let closeDirectWorkflow: (() => void) | undefined;
  let workflow: DurableWorkflow;
  if (config.restateMode === "direct") {
    const direct = createDirectWorkflow(workflowDeps);
    workflow = direct;
    closeDirectWorkflow = direct.close;
  } else {
    workflow = createRestateWorkflowClient(config.restateIngressUrl);
  }

  const restateFetchHandler = createRestateFetchHandler(
    workflowDeps,
    options.extraRestateServices ?? [],
  );

  const restateServer = Bun.serve({
    hostname: config.restateHost,
    port: config.restateListen,
    fetch: (request) => restateFetchHandler(request),
  });

  const httpHandler = createHttpHandler({
    store,
    workflow,
    engines,
    config,
    ...(options.extraHttpHandler ? { extraHttpHandler: options.extraHttpHandler } : {}),
  });

  const httpServer = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: httpHandler,
  });

  return {
    config,
    store,
    workflow,
    url: `http://${config.host}:${httpServer.port}`,
    restateUrl: `http://${config.restateHost}:${restateServer.port}`,
    ...(seededFixture ? { seededFixture } : {}),
    async close() {
      closeDirectWorkflow?.();
      await httpServer.stop(true);
      await restateServer.stop(true);
      if (ownsStore) {
        store.close();
      }
    },
  };
}

if (import.meta.main) {
  const running = startServer();
  console.log(`der server listening on ${running.url} (restate fetch on ${running.restateUrl})`);
  const shutdown = () => {
    void running.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
