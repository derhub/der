import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  defineIntegration,
  IntegrationRegistry,
  type Approval,
  type ApprovalResolutionInput,
  type Bot,
  type BotId,
  type Catalog,
  type ChannelBinding,
  type ChannelIntakeMetadata,
  type Engine,
  type EngineKind,
  type EngineReadiness,
  type Integration,
  type MemoryRecord,
  type MemoryWriteInput,
  type Message,
  type OutboxEvent,
  type OutboxSink,
  type Routine,
  type RoutineId,
  type Run,
  type RunAdmission,
  type RunId,
  type RunRequest,
  type Session,
  type SessionId,
  type Skill,
  type ScriptStore,
} from "@der/domain";
import { createMcpIntegration } from "@der/mcp";
import {
  buildRunContext,
  composeResumeText,
  createSkillCatalog,
  planTurn,
  type RunContextCaps,
  type SkillCatalog,
} from "@der/runtime/context";
import {
  createAntigravityEngine,
  createClaudeCodeEngine,
  createCodexEngine,
  DEFAULT_TERMS_COVERAGE,
  diagnoseEngine,
  type EngineAuthProbeResult,
  type LoadEngineRunInput,
} from "@der/runtime/engines";
import {
  APPROVED_VENDOR_EGRESS,
  bunCommandRunner,
  createDockerSandbox,
  createDockerWasmerSandbox,
  createHardenedDockerProvider,
  DEFAULT_ENGINE_SHADOW_HOMES,
  type CommandRunner,
  type DockerNetworkPolicy,
  type OfficialEngineKind,
} from "@der/runtime/sandbox";
import {
  openSqliteScriptStore,
  openSqliteStore,
  type SqliteStore,
  type StorageMigration,
  type UpsertChannelBindingInput,
} from "@der/storage";
import {
  createMemoryProjection,
  MEMORY_ROUTINE_SLOTS_MIGRATION,
  openSqliteMemory,
  type SqliteMemory,
} from "@der/storage/memory";
import { openSqliteRoutines, type SqliteRoutines } from "@der/storage/routines";
import { parseServerConfig, type ServerConfig } from "./config";
import { createHttpApp, type ExtraHttpHandler } from "./http/index";
import { createOutboxSender, type OutboxSender } from "./messaging/index";
import {
  createDirectRoutineScheduleClient,
  createDirectWorkflowDriver,
  createFixtureEngine,
  createRestateFetchHandler,
  createRestateWorkflowDriver,
  createRoutineScheduleClient,
  createRoutineScheduleObject,
  createRunCoordinator,
  type AnyRestateService,
  type ConfigureRoutineInput,
  type ConfigureRoutineResult,
  type DurableWorkflow,
  type RoutineScheduleClient,
  type RunCoordinator,
  type ScriptRoutineDeps,
  type TurnRecord,
} from "./workflows/index";
import { createHostCapabilities } from "./capabilities/index";
import { createFixtureCapabilities } from "./capabilities/fixture";
import { createExecuteTool } from "./code-mode/execute";
import { codeModeInstructions } from "./code-mode/instructions";
import { createCatalogSearchCapability, createSearchTool } from "./code-mode/search";
import { createEventDelivery, type DeliverEvents } from "./events/event-delivery";
import { ScriptDriver } from "./scripts/script-driver";

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

export interface ServerCommands {
  admitRun(request: RunRequest): Promise<RunAdmission>;
  decideApproval(
    decision: ApprovalResolutionInput,
    channelIntake?: ChannelIntakeMetadata,
  ): Promise<Approval>;
  configureRoutine(
    routineId: RoutineId,
    input: ConfigureRoutineInput,
  ): Promise<ConfigureRoutineResult>;
  listBots(): Bot[];
  listSessions(botId: BotId): Session[];
  listMessages(
    sessionId: SessionId,
    options?: { readonly limit?: number; readonly afterOrdinal?: number },
  ): Message[];
  getRun(runId: RunId): { readonly run: Run; readonly approval: Approval | null } | undefined;
  readMemory(botId: BotId, version?: number): Promise<MemoryRecord | undefined>;
  writeMemory(input: MemoryWriteInput): Promise<MemoryRecord>;
  listSkills(): Promise<readonly Skill[]>;
  listRoutines(botId?: BotId): Routine[];
  diagnoseEngines(): Promise<readonly EngineReadiness[]>;
  listOutboxEvents(filter?: Parameters<SqliteStore["listOutboxEvents"]>[0]): OutboxEvent[];
  upsertChannelBinding(input: UpsertChannelBindingInput): ChannelBinding;
  listChannelBindings(filter?: Parameters<SqliteStore["listChannelBindings"]>[0]): ChannelBinding[];
}

export interface CreateServerOptions {
  readonly config?: Partial<ServerConfig>;
  readonly store?: SqliteStore;
  readonly extraMigrations?: readonly StorageMigration[];
  readonly now?: () => Date;
  readonly engines?: ReadonlyMap<EngineKind, Engine>;
  readonly catalog?: Catalog;
  readonly integrations?: readonly Integration[];
  readonly skills?: SkillCatalog;
  readonly commandRunner?: CommandRunner;
  readonly probeEngineAuth?: (engine: OfficialEngineKind) => Promise<EngineAuthProbeResult>;
  readonly extraRestateServices?: readonly AnyRestateService[];
  readonly extraHttpHandler?: ExtraHttpHandler;
  readonly outboxSinks?: readonly OutboxSink[];
}

export interface RunningServer {
  readonly config: ServerConfig;
  readonly store: SqliteStore;
  readonly memory: SqliteMemory;
  readonly routines: SqliteRoutines;
  readonly skills: SkillCatalog;
  readonly catalog: Catalog;
  readonly scriptRunStore: ScriptStore;
  readonly scriptDriver: ScriptDriver;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly coordinator: RunCoordinator;
  readonly workflow: DurableWorkflow;
  readonly routineSchedule: RoutineScheduleClient;
  readonly outbox: OutboxSender;
  readonly commands: ServerCommands;
  readonly url: string;
  readonly restateUrl?: string;
  readonly seededFixture?: SeededFixtureRecords;
  readonly close: () => Promise<void>;
}

function mergeMigrations(
  extraMigrations?: readonly StorageMigration[],
): readonly StorageMigration[] {
  const byVersion = new Map<string, StorageMigration>();
  byVersion.set(MEMORY_ROUTINE_SLOTS_MIGRATION.version, MEMORY_ROUTINE_SLOTS_MIGRATION);
  for (const migration of extraMigrations ?? []) {
    byVersion.set(migration.version, migration);
  }
  return [...byVersion.values()].sort((a, b) => a.version.localeCompare(b.version));
}

function toMcpServerConfigs(
  entries: ServerConfig["mcpServers"],
): readonly import("@der/mcp").McpServerConfig[] {
  return entries.map((entry) => ({
    id: entry.id,
    transport:
      entry.transport.kind === "stdio"
        ? {
            kind: "stdio" as const,
            command: entry.transport.command,
            ...(entry.transport.args !== undefined ? { args: entry.transport.args } : {}),
            ...(entry.transport.env !== undefined ? { env: entry.transport.env } : {}),
            ...(entry.transport.cwd !== undefined ? { cwd: entry.transport.cwd } : {}),
          }
        : {
            kind: "streamable-http" as const,
            url: entry.transport.url,
            ...(entry.transport.headers !== undefined ? { headers: entry.transport.headers } : {}),
            ...(entry.transport.bearerToken !== undefined
              ? { bearerToken: entry.transport.bearerToken }
              : {}),
          },
    ...(entry.allowedTools !== undefined ? { allowedTools: entry.allowedTools } : {}),
    ...(entry.readOnlyTools !== undefined ? { readOnlyTools: entry.readOnlyTools } : {}),
    ...(entry.defaultRequiresApproval !== undefined
      ? { defaultRequiresApproval: entry.defaultRequiresApproval }
      : {}),
    ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    ...(entry.redactedSecrets !== undefined ? { redactedSecrets: entry.redactedSecrets } : {}),
  }));
}

function createFixtureIntegration(): Integration {
  return defineIntegration({
    id: "fixture",
    setup: () => ({ capabilities: createFixtureCapabilities().capabilities }),
  });
}

const SHADOW_HOME_AUTH_MARKERS: Readonly<Record<OfficialEngineKind, readonly string[]>> = {
  codex: ["/home/engine/.codex/auth.json", "/home/engine/.codex/credentials.json"],
  "claude-code": [
    "/home/engine/.claude/.credentials.json",
    "/home/engine/.claude/credentials.json",
    "/home/engine/.claude.json",
  ],
  antigravity: [
    "/home/engine/.antigravity/auth.json",
    "/home/engine/.gemini/oauth_creds.json",
    "/home/engine/.config/antigravity/auth.json",
    "/home/engine/.local/share/antigravity/auth.json",
  ],
} as const;

function engineImageFor(engine: OfficialEngineKind, config: ServerConfig): string {
  if (engine === "codex") {
    return config.engineImages.codex;
  }
  if (engine === "claude-code") {
    return config.engineImages.claudeCode;
  }
  return config.engineImages.antigravity;
}

function createShadowHomeAuthProbe(
  engine: OfficialEngineKind,
  config: ServerConfig,
  runner: CommandRunner,
): () => Promise<EngineAuthProbeResult> {
  const shadowHome = DEFAULT_ENGINE_SHADOW_HOMES[engine];
  const markers = SHADOW_HOME_AUTH_MARKERS[engine];
  const probeImage = engineImageFor(engine, config);

  return async () => {
    if (config.dockerHost.length === 0) {
      return {
        authenticated: false,
        detail: `Dedicated rootless DER_DOCKER_HOST is not configured; cannot inspect shadow home "${shadowHome.volumeName}".`,
      };
    }

    try {
      const inspect = await runner.exec(
        config.dockerBinary,
        ["volume", "inspect", shadowHome.volumeName],
        {
          env: { DOCKER_HOST: config.dockerHost },
          timeoutMs: 5_000,
        },
      );
      if (inspect.exitCode !== 0) {
        return {
          authenticated: false,
          detail: `Shadow-home volume "${shadowHome.volumeName}" is not provisioned on the dedicated rootless daemon.`,
        };
      }

      const checkCommand = markers.map((marker) => `test -s '${marker}'`).join(" || ");
      const probe = await runner.exec(
        config.dockerBinary,
        [
          "run",
          "--rm",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges:true",
          "--user",
          config.dockerUser,
          "--mount",
          `type=volume,source=${shadowHome.volumeName},target=${shadowHome.containerHomePath},readonly`,
          probeImage,
          "sh",
          "-lc",
          checkCommand,
        ],
        {
          env: { DOCKER_HOST: config.dockerHost },
          timeoutMs: 5_000,
        },
      );
      if (probe.exitCode === 0) {
        return {
          authenticated: true,
          detail: `Shadow-home volume "${shadowHome.volumeName}" contains verified auth artifacts.`,
        };
      }
      return {
        authenticated: false,
        detail: `Shadow-home volume "${shadowHome.volumeName}" exists, but no interactive login credentials were found.`,
      };
    } catch (error) {
      return {
        authenticated: false,
        detail: `Shadow-home probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

const NEWEST_MESSAGE_WINDOW = 200;

function modelOf(engine: EngineKind, models: ServerConfig["engineModels"]): string {
  switch (engine) {
    case "claude-code":
      return models.claudeCode;
    case "codex":
      return models.codex;
    case "antigravity":
      return models.antigravity;
    case "fixture":
      return "fixture";
  }
}

/**
 * Decides resume or rebuild for a Run. Planning takes the session's stored engine session, so a
 * replayed engine step, the retry after a refused resume and a later Run on another engine find
 * none and rebuild; only this Run's finish stores one again, from the record left in `turns`.
 */
function planRunTurn(
  input: {
    readonly store: SqliteStore;
    readonly engines: ReadonlyMap<EngineKind, Engine>;
    readonly engineModels: ServerConfig["engineModels"];
    readonly turns: Map<RunId, TurnRecord>;
  },
  run: Run,
  built: Awaited<ReturnType<typeof buildRunContext>>,
  messages: readonly Message[],
): {
  readonly messages?: Array<{ role: "user"; content: string }>;
  readonly resumeSessionId?: string;
} {
  if (run.engine === "script") {
    return {};
  }
  const engine = run.engine;
  const resumable = input.engines.get(engine)?.resumable === true;
  // `buildRunContext`'s base hash does not cover the engine model; a model change must rebuild.
  const baseHash = `${built.baseHash}:${modelOf(engine, input.engineModels)}`;
  // The mode is written now so a finish recovered from persisted events, which skips planning,
  // keeps it.
  const turn = input.store.takeEngineSession(run.id, (taken) => {
    const stored = resumable ? taken : null;
    // The loaded window is the newest 200 messages; it holds every message after `lastOrdinal`
    // unless 200 or more arrived since.
    const windowIsComplete =
      stored === null ||
      messages.length < NEWEST_MESSAGE_WINDOW ||
      (messages[0]?.ordinal ?? 0) <= stored.lastOrdinal + 1;
    const messagesAfterLastOrdinal =
      stored !== null && windowIsComplete
        ? messages.filter((message) => message.ordinal > stored.lastOrdinal)
        : [];
    const plan = planTurn({
      stored,
      baseHash,
      contextHash: built.contextHash,
      contextBlock: built.contextBlock,
      messagesAfterLastOrdinal,
    });
    return plan.mode === "resume"
      ? {
          contextMode: "resumed" as const,
          messages: [
            {
              role: "user" as const,
              content: composeResumeText(plan.contextNote, messagesAfterLastOrdinal),
            },
          ],
          resumeSessionId: plan.vendorSessionId,
        }
      : { contextMode: "rebuilt" as const };
  });
  if (turn === undefined) {
    // An interrupt ended the Run while it was loading; its successor may own the engine session.
    throw new Error(`Run ${run.id} ended before its turn was planned.`);
  }
  if (resumable) {
    input.turns.set(run.id, {
      sessionId: run.sessionId,
      engine,
      baseHash,
      contextHash: built.contextHash,
      lastOrdinal: messages.at(-1)?.ordinal ?? 0,
    });
  }
  return turn;
}

function createContextLoader(input: {
  readonly store: SqliteStore;
  readonly memory: SqliteMemory;
  readonly skills: SkillCatalog;
  readonly coordinator: RunCoordinator;
  readonly maxTokens: number;
  readonly caps: RunContextCaps;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly engineModels: ServerConfig["engineModels"];
  readonly turns: Map<RunId, TurnRecord>;
  readonly codeMode: {
    readonly catalog: Catalog;
    readonly scriptRunStore: ScriptStore;
    readonly scriptDriver: ScriptDriver;
    readonly maxResultBytes: number;
    readonly inlineWaitMs: number;
  };
}): LoadEngineRunInput {
  return async (run: Run) => {
    const bot = input.store.getBot(run.botId);
    const messages = input.store.listMessages(run.sessionId, {
      limit: NEWEST_MESSAGE_WINDOW,
      newest: true,
    });
    const [memoryRecord, skillList] = await Promise.all([
      input.memory.read(run.botId),
      input.skills.listSkills(),
    ]);

    const built = await buildRunContext({
      bot: bot ?? { id: run.botId, name: run.botId, persona: "" },
      ...(memoryRecord !== undefined ? { memory: memoryRecord } : {}),
      skills: skillList,
      caps: input.caps,
      codeModeInstructions: codeModeInstructions(input.codeMode.catalog),
      messages,
      compaction: {
        maxTokens: input.maxTokens,
        threadId: run.sessionId,
      },
    });

    const approvalBroker = input.coordinator.createApprovalBroker(run);
    const turn = planRunTurn(input, run, built, messages);

    const codeMode = input.codeMode;
    return {
      messages: turn.messages ?? [...built.messages],
      systemPrompts: [...built.systemPrompts],
      tools: [
        createSearchTool({ catalog: codeMode.catalog, maxResultBytes: codeMode.maxResultBytes }),
        createExecuteTool({
          run,
          scriptRunStore: codeMode.scriptRunStore,
          scriptDriver: codeMode.scriptDriver,
          maxResultBytes: codeMode.maxResultBytes,
          inlineWaitMs: codeMode.inlineWaitMs,
        }),
      ],
      approvalBroker,
      ...(turn.resumeSessionId !== undefined ? { resumeSessionId: turn.resumeSessionId } : {}),
    };
  };
}

function buildOfficialEngine(input: {
  readonly kind: OfficialEngineKind;
  readonly config: ServerConfig;
  readonly workspaceHostPath: string;
  readonly loadRunInput: LoadEngineRunInput;
  readonly runner: CommandRunner;
  readonly probeEngineAuth?: (engine: OfficialEngineKind) => Promise<EngineAuthProbeResult>;
}): Engine {
  const shadowHome = DEFAULT_ENGINE_SHADOW_HOMES[input.kind];
  const network: DockerNetworkPolicy =
    input.config.dockerEgressNetwork !== undefined &&
    input.config.dockerEgressProxyUrl !== undefined
      ? {
          mode: "scoped_egress",
          networkName: input.config.dockerEgressNetwork,
          allowedHosts: APPROVED_VENDOR_EGRESS[input.kind],
          egressProxyUrl: input.config.dockerEgressProxyUrl,
        }
      : { mode: "none" };

  const image = engineImageFor(input.kind, input.config);

  const sandboxProvider = createHardenedDockerProvider({
    dockerHost: input.config.dockerHost,
    dockerBinary: input.config.dockerBinary,
    image,
    engine: input.kind,
    user: input.config.dockerUser,
    workspaceHostPath: input.workspaceHostPath,
    allowedWorkspaceRoots: [input.workspaceHostPath],
    shadowHome,
    network,
    limits: {
      cpus: input.config.dockerCpus,
      memoryMb: input.config.dockerMemoryMb,
      pidsLimit: input.config.dockerPidsLimit,
    },
    runner: input.runner,
  });

  const probeAuth = input.probeEngineAuth
    ? () => input.probeEngineAuth!(input.kind)
    : createShadowHomeAuthProbe(input.kind, input.config, input.runner);

  const diagnose = () =>
    diagnoseEngine({
      engine: input.kind,
      dockerHost: input.config.dockerHost,
      dockerBinary: input.config.dockerBinary,
      terms: DEFAULT_TERMS_COVERAGE[input.kind],
      runner: input.runner,
      probeAuth,
    });

  if (input.kind === "codex") {
    return createCodexEngine({
      model: input.config.engineModels.codex as Parameters<typeof createCodexEngine>[0]["model"],
      sandboxProvider,
      autoCompactTokens: input.config.engineCompactTokens,
      diagnose,
      loadRunInput: input.loadRunInput,
    });
  }

  if (input.kind === "claude-code") {
    return createClaudeCodeEngine({
      model: input.config.engineModels.claudeCode as Parameters<
        typeof createClaudeCodeEngine
      >[0]["model"],
      sandboxProvider,
      callbackContinuity: "verified",
      autoCompactTokens: input.config.engineCompactTokens,
      diagnose,
      loadRunInput: input.loadRunInput,
    });
  }

  return createAntigravityEngine({
    model: input.config.engineModels.antigravity,
    sandboxProvider,
    callbackContinuity: "verified",
    diagnose,
    loadRunInput: input.loadRunInput,
  });
}

function hasRestateServiceNamed(services: readonly AnyRestateService[], name: string): boolean {
  return services.some((service) => (service as { readonly name?: string }).name === name);
}

export async function registerDeploymentWithRestate(options: {
  readonly adminUrl: string;
  readonly deploymentUrl: string;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
}): Promise<{ readonly id: string }> {
  const maxAttempts = options.maxAttempts ?? 20;
  const retryDelayMs = options.retryDelayMs ?? 500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${options.adminUrl.replace(/\/+$/, "")}/deployments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uri: options.deploymentUrl,
          force: true,
          use_http_11: true,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return (await response.json()) as { id: string };
      }
      lastError = new Error(
        `Restate admin returned HTTP ${response.status}: ${await response.text()}`,
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      await Bun.sleep(retryDelayMs);
    }
  }

  throw new Error(
    `Failed to register Restate deployment ${options.deploymentUrl} at ${options.adminUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function startServer(options: CreateServerOptions = {}): Promise<RunningServer> {
  const config = parseServerConfig(options.config);
  const ownsStore = options.store === undefined;
  const store =
    options.store ??
    openSqliteStore({
      filename: config.databasePath,
      extraMigrations: mergeMigrations(options.extraMigrations),
      ...(options.now ? { now: options.now } : {}),
    });

  const closing = new AbortController();
  let integrationRegistry: IntegrationRegistry | undefined;
  let closeDirectDriver: (() => void) | undefined;
  let closeScriptDriver: (() => Promise<void>) | undefined;
  let restateServer: ReturnType<typeof Bun.serve> | undefined;
  let httpServer: ReturnType<typeof Bun.serve> | undefined;
  let outbox: ReturnType<typeof createOutboxSender> | undefined;

  try {
    const projection = createMemoryProjection(config.memoryProjectionDir);
    const memory = openSqliteMemory({ database: store.database, projection });
    const routines = openSqliteRoutines({ database: store.database });
    const skills = options.skills ?? createSkillCatalog({ rootDir: config.skillsRootDir });
    const workspaceHostPath = resolve(config.workspaceRootDir);
    mkdirSync(workspaceHostPath, { recursive: true });

    const seededFixture = config.seedFixture ? seedFixtureRecords(store) : undefined;
    const runner = options.commandRunner ?? bunCommandRunner;
    const hasFixtureEngine =
      options.engines !== undefined
        ? options.engines.has("fixture") || config.seedFixture
        : config.enabledEngines.includes("fixture") || config.seedFixture;

    let catalog: Catalog;
    if (options.catalog !== undefined) {
      catalog = options.catalog;
    } else {
      integrationRegistry = new IntegrationRegistry();

      if (hasFixtureEngine) {
        integrationRegistry.registerSync(createFixtureIntegration());
      }

      const dockerSandbox = createDockerSandbox({
        dockerHost: config.dockerHost,
        dockerBinary: config.dockerBinary,
        image: config.engineImages.codex,
        engine: "codex",
        user: config.dockerUser,
        workspaceHostPath,
        allowedWorkspaceRoots: [workspaceHostPath],
        shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
        ...(config.dockerEgressNetwork !== undefined && config.dockerEgressProxyUrl !== undefined
          ? {
              egressNetwork: {
                networkName: config.dockerEgressNetwork,
                allowedHosts: APPROVED_VENDOR_EGRESS.codex,
                egressProxyUrl: config.dockerEgressProxyUrl,
              },
            }
          : {}),
        limits: {
          cpus: config.dockerCpus,
          memoryMb: config.dockerMemoryMb,
          pidsLimit: config.dockerPidsLimit,
        },
        runner,
      });

      const wasmerRoots =
        config.wasmerAllowedRoots.length > 0 ? config.wasmerAllowedRoots : [workspaceHostPath];
      const wasmerSandbox = createDockerWasmerSandbox({
        dockerHost: config.dockerHost,
        dockerBinary: config.dockerBinary,
        image: config.wasmerRunnerImage,
        user: config.dockerUser,
        limits: {
          cpus: config.dockerCpus,
          memoryMb: config.dockerMemoryMb,
          pidsLimit: config.dockerPidsLimit,
        },
        allowedHostRoots: wasmerRoots,
        maxTimeoutMs: config.wasmerMaxTimeoutMs,
        runner,
      });

      const registry = integrationRegistry;
      registry.registerSync(
        defineIntegration({
          id: "host",
          setup: () => ({
            capabilities: [
              ...createHostCapabilities({
                bots: store,
                sessions: store,
                memory,
                routines,
                routineSchedule: { configure: (id, input) => routineSchedule.configure(id, input) },
                skills,
                sandboxes: { docker: dockerSandbox, wasmer: wasmerSandbox },
              }),
              createCatalogSearchCapability(registry.catalog, config.scriptResultBytes),
            ],
          }),
        }),
      );

      if (config.mcpServers.length > 0) {
        integrationRegistry.registerSync(
          createMcpIntegration({
            servers: toMcpServerConfigs(config.mcpServers),
          }),
        );
      }

      for (const integration of options.integrations ?? []) {
        await integrationRegistry.register(integration);
      }

      await integrationRegistry.start();
      catalog = integrationRegistry.catalog;
    }

    const engines = new Map<EngineKind, Engine>(options.engines);
    const clockNow = options.now ?? (() => store.database.now());
    const scriptRunStore = openSqliteScriptStore({ database: store.database });
    let deliverEvents: DeliverEvents | undefined;
    const scriptDriver = new ScriptDriver({
      deliverEvents: () => deliverEvents?.() ?? Promise.resolve(),
      store,
      scripts: scriptRunStore,
      bots: store,
      catalog,
      approvalTimeoutMs: config.approvalTimeoutMs,
      sweepIntervalMs: config.scriptSweepIntervalMs,
      limits: {
        memoryBytes: config.scriptMemoryBytes,
        activeMs: config.scriptActiveMs,
        maxSteps: config.scriptMaxSteps,
        maxInFlight: config.scriptMaxInFlight,
        maxAll: config.scriptMaxAll,
        outputBytes: config.scriptOutputBytes,
      },
      now: clockNow,
      logError: (error) => console.error("Script driver error", error),
    });
    closeScriptDriver = () => scriptDriver.close();

    const finishRun = async (run: Run): Promise<void> => {
      await scriptDriver.cancelRun(run.id);
      await deliverEvents?.();
    };

    let coordinator: RunCoordinator;
    let routineSchedule: RoutineScheduleClient;
    let resumeDirectRuns: (() => Promise<void>) | undefined;
    const scriptRoutines = (): ScriptRoutineDeps => ({ routines, scriptRunStore, scriptDriver });

    const turns = new Map<RunId, TurnRecord>();

    if (config.restateMode === "direct") {
      const directDriver = createDirectWorkflowDriver({ now: clockNow });
      coordinator = createRunCoordinator({
        store,
        engines,
        turns,
        driver: directDriver,
        approvalTimeoutMs: config.approvalTimeoutMs,
        now: clockNow,
        onRunFinished: finishRun,
        scriptRoutines,
      });
      directDriver.setRunner(async (runId) => {
        try {
          await coordinator.executeRun(runId, directDriver);
        } catch (error) {
          if (!closing.signal.aborted) {
            console.error(`Direct Run ${runId} failed`, error);
          }
        }
      });
      resumeDirectRuns = async () => {
        // Direct mode keeps no engine state across a restart, so an event Run that was running
        // is ended; left active, it would hold its session's next event for ever.
        const stranded = store.database.db
          .query<{ id: RunId; session_id: string }, []>(
            `SELECT id, session_id FROM runs
             WHERE origin = 'event' AND engine != 'script' AND status = 'running'`,
          )
          .all();
        for (const { id, session_id: sessionId } of stranded) {
          const detail =
            "The server restarted while this Run was running; direct mode cannot resume it.";
          const finished = await store.finishRun({
            runId: id,
            status: "interrupted",
            terminalEvent: {
              chunkKey: `${id}:terminal`,
              chunk: {
                type: "RUN_ERROR",
                message: detail,
                code: "run.server_restarted",
                runId: id,
                threadId: sessionId,
              },
            },
            detail,
          });
          if (finished.won) {
            await finishRun(finished.run);
          }
        }
        // An event Run still queued was admitted and never started (a crash after admission).
        const resumable = store.database.db
          .query<{ id: RunId }, []>(
            `SELECT id FROM runs
             WHERE (engine = 'script' AND status IN ('queued', 'running', 'waiting_approval'))
                OR (origin = 'event' AND status = 'queued')`,
          )
          .all();
        for (const { id } of resumable) {
          await directDriver.start?.(id);
        }
      };
      closeDirectDriver = () => directDriver.close();
      routineSchedule = createDirectRoutineScheduleClient({
        routines,
        engines,
        now: clockNow,
        admitRun: async (input) => {
          const admitted = await coordinator.admit({
            botId: input.botId,
            sessionId: input.sessionId,
            origin: "routine",
            idempotencyKey: `routine:${input.routineId}:${input.routineSlot}`,
            engine: input.engine,
            input: { parts: [{ type: "text", text: input.text }] },
            routineId: input.routineId,
            routineSlot: input.routineSlot,
          });
          return { runId: admitted.run.id };
        },
      });
    } else {
      const restateDriver = createRestateWorkflowDriver(config.restateIngressUrl);
      coordinator = createRunCoordinator({
        store,
        engines,
        turns,
        driver: restateDriver,
        approvalTimeoutMs: config.approvalTimeoutMs,
        now: clockNow,
        onRunFinished: finishRun,
        scriptRoutines,
      });
      routineSchedule = createRoutineScheduleClient(config.restateIngressUrl);

      const extraServices = [...(options.extraRestateServices ?? [])];
      if (!hasRestateServiceNamed(extraServices, "RoutineSchedule")) {
        extraServices.push(
          createRoutineScheduleObject({
            store,
            routines,
            engines,
            ...(options.now ? { now: options.now } : {}),
          }),
        );
      }

      const restateFetchHandler = createRestateFetchHandler(coordinator, extraServices);
      restateServer = Bun.serve({
        hostname: config.restateHost,
        port: config.restateListen,
        idleTimeout: 0,
        fetch: (request) => restateFetchHandler(request),
      });
    }

    deliverEvents = createEventDelivery({
      store,
      bots: store,
      admit: (request) => coordinator.admit(request),
      maxResultBytes: config.scriptResultBytes,
      logError: (error) => console.error("Event delivery error", error),
    });

    const loadRunInput = createContextLoader({
      store,
      memory,
      skills,
      coordinator,
      maxTokens: config.contextMaxTokens,
      engines,
      engineModels: config.engineModels,
      turns,
      caps: {
        memoryMaxBytes: config.memoryPromptMaxBytes,
        skillCatalogMaxBytes: config.skillCatalogMaxBytes,
      },
      codeMode: {
        catalog,
        scriptRunStore,
        scriptDriver,
        maxResultBytes: config.scriptResultBytes,
        inlineWaitMs: config.scriptInlineWaitMs,
      },
    });

    if (options.engines === undefined) {
      const requested = new Set<EngineKind>(config.enabledEngines);
      if (config.seedFixture) {
        requested.add("fixture");
      }
      for (const kind of requested) {
        if (kind === "fixture") {
          engines.set("fixture", createFixtureEngine(store, loadRunInput, closing.signal));
        } else {
          engines.set(
            kind,
            buildOfficialEngine({
              kind,
              config,
              workspaceHostPath,
              loadRunInput,
              runner,
              ...(options.probeEngineAuth !== undefined
                ? { probeEngineAuth: options.probeEngineAuth }
                : {}),
            }),
          );
        }
      }
    } else if (config.seedFixture && !engines.has("fixture")) {
      engines.set("fixture", createFixtureEngine(store, loadRunInput, closing.signal));
    }
    // Resumed Runs look up their engine when they start, so every engine is registered first.
    await resumeDirectRuns?.();

    const httpApp = createHttpApp({
      bots: store,
      sessions: store,
      runs: store,
      approvals: store,
      memory,
      routines,
      skills,
      catalog,
      workflow: coordinator,
      scriptDriver,
      routineSchedule,
      engines,
      config,
      now: clockNow,
      ...(options.extraHttpHandler ? { extraHttpHandler: options.extraHttpHandler } : {}),
    });

    const startedHttpServer = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: httpApp.fetch,
    });
    httpServer = startedHttpServer;

    const outboxSinks = new Map<string, OutboxSink>();
    for (const sink of integrationRegistry?.listOutboxSinks() ?? []) {
      outboxSinks.set(sink.kind, sink);
    }
    for (const sink of options.outboxSinks ?? []) {
      outboxSinks.set(sink.kind, sink);
    }

    const startedOutbox = createOutboxSender({
      store,
      listDestinations: () => store.listOutboxDestinations(),
      sinks: outboxSinks,
      pollIntervalMs: config.outboxPollIntervalMs,
      initialBackoffMs: config.outboxInitialBackoffMs,
      maxBackoffMs: config.outboxMaxBackoffMs,
      now: clockNow,
      onError: (error) => {
        console.error(
          `outbox delivery error: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
    outbox = startedOutbox;
    if (outboxSinks.size > 0) {
      startedOutbox.start();
    }

    const commands: ServerCommands = {
      admitRun: (request) => coordinator.admit(request),
      decideApproval: async (decision, channelIntake) =>
        (await scriptDriver.decide(decision, channelIntake)) ??
        coordinator.decide(decision, channelIntake),
      configureRoutine: (routineId, input) => routineSchedule.configure(routineId, input),
      listBots: () => store.listBots(),
      listSessions: (botId) => store.listSessions(botId),
      listMessages: (sessionId, opts) => store.listMessages(sessionId, opts),
      getRun: (runId) => {
        const run = store.getRun(runId);
        if (!run) {
          return undefined;
        }
        return {
          run,
          approval: store.getLatestApprovalForRun(runId) ?? null,
        };
      },
      readMemory: (botId, version) => memory.read(botId, version),
      writeMemory: (input) => memory.write(input),
      listSkills: () => skills.listSkills(),
      listRoutines: (botId) => routines.listRoutines(botId),
      diagnoseEngines: async () => {
        const results: EngineReadiness[] = [];
        for (const [kind, engine] of engines.entries()) {
          if (engine.diagnose) {
            results.push(await engine.diagnose());
          } else {
            results.push({
              engine: kind,
              interactive: "ready",
              unattended: "unverified",
              isolationVerified: false,
              reasons: ["Engine diagnostics not configured."],
            });
          }
        }
        return results;
      },
      listOutboxEvents: (filter) => store.listOutboxEvents(filter),
      upsertChannelBinding: (input) => store.upsertChannelBinding(input),
      listChannelBindings: (filter) => store.listChannelBindings(filter),
    };

    scriptDriver.start();

    const restateUrl =
      restateServer !== undefined
        ? `http://${config.restateHost}:${restateServer.port}`
        : undefined;

    return {
      config,
      store,
      memory,
      routines,
      skills,
      catalog,
      scriptRunStore,
      scriptDriver,
      engines,
      coordinator,
      workflow: coordinator,
      routineSchedule,
      outbox: startedOutbox,
      commands,
      url: `http://${config.host}:${startedHttpServer.port}`,
      ...(restateUrl !== undefined ? { restateUrl } : {}),
      ...(seededFixture ? { seededFixture } : {}),
      async close() {
        const errors: unknown[] = [];
        const runStep = async (step: () => Promise<void> | void) => {
          try {
            await step();
          } catch (error) {
            errors.push(error);
          }
        };

        closing.abort();
        await runStep(() => startedOutbox.stop());
        await runStep(() => closeScriptDriver?.());
        await runStep(() => closeDirectDriver?.());
        await runStep(() => integrationRegistry?.stop());
        await runStep(() => startedHttpServer.stop(true));
        await runStep(() => restateServer?.stop(true));
        if (ownsStore) {
          await runStep(() => {
            store.close();
          });
        }

        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, "Failed to close server cleanly");
        }
      },
    };
  } catch (error) {
    await outbox?.stop().catch(() => undefined);
    await closeScriptDriver?.().catch(() => undefined);
    try {
      closeDirectDriver?.();
    } catch {
      // best-effort startup rollback
    }
    await integrationRegistry?.stop().catch(() => undefined);
    await httpServer?.stop(true).catch(() => undefined);
    await restateServer?.stop(true).catch(() => undefined);
    if (ownsStore) {
      store.close();
    }
    throw error;
  }
}

if (import.meta.main) {
  const running = await startServer();
  await running.memory.reconcile();
  console.log(
    running.restateUrl !== undefined
      ? `der server listening on ${running.url} (restate fetch on ${running.restateUrl})`
      : `der server listening on ${running.url} (direct workflow mode)`,
  );

  if (running.config.restateMode === "restate" && running.config.restateAutoRegister) {
    const deploymentUrl = running.config.restateDeploymentUrl ?? running.restateUrl;
    if (deploymentUrl !== undefined) {
      registerDeploymentWithRestate({
        adminUrl: running.config.restateAdminUrl,
        deploymentUrl,
      })
        .then((registered) => {
          console.log(`registered restate deployment ${registered.id} -> ${deploymentUrl}`);
        })
        .catch((error) => {
          console.error(
            `restate deployment registration failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  const shutdown = () => {
    void running.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
