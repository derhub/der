import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Approval,
  ApprovalResolutionInput,
  Bot,
  BotId,
  ChannelBinding,
  ChannelIntakeMetadata,
  ChannelIntegration,
  EffectIdentity,
  Engine,
  EngineKind,
  EngineReadiness,
  MemoryRecord,
  MemoryWriteInput,
  Message,
  Messaging,
  OutboxEvent,
  Routine,
  RoutineId,
  Run,
  RunAdmission,
  RunId,
  RunRequest,
  Sandbox,
  Session,
  SessionId,
  Skill,
  ToolOperation,
  ToolResult,
  Tools,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import {
  createHomeAssistantTools,
  createHostTools,
  createMcpTools,
  deniedToolResult,
  effectIdentityMatches,
  type ApprovalVerifier,
  type McpToolsHandle,
} from "@der/mcp";
import { buildRunContext, createSkillCatalog, type SkillCatalog } from "@der/runtime/context";
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
  createHardenedDockerProvider,
  createWasmerSandbox,
  DEFAULT_ENGINE_SHADOW_HOMES,
  DOCKER_TOOL_DESCRIPTOR,
  WASMER_TOOL_DESCRIPTOR,
  type CommandRunner,
  type DockerNetworkPolicy,
  type OfficialEngineKind,
} from "@der/runtime/sandbox";
import {
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
import {
  createTelegramMessaging,
  redactTelegramSecret,
  type TelegramMessaging,
} from "@der/telegram";
import { parseServerConfig, type ServerConfig } from "./config";
import { createHttpHandler, type ExtraHttpHandler } from "./http/index";
import {
  createMessagingRuntime,
  type ChannelCallbackAcknowledger,
  type MessagingRuntime,
} from "./messaging/index";
import {
  createDirectRoutineScheduleClient,
  createDirectWorkflow,
  createFixtureEngine,
  createFixtureTools,
  createRestateFetchHandler,
  createRestateWorkflowClient,
  createRoutineScheduleClient,
  createRoutineScheduleObject,
  type AnyRestateService,
  type ConfigureRoutineInput,
  type ConfigureRoutineResult,
  type DurableWorkflow,
  type RoutineScheduleClient,
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
  readonly tools?: Tools;
  readonly skills?: SkillCatalog;
  readonly commandRunner?: CommandRunner;
  readonly extraRestateServices?: readonly AnyRestateService[];
  readonly extraHttpHandler?: ExtraHttpHandler;
  readonly reconcileEffect?: (effect: EffectIdentity) => Promise<ToolResult | undefined>;
  readonly telegramMessaging?: TelegramMessaging;
}

export interface RunningServer {
  readonly config: ServerConfig;
  readonly store: SqliteStore;
  readonly memory: SqliteMemory;
  readonly routines: SqliteRoutines;
  readonly skills: SkillCatalog;
  readonly tools: Tools;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly workflow: DurableWorkflow;
  readonly routineSchedule: RoutineScheduleClient;
  readonly messaging?: MessagingRuntime;
  readonly commands: ServerCommands;
  readonly url: string;
  readonly restateUrl: string;
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

function createStoreApprovalVerifier(store: SqliteStore): ApprovalVerifier {
  return (effect: EffectIdentity): boolean => {
    const approval = store.getLatestApprovalForRun(effect.runId);
    if (!approval || approval.decision.status !== "approved") {
      return false;
    }
    return effectIdentityMatches(approval.effect, effect);
  };
}

function createSandboxToolsAdapter(input: {
  readonly kind: "docker" | "wasmer";
  readonly descriptor: typeof DOCKER_TOOL_DESCRIPTOR;
  readonly sandbox: Sandbox;
  readonly verifyApproval: ApprovalVerifier;
}): Tools {
  return {
    async list() {
      return [input.descriptor];
    },
    async invoke(operation: ToolOperation): Promise<ToolResult> {
      const parsedOp = compiledParsers.toolOperation.safeParse(operation);
      if (!parsedOp.success) {
        return deniedToolResult(
          "tool.invalid_arguments",
          `Invalid sandbox tool operation: ${parsedOp.error.message}`,
        );
      }
      const { effect } = parsedOp.data;
      if (effect.operationKind !== input.kind || effect.operationId !== input.descriptor.id) {
        return deniedToolResult(
          "tool.unrecognized_operation",
          `Operation "${effect.operationKind}:${effect.operationId}" is not handled by ${input.kind} sandbox.`,
        );
      }
      const authorized = await input.verifyApproval(effect);
      if (!authorized) {
        return deniedToolResult(
          "tool.approval_required",
          `Exact-operation approval is required for ${input.descriptor.id}.`,
        );
      }
      const parsedRequest = compiledParsers.sandboxRequest.safeParse(effect.canonicalArguments);
      if (!parsedRequest.success) {
        return deniedToolResult(
          "tool.invalid_arguments",
          `Invalid ${input.kind} sandbox request arguments: ${parsedRequest.error.message}`,
        );
      }
      const result = await input.sandbox.execute(parsedRequest.data);
      return compiledParsers.toolResult.parse({
        ok: result.exitCode === 0 && !result.timedOut,
        isError: result.exitCode !== 0 || result.timedOut,
        outcome: result,
        ...(result.timedOut ? { detail: `${input.kind} sandbox execution timed out.` } : {}),
      });
    },
  };
}

function createShadowHomeAuthProbe(
  engine: OfficialEngineKind,
  config: ServerConfig,
  runner: CommandRunner,
): () => Promise<EngineAuthProbeResult> {
  const shadowHome = DEFAULT_ENGINE_SHADOW_HOMES[engine];
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
      return {
        authenticated: false,
        detail: `Shadow-home volume "${shadowHome.volumeName}" exists, but interactive login verification has not been completed.`,
      };
    } catch (error) {
      return {
        authenticated: false,
        detail: `Shadow-home probe failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

function createContextLoader(input: {
  readonly store: SqliteStore;
  readonly memory: SqliteMemory;
  readonly skills: SkillCatalog;
  readonly maxTokens: number;
}): LoadEngineRunInput {
  return async (run: Run) => {
    const bot = input.store.getBot(run.botId);
    const messages = input.store.listMessages(run.sessionId, { limit: 200 });
    const [memoryRecord, skillList] = await Promise.all([
      input.memory.read(run.botId),
      input.skills.listSkills(),
    ]);

    const built = await buildRunContext({
      bot: bot ?? { id: run.botId, name: run.botId, persona: "" },
      ...(memoryRecord !== undefined ? { memory: memoryRecord } : {}),
      skills: skillList,
      messages,
      compaction: {
        maxTokens: input.maxTokens,
        threadId: run.sessionId,
      },
    });

    return {
      messages: [...built.messages],
      systemPrompts: [...built.systemPrompts],
    };
  };
}

function buildOfficialEngine(input: {
  readonly kind: OfficialEngineKind;
  readonly config: ServerConfig;
  readonly workspaceHostPath: string;
  readonly loadRunInput: LoadEngineRunInput;
  readonly runner: CommandRunner;
}): Engine {
  const shadowHome = DEFAULT_ENGINE_SHADOW_HOMES[input.kind];
  const network: DockerNetworkPolicy =
    input.config.dockerEgressNetwork !== undefined
      ? {
          mode: "scoped_egress",
          networkName: input.config.dockerEgressNetwork,
          allowedHosts: APPROVED_VENDOR_EGRESS[input.kind],
        }
      : { mode: "none" };

  const image =
    input.kind === "codex"
      ? input.config.engineImages.codex
      : input.kind === "claude-code"
        ? input.config.engineImages.claudeCode
        : input.config.engineImages.antigravity;

  const sandboxProvider = createHardenedDockerProvider({
    dockerHost: input.config.dockerHost,
    dockerBinary: input.config.dockerBinary,
    image,
    engine: input.kind,
    user: input.config.dockerUser,
    workspaceHostPath: input.workspaceHostPath,
    shadowHome,
    network,
    limits: {
      cpus: input.config.dockerCpus,
      memoryMb: input.config.dockerMemoryMb,
      pidsLimit: input.config.dockerPidsLimit,
    },
    runner: input.runner,
  });

  const diagnose = () =>
    diagnoseEngine({
      engine: input.kind,
      dockerHost: input.config.dockerHost,
      dockerBinary: input.config.dockerBinary,
      terms: DEFAULT_TERMS_COVERAGE[input.kind],
      runner: input.runner,
      probeAuth: createShadowHomeAuthProbe(input.kind, input.config, input.runner),
    });

  if (input.kind === "codex") {
    return createCodexEngine({
      model: input.config.engineModels.codex as Parameters<typeof createCodexEngine>[0]["model"],
      sandboxProvider,
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
      diagnose,
      loadRunInput: input.loadRunInput,
    });
  }

  return createAntigravityEngine({
    model: input.config.engineModels.antigravity,
    sandboxProvider,
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

export function startServer(options: CreateServerOptions = {}): RunningServer {
  const config = parseServerConfig(options.config);
  const ownsStore = options.store === undefined;
  const store =
    options.store ??
    openSqliteStore({
      filename: config.databasePath,
      extraMigrations: mergeMigrations(options.extraMigrations),
      ...(options.now ? { now: options.now } : {}),
    });

  const projection = createMemoryProjection(config.memoryProjectionDir);
  const memory = openSqliteMemory({ database: store.database, projection });
  const routines = openSqliteRoutines({ database: store.database });
  const skills = options.skills ?? createSkillCatalog({ rootDir: config.skillsRootDir });
  const workspaceHostPath = resolve(config.workspaceRootDir);
  mkdirSync(workspaceHostPath, { recursive: true });

  const seededFixture = config.seedFixture ? seedFixtureRecords(store) : undefined;
  const runner = options.commandRunner ?? bunCommandRunner;
  const loadRunInput = createContextLoader({
    store,
    memory,
    skills,
    maxTokens: config.contextMaxTokens,
  });

  const engines = new Map<EngineKind, Engine>(options.engines);
  if (options.engines === undefined) {
    const requested = new Set<EngineKind>(config.enabledEngines);
    if (config.seedFixture) {
      requested.add("fixture");
    }
    for (const kind of requested) {
      if (kind === "fixture") {
        engines.set("fixture", createFixtureEngine(store));
      } else {
        engines.set(
          kind,
          buildOfficialEngine({
            kind,
            config,
            workspaceHostPath,
            loadRunInput,
            runner,
          }),
        );
      }
    }
  } else if (config.seedFixture && !engines.has("fixture")) {
    engines.set("fixture", createFixtureEngine(store));
  }

  let mcpHandle: McpToolsHandle | undefined;
  let tools: Tools;
  if (options.tools !== undefined) {
    tools = options.tools;
  } else {
    const verifyApproval = createStoreApprovalVerifier(store);
    const providers: Tools[] = [];

    if (engines.has("fixture")) {
      providers.push(createFixtureTools());
    }

    const dockerSandbox = createDockerSandbox({
      dockerHost: config.dockerHost,
      dockerBinary: config.dockerBinary,
      image: config.engineImages.codex,
      engine: "codex",
      user: config.dockerUser,
      workspaceHostPath,
      shadowHome: DEFAULT_ENGINE_SHADOW_HOMES.codex,
      ...(config.dockerEgressNetwork !== undefined
        ? {
            egressNetwork: {
              networkName: config.dockerEgressNetwork,
              allowedHosts: APPROVED_VENDOR_EGRESS.codex,
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
    providers.push(
      createSandboxToolsAdapter({
        kind: "docker",
        descriptor: DOCKER_TOOL_DESCRIPTOR,
        sandbox: dockerSandbox,
        verifyApproval,
      }),
    );

    const wasmerRoots =
      config.wasmerAllowedRoots.length > 0 ? config.wasmerAllowedRoots : [workspaceHostPath];
    const wasmerSandbox = createWasmerSandbox({
      allowedHostRoots: wasmerRoots,
      maxTimeoutMs: config.wasmerMaxTimeoutMs,
    });
    providers.push(
      createSandboxToolsAdapter({
        kind: "wasmer",
        descriptor: WASMER_TOOL_DESCRIPTOR,
        sandbox: wasmerSandbox,
        verifyApproval,
      }),
    );

    if (config.mcpServers.length > 0) {
      mcpHandle = createMcpTools({
        servers: toMcpServerConfigs(config.mcpServers),
        verifyApproval,
      });
      providers.push(mcpHandle);
    }

    if (config.homeAssistant !== undefined) {
      providers.push(
        createHomeAssistantTools({
          baseUrl: config.homeAssistant.baseUrl,
          token: config.homeAssistant.token,
          allowedServices: config.homeAssistant.allowedServices,
          ...(config.homeAssistant.allowedEntities !== undefined
            ? { allowedEntities: config.homeAssistant.allowedEntities }
            : {}),
          timeoutMs: config.homeAssistant.timeoutMs,
          verifyApproval,
        }),
      );
    }

    tools = createHostTools(providers);
  }

  const workflowDeps: WorkflowDeps = {
    store,
    engines,
    tools,
    approvalTimeoutMs: config.approvalTimeoutMs,
    ...(options.reconcileEffect ? { reconcileEffect: options.reconcileEffect } : {}),
  };

  let closeDirectWorkflow: (() => void) | undefined;
  let workflow: DurableWorkflow;
  let routineSchedule: RoutineScheduleClient;
  if (config.restateMode === "direct") {
    const direct = createDirectWorkflow(workflowDeps);
    workflow = direct;
    closeDirectWorkflow = direct.close;
    routineSchedule = createDirectRoutineScheduleClient({
      store,
      routines,
      engines,
      ...(options.now ? { now: options.now } : {}),
      admitRun: async (input) => {
        const admitted = await direct.admit({
          botId: input.botId,
          sessionId: input.sessionId,
          origin: "routine",
          idempotencyKey: `routine:${input.routineId}:${input.routineSlot}`,
          engine: input.engine,
          input: { parts: [{ type: "text", text: input.prompt }] },
          routineId: input.routineId,
          routineSlot: input.routineSlot,
        });
        return { runId: admitted.run.id };
      },
    });
  } else {
    workflow = createRestateWorkflowClient(config.restateIngressUrl);
    routineSchedule = createRoutineScheduleClient(config.restateIngressUrl);
  }

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

  const restateFetchHandler = createRestateFetchHandler(workflowDeps, extraServices);

  const restateServer = Bun.serve({
    hostname: config.restateHost,
    port: config.restateListen,
    fetch: (request) => restateFetchHandler(request),
  });

  const httpHandler = createHttpHandler({
    store,
    memory,
    routines,
    skills,
    tools,
    workflow,
    routineSchedule,
    engines,
    config,
    ...(options.extraHttpHandler ? { extraHttpHandler: options.extraHttpHandler } : {}),
  });

  const httpServer = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: httpHandler,
  });

  let telegramAbort: AbortController | undefined;
  let messagingRuntime: MessagingRuntime | undefined;
  const telegramConfig = config.telegram;

  if (telegramConfig !== undefined || options.telegramMessaging !== undefined) {
    if (telegramConfig !== undefined) {
      for (const configuredBinding of telegramConfig.bindings) {
        const targetSession = store.getSession(configuredBinding.sessionId);
        if (targetSession === undefined || targetSession.botId !== configuredBinding.botId) {
          console.warn(
            `skipping Telegram binding for session "${configuredBinding.sessionId}" and bot "${configuredBinding.botId}": session not found in bot scope`,
          );
          continue;
        }
        store.upsertChannelBinding({
          ...(configuredBinding.id !== undefined ? { id: configuredBinding.id } : {}),
          integration: "telegram",
          externalChatId: configuredBinding.externalChatId,
          externalActorId: configuredBinding.externalActorId,
          botId: configuredBinding.botId,
          sessionId: configuredBinding.sessionId,
          enabled: configuredBinding.enabled,
        });
      }
    }

    let telegramAdapter: TelegramMessaging | undefined;
    if (options.telegramMessaging !== undefined) {
      telegramAdapter = options.telegramMessaging;
    } else if (telegramConfig !== undefined) {
      telegramAbort = new AbortController();
      telegramAdapter = createTelegramMessaging({
        botToken: telegramConfig.botToken,
        apiBaseUrl: telegramConfig.apiBaseUrl,
        pollTimeoutSeconds: telegramConfig.pollTimeoutSeconds,
        initialBackoffMs: telegramConfig.pollInitialBackoffMs,
        maxBackoffMs: telegramConfig.pollMaxBackoffMs,
        ...(options.now ? { now: options.now } : {}),
        signal: telegramAbort.signal,
      });
    }

    if (telegramAdapter !== undefined) {
      const adapters = new Map<ChannelIntegration, Messaging & ChannelCallbackAcknowledger>([
        ["telegram", telegramAdapter],
      ]);

      messagingRuntime = createMessagingRuntime({
        store,
        workflow,
        adapters,
        telegramConsumer: telegramConfig?.consumer ?? "telegram-default",
        ...(telegramConfig !== undefined
          ? {
              pollRetryInitialBackoffMs: telegramConfig.pollInitialBackoffMs,
              pollRetryMaxBackoffMs: telegramConfig.pollMaxBackoffMs,
              outboxPollIntervalMs: telegramConfig.outboxPollIntervalMs,
              outboxInitialBackoffMs: telegramConfig.outboxInitialBackoffMs,
              outboxMaxBackoffMs: telegramConfig.outboxMaxBackoffMs,
            }
          : {}),
        ...(options.now ? { now: options.now } : {}),
        onError: (error) => {
          const rawMessage = error instanceof Error ? error.message : String(error);
          console.error(
            `telegram messaging error: ${redactTelegramSecret(rawMessage, telegramConfig?.botToken)}`,
          );
        },
      });
      messagingRuntime.start();
    }
  }

  const commands: ServerCommands = {
    admitRun: (request) => workflow.admit(request),
    decideApproval: (decision, channelIntake) => workflow.decide(decision, channelIntake),
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

  return {
    config,
    store,
    memory,
    routines,
    skills,
    tools,
    engines,
    workflow,
    routineSchedule,
    ...(messagingRuntime ? { messaging: messagingRuntime } : {}),
    commands,
    url: `http://${config.host}:${httpServer.port}`,
    restateUrl: `http://${config.restateHost}:${restateServer.port}`,
    ...(seededFixture ? { seededFixture } : {}),
    async close() {
      telegramAbort?.abort();
      await messagingRuntime?.stop();
      closeDirectWorkflow?.();
      await mcpHandle?.close();
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
  await running.memory.reconcile();
  console.log(`der server listening on ${running.url} (restate fetch on ${running.restateUrl})`);

  if (running.config.restateMode === "restate" && running.config.restateAutoRegister) {
    const deploymentUrl = running.config.restateDeploymentUrl ?? running.restateUrl;
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

  const shutdown = () => {
    void running.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
