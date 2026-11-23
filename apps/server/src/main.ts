import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod";
import {
  defineIntegration,
  defineTool,
  IntegrationRegistry,
  sandboxRequest,
  type Approval,
  type ApprovalResolutionInput,
  type Bot,
  type BotId,
  type ChannelBinding,
  type ChannelIntakeMetadata,
  type EffectIdentity,
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
  type Sandbox,
  type Session,
  type SessionId,
  type Skill,
  type ToolResult,
  type Tools,
} from "@der/domain";
import type { AnyTool } from "@tanstack/ai";
import { compiledParsers } from "@der/domain/compiled";
import {
  createMcpIntegration,
  deniedToolResult,
  effectIdentityMatches,
  type ApprovalVerifier,
} from "@der/mcp";
import { buildRunContext, createSkillCatalog, type SkillCatalog } from "@der/runtime/context";
import {
  createAntigravityEngine,
  createClaudeCodeEngine,
  createCodexEngine,
  DEFAULT_TERMS_COVERAGE,
  diagnoseEngine,
  digestJson,
  normalizeToJsonValue,
  type ApprovalBroker,
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
import { parseServerConfig, type ServerConfig } from "./config";
import { createHttpApp, type ExtraHttpHandler } from "./http/index";
import { createOutboxSender, type OutboxSender } from "./messaging/index";
import {
  createDirectRoutineScheduleClient,
  createDirectWorkflowDriver,
  createFixtureEngine,
  createFixtureTools,
  createRestateFetchHandler,
  createRestateWorkflowDriver,
  createRoutineScheduleClient,
  createRoutineScheduleObject,
  createRunCoordinator,
  executeApprovedEffectStep,
  finalizeInterruptedUncertainStep,
  UncertainEffectError,
  type AnyRestateService,
  type ConfigureRoutineInput,
  type ConfigureRoutineResult,
  type DurableWorkflow,
  type RoutineScheduleClient,
  type RunCoordinator,
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
  readonly integrations?: readonly Integration[];
  readonly skills?: SkillCatalog;
  readonly commandRunner?: CommandRunner;
  readonly probeEngineAuth?: (engine: OfficialEngineKind) => Promise<EngineAuthProbeResult>;
  readonly extraRestateServices?: readonly AnyRestateService[];
  readonly extraHttpHandler?: ExtraHttpHandler;
  readonly reconcileEffect?: (effect: EffectIdentity) => Promise<ToolResult | undefined>;
  readonly outboxSinks?: readonly OutboxSink[];
}

export interface RunningServer {
  readonly config: ServerConfig;
  readonly store: SqliteStore;
  readonly memory: SqliteMemory;
  readonly routines: SqliteRoutines;
  readonly skills: SkillCatalog;
  readonly tools: Tools;
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

function createStoreApprovalVerifier(store: SqliteStore): ApprovalVerifier {
  return (effect: EffectIdentity): boolean => {
    const approval = store.getLatestApprovalForRun(effect.runId);
    if (!approval || approval.decision.status !== "approved") {
      return false;
    }
    return effectIdentityMatches(approval.effect, effect);
  };
}

const fixtureToolInputSchema = z.record(z.string(), z.unknown());

function createFixtureIntegration(): Integration {
  const fixtureTools = createFixtureTools();
  return defineIntegration({
    id: "fixture",
    setup() {
      return {
        tools: [
          defineTool({
            id: "fixture.apply",
            operationKind: "fixture",
            name: "Fixture Apply",
            description: "Applies one deterministic credential-free fixture effect.",
            inputSchema: fixtureToolInputSchema,
            descriptorInputSchema: {
              type: "object",
              properties: {
                target: { type: "string" },
                mode: { type: "string" },
              },
            },
            approval: "always",
            execute: async (_input, ctx) => fixtureTools.invoke({ effect: ctx.effect }),
          }),
          defineTool({
            id: "fixture.uncertain",
            operationKind: "fixture",
            name: "Fixture Uncertain",
            description: "Simulates a dispatched effect whose upstream response is lost.",
            inputSchema: fixtureToolInputSchema,
            descriptorInputSchema: {
              type: "object",
              properties: {
                target: { type: "string" },
                mode: { type: "string" },
              },
            },
            approval: "always",
            execute: async (_input, ctx) => fixtureTools.invoke({ effect: ctx.effect }),
          }),
        ],
      };
    },
  });
}

function createSandboxIntegration(input: {
  readonly kind: "docker" | "wasmer";
  readonly descriptor: typeof DOCKER_TOOL_DESCRIPTOR;
  readonly sandbox: Sandbox;
  readonly verifyApproval: ApprovalVerifier;
}): Integration {
  return defineIntegration({
    id: `sandbox.${input.kind}`,
    setup() {
      return {
        tools: [
          defineTool({
            id: input.descriptor.id,
            operationKind: input.kind,
            name: input.descriptor.name,
            description: input.descriptor.description,
            inputSchema: sandboxRequest,
            descriptorInputSchema: input.descriptor.inputSchema,
            approval: "always",
            execute: async (parsedRequest, ctx) => {
              const authorized = await input.verifyApproval(ctx.effect);
              if (!authorized) {
                return deniedToolResult(
                  "tool.approval_required",
                  `Exact-operation approval is required for ${input.descriptor.id}.`,
                );
              }
              const result = await input.sandbox.execute(parsedRequest);
              return compiledParsers.toolResult.parse({
                ok: result.exitCode === 0 && !result.timedOut,
                isError: result.exitCode !== 0 || result.timedOut,
                outcome: result,
                ...(result.timedOut
                  ? { detail: `${input.kind} sandbox execution timed out.` }
                  : {}),
              });
            },
          }),
        ],
      };
    },
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

export async function buildEngineHostTools(input: {
  readonly run: Run;
  readonly store: SqliteStore;
  readonly tools: Tools;
  readonly approvalBroker: ApprovalBroker;
  readonly reconcileEffect?: (effect: EffectIdentity) => Promise<ToolResult | undefined>;
}): Promise<Array<AnyTool>> {
  const descriptors = input.tools.list ? await input.tools.list() : [];

  return descriptors.map((descriptor): AnyTool => ({
    name: descriptor.id,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as AnyTool["inputSchema"],
    metadata: { requiresApproval: descriptor.requiresApproval },
    execute: async (rawArgs: unknown, ctx?: { readonly signal?: AbortSignal }) => {
      const canonicalArguments = normalizeToJsonValue(rawArgs ?? {});
      const canonicalArgsDigest = await digestJson(canonicalArguments);
      const effectDigest = await digestJson({
        runId: input.run.id,
        operationKind: descriptor.kind,
        operationId: descriptor.id,
        canonicalArgsDigest,
      });
      const effect: EffectIdentity = {
        runId: input.run.id,
        operationKind: descriptor.kind,
        operationId: descriptor.id,
        canonicalArguments,
        attemptId: `${input.run.id}:tool:${effectDigest}`,
      };

      if (descriptor.requiresApproval) {
        const decision = await input.approvalBroker.requestApproval({
          effect,
          prompt: `Approve host tool ${descriptor.id}?`,
          signal: ctx?.signal ?? new AbortController().signal,
        });
        if (decision.status !== "approved") {
          return deniedToolResult(
            "tool.approval_required",
            decision.status === "expired"
              ? `Approval expired for host tool "${descriptor.id}".`
              : `Operator denied host tool "${descriptor.id}".`,
          );
        }

        const stepOutcome = await executeApprovedEffectStep(
          {
            store: input.store,
            tools: input.tools,
            ...(input.reconcileEffect ? { reconcileEffect: input.reconcileEffect } : {}),
          },
          {
            run: input.run,
            approvalId: decision.approvalId,
            effect,
          },
        );
        if (stepOutcome.kind === "uncertain") {
          await finalizeInterruptedUncertainStep(
            { store: input.store },
            {
              run: input.run,
              effectId: stepOutcome.effectId,
              detail: stepOutcome.detail,
            },
          );
          throw new UncertainEffectError(stepOutcome.detail);
        }
        return stepOutcome.toolResult;
      }

      return input.tools.invoke({ effect });
    },
  }));
}

function createContextLoader(input: {
  readonly store: SqliteStore;
  readonly memory: SqliteMemory;
  readonly skills: SkillCatalog;
  readonly tools: Tools;
  readonly coordinator: RunCoordinator;
  readonly reconcileEffect?: (effect: EffectIdentity) => Promise<ToolResult | undefined>;
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

    const approvalBroker = input.coordinator.createApprovalBroker(run);

    const hostTools = await buildEngineHostTools({
      run,
      store: input.store,
      tools: input.tools,
      approvalBroker,
      ...(input.reconcileEffect ? { reconcileEffect: input.reconcileEffect } : {}),
    });

    return {
      messages: [...built.messages],
      systemPrompts: [...built.systemPrompts],
      tools: hostTools,
      approvalBroker,
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

  let integrationRegistry: IntegrationRegistry | undefined;
  let closeDirectDriver: (() => void) | undefined;
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

    let tools: Tools;
    if (options.tools !== undefined) {
      tools = options.tools;
    } else {
      const verifyApproval = createStoreApprovalVerifier(store);
      integrationRegistry = new IntegrationRegistry({ verifyApproval });

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
      integrationRegistry.registerSync(
        createSandboxIntegration({
          kind: "docker",
          descriptor: DOCKER_TOOL_DESCRIPTOR,
          sandbox: dockerSandbox,
          verifyApproval,
        }),
      );

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
      integrationRegistry.registerSync(
        createSandboxIntegration({
          kind: "wasmer",
          descriptor: WASMER_TOOL_DESCRIPTOR,
          sandbox: wasmerSandbox,
          verifyApproval,
        }),
      );

      if (config.mcpServers.length > 0) {
        integrationRegistry.registerSync(
          createMcpIntegration({
            servers: toMcpServerConfigs(config.mcpServers),
            verifyApproval,
          }),
        );
      }

      for (const integration of options.integrations ?? []) {
        await integrationRegistry.register(integration);
      }

      await integrationRegistry.start();
      tools = integrationRegistry;
    }

    const engines = new Map<EngineKind, Engine>(options.engines);
    const clockNow = options.now ?? (() => store.database.now());

    let coordinator: RunCoordinator;
    let routineSchedule: RoutineScheduleClient;

    if (config.restateMode === "direct") {
      const directDriver = createDirectWorkflowDriver({ now: clockNow });
      coordinator = createRunCoordinator({
        store,
        engines,
        tools,
        driver: directDriver,
        approvalTimeoutMs: config.approvalTimeoutMs,
        now: clockNow,
        ...(options.reconcileEffect ? { reconcileEffect: options.reconcileEffect } : {}),
      });
      directDriver.setRunner((runId) => coordinator.executeRun(runId, directDriver));
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
            input: { parts: [{ type: "text", text: input.prompt }] },
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
        tools,
        driver: restateDriver,
        approvalTimeoutMs: config.approvalTimeoutMs,
        now: clockNow,
        ...(options.reconcileEffect ? { reconcileEffect: options.reconcileEffect } : {}),
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
        fetch: (request) => restateFetchHandler(request),
      });
    }

    const loadRunInput = createContextLoader({
      store,
      memory,
      skills,
      tools,
      coordinator,
      ...(options.reconcileEffect ? { reconcileEffect: options.reconcileEffect } : {}),
      maxTokens: config.contextMaxTokens,
    });

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
              ...(options.probeEngineAuth !== undefined
                ? { probeEngineAuth: options.probeEngineAuth }
                : {}),
            }),
          );
        }
      }
    } else if (config.seedFixture && !engines.has("fixture")) {
      engines.set("fixture", createFixtureEngine(store));
    }

    const httpApp = createHttpApp({
      bots: store,
      sessions: store,
      runs: store,
      approvals: store,
      memory,
      routines,
      skills,
      tools,
      workflow: coordinator,
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
      decideApproval: (decision, channelIntake) => coordinator.decide(decision, channelIntake),
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
      tools,
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

        await runStep(() => startedOutbox.stop());
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
