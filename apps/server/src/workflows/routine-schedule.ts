import * as restate from "@restatedev/restate-sdk/fetch";
import * as clients from "@restatedev/restate-sdk-clients";
import { Cron } from "croner";
import {
  DomainError,
  formatUtcTimestamp,
  type BotId,
  type CreateRoutineInput,
  type Engine,
  type EngineKind,
  type MaybePromise,
  type Routine,
  type RoutineId,
  type RoutineSlot,
  type RoutineSlotDisposition,
  type RoutineStore,
  type RoutineTarget,
  type RunEngineKind,
  type RunId,
  type RunStore,
  type SessionId,
  type UtcTimestamp,
} from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import type { RunWorkflowDefinition } from "./restate-workflows";

const PROBLEM_MARKER = "__derProblem";

function toRestateTerminalError(error: unknown): never {
  if (error instanceof DomainError) {
    throw new restate.TerminalError(
      JSON.stringify({ [PROBLEM_MARKER]: error.toProblemDetails() }),
      { errorCode: error.status },
    );
  }
  throw error;
}

function tryExtractProblem(raw: string): DomainError | undefined {
  const candidates: string[] = [raw];
  try {
    const outer = JSON.parse(raw) as { message?: unknown };
    if (typeof outer.message === "string") {
      candidates.push(outer.message);
    }
  } catch {
    // Raw text may already hold embedded JSON.
  }

  for (const candidate of candidates) {
    const markerIndex = candidate.indexOf(`"${PROBLEM_MARKER}"`);
    const slice =
      markerIndex !== -1 ? candidate.slice(candidate.lastIndexOf("{", markerIndex)) : candidate;
    try {
      const parsed = JSON.parse(slice) as Record<string, unknown>;
      const validated = compiledParsers.problemDetails.safeParse(parsed[PROBLEM_MARKER]);
      if (validated.success) {
        return new DomainError(validated.data);
      }
    } catch {
      if (markerIndex !== -1) {
        const start = candidate.lastIndexOf("{", markerIndex);
        const end = candidate.lastIndexOf("}");
        if (start !== -1 && end > start) {
          try {
            const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
            const validated = compiledParsers.problemDetails.safeParse(parsed[PROBLEM_MARKER]);
            if (validated.success) {
              return new DomainError(validated.data);
            }
          } catch {
            // Fall through to generic Restate error mapping.
          }
        }
      }
    }
  }

  return undefined;
}

function mapRestateScheduleError(error: unknown, instance: string): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  if (error instanceof clients.HttpCallError) {
    const decoded = tryExtractProblem(error.responseText) ?? tryExtractProblem(error.message);
    if (decoded) {
      return decoded;
    }
    return new DomainError({
      type: "https://der.invalid/problems/restate-error",
      title: "Routine schedule command failed",
      status: error.status >= 400 && error.status <= 599 ? error.status : 502,
      detail: error.message || "Restate rejected the RoutineSchedule command.",
      instance,
      code: "restate.command_failed",
    });
  }
  return new DomainError({
    type: "https://der.invalid/problems/restate-unavailable",
    title: "Restate ingress unavailable",
    status: 503,
    detail:
      error instanceof Error
        ? `Restate ingress is unavailable: ${error.message}`
        : "Restate ingress is unavailable.",
    instance,
    code: "restate.unavailable",
  });
}

export function parseUtcCron(pattern: string, instance = "/api/routines"): Cron {
  try {
    const cron = new Cron(pattern, { timezone: "UTC", paused: true });
    if (cron.nextRun(new Date(0)) === null) {
      throw new Error("Cron pattern produces no future UTC execution slots.");
    }
    return cron;
  } catch (error) {
    throw new DomainError({
      type: "https://der.invalid/problems/routine-invalid-cron",
      title: "Invalid UTC cron expression",
      status: 400,
      detail:
        error instanceof Error
          ? `Cron expression "${pattern}" is invalid: ${error.message}`
          : `Cron expression "${pattern}" is invalid.`,
      instance,
      code: "routine.invalid_cron",
    });
  }
}

export function nextUtcSlotAfter(pattern: string, afterMs: number): UtcTimestamp | undefined {
  const cron = parseUtcCron(pattern);
  const next = cron.nextRun(new Date(afterMs));
  return next ? formatUtcTimestamp(next) : undefined;
}

export function resolveLatestDueUtcSlot(
  pattern: string,
  nowMs: number,
  afterExclusiveMs: number,
): UtcTimestamp | undefined {
  const cron = parseUtcCron(pattern);
  const referenceMs = Math.floor(nowMs / 1000) * 1000 + 500;
  const previous = cron.previousRuns(1, new Date(referenceMs));
  const candidate = previous[0];
  if (!candidate) {
    return undefined;
  }
  const candidateMs = candidate.getTime();
  if (candidateMs > nowMs || candidateMs <= afterExclusiveMs) {
    return undefined;
  }
  return formatUtcTimestamp(candidate);
}

export interface UnattendedEligibilityResult {
  readonly eligible: boolean;
  readonly reason?: string;
}

export async function checkUnattendedEligibility(
  engines: ReadonlyMap<EngineKind, Engine>,
  engineKind: RunEngineKind,
): Promise<UnattendedEligibilityResult> {
  if (engineKind === "script") {
    return { eligible: true };
  }
  const engine = engines.get(engineKind);
  if (!engine) {
    return {
      eligible: false,
      reason: `Engine "${engineKind}" is not registered on this server.`,
    };
  }
  if (!engine.diagnose) {
    return {
      eligible: false,
      reason: `Engine "${engineKind}" does not report readiness; unattended eligibility is unverified.`,
    };
  }

  const readiness = await engine.diagnose();
  if (!readiness.isolationVerified) {
    return {
      eligible: false,
      reason:
        readiness.reasons.join("; ") ||
        `Engine "${engineKind}" failed isolation verification for unattended execution.`,
    };
  }
  if (readiness.unattended !== "ready") {
    return {
      eligible: false,
      reason:
        readiness.reasons.join("; ") ||
        `Engine "${engineKind}" unattended eligibility is "${readiness.unattended}".`,
    };
  }

  return { eligible: true };
}

export type ConfigureRoutineInput =
  | ({
      readonly kind: "create";
      readonly botId: BotId;
      readonly sessionId: SessionId;
      readonly name: string;
      readonly cron: string;
      readonly enabled: boolean;
    } & RoutineTarget)
  | {
      readonly kind: "update";
      readonly name?: string;
      readonly cron?: string;
      readonly enabled?: boolean;
      readonly engine?: EngineKind;
      readonly prompt?: string;
      readonly script?: string;
      readonly expectedRevision?: number;
    };

function createRoutineInput(
  routineId: RoutineId,
  input: Extract<ConfigureRoutineInput, { readonly kind: "create" }>,
): CreateRoutineInput {
  const { kind: _kind, ...fields } = input;
  return { id: routineId, ...fields };
}

export function routineRunText(routine: Routine): string {
  return routine.engine === "script" ? `Run script routine "${routine.name}"` : routine.prompt;
}

export interface ConfigureRoutineResult {
  readonly routine: Routine;
  readonly nextSlot: UtcTimestamp | null;
}

export interface RoutineTickInput {
  readonly revision: number;
  readonly scheduledSlot?: UtcTimestamp;
  readonly nowOverride?: UtcTimestamp;
}

export type RoutineTickDisposition =
  | RoutineSlotDisposition
  | "not_due"
  | "already_recorded"
  | "disabled";

export interface RoutineTickResult {
  readonly routineId: RoutineId;
  readonly revision: number;
  readonly disposition: RoutineTickDisposition;
  readonly slot: UtcTimestamp | null;
  readonly runId: RunId | null;
  readonly nextSlot: UtcTimestamp | null;
}

export interface RoutineScheduleStore extends RoutineStore {
  updateRoutine(
    routineId: RoutineId,
    patch: {
      readonly name?: string;
      readonly cron?: string;
      readonly enabled?: boolean;
      readonly engine?: EngineKind;
      readonly prompt?: string;
      readonly script?: string;
      readonly expectedRevision?: number;
    },
  ): Promise<Routine>;
  hasActiveRun(sessionId: SessionId): MaybePromise<boolean>;
  getSlot(routineId: RoutineId, slot: UtcTimestamp): MaybePromise<RoutineSlot | undefined>;
  getLatestSlot(routineId: RoutineId): MaybePromise<RoutineSlot | undefined>;
  recordSlot(input: {
    readonly routineId: RoutineId;
    readonly slot: UtcTimestamp;
    readonly revision: number;
    readonly disposition: RoutineSlotDisposition;
    readonly runId: RunId | null;
  }): Promise<{ readonly inserted: boolean; readonly slot: RoutineSlot }>;
}

export interface RoutineScheduleDeps {
  readonly store?: RunStore;
  readonly getStore?: () => RunStore;
  readonly routines?: RoutineScheduleStore;
  readonly getRoutines?: () => RoutineScheduleStore;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly now?: () => Date;
  readonly scheduleDelayCapMs?: number;
}

const RunWorkflowApi: RunWorkflowDefinition = { name: "RunWorkflow" } as RunWorkflowDefinition;

export function createRoutineScheduleObject(deps: RoutineScheduleDeps) {
  function resolveStore(): RunStore {
    const resolved = deps.store ?? deps.getStore?.();
    if (!resolved) {
      throw new Error("RoutineSchedule requires a RunStore instance.");
    }
    return resolved;
  }

  function resolveRoutines(): RoutineScheduleStore {
    const resolved = deps.routines ?? deps.getRoutines?.();
    if (!resolved) {
      throw new Error("RoutineSchedule requires a RoutineScheduleStore instance.");
    }
    return resolved;
  }

  function computeDelayMs(targetSlot: UtcTimestamp, nowMs: number): number {
    const raw = Math.max(0, Date.parse(targetSlot) - nowMs);
    return deps.scheduleDelayCapMs !== undefined ? Math.min(raw, deps.scheduleDelayCapMs) : raw;
  }

  const routineSchedule = restate.object({
    name: "RoutineSchedule",
    handlers: {
      configure: async (
        ctx: restate.ObjectContext,
        input: ConfigureRoutineInput,
      ): Promise<ConfigureRoutineResult> => {
        const routineId = ctx.key;
        const routine = await ctx.run("configure-routine", async () => {
          try {
            const routines = resolveRoutines();
            if (input.kind === "create") {
              parseUtcCron(input.cron, `/api/bots/${input.botId}/routines`);
              if (input.enabled) {
                const eligibility = await checkUnattendedEligibility(deps.engines, input.engine);
                if (!eligibility.eligible) {
                  throw new DomainError({
                    type: "https://der.invalid/problems/routine-engine-ineligible",
                    title: "Engine is not eligible for unattended schedules",
                    status: 409,
                    detail:
                      eligibility.reason ??
                      `Engine "${input.engine}" is not eligible for scheduled execution.`,
                    instance: `/api/bots/${input.botId}/routines`,
                    code: "routine.engine_ineligible",
                  });
                }
              }
              return await routines.createRoutine(createRoutineInput(routineId, input));
            }

            const existing = await routines.getRoutine(routineId);
            if (!existing) {
              throw new DomainError({
                type: "https://der.invalid/problems/routine-not-found",
                title: "Routine not found",
                status: 404,
                detail: `Routine ${routineId} does not exist.`,
                instance: `/api/routines/${routineId}`,
                code: "routine.not_found",
              });
            }

            const targetCron = input.cron ?? existing.cron;
            const targetEngine = input.engine ?? existing.engine;
            const targetEnabled = input.enabled ?? existing.enabled;
            parseUtcCron(targetCron, `/api/routines/${routineId}`);

            if (targetEnabled) {
              const eligibility = await checkUnattendedEligibility(deps.engines, targetEngine);
              if (!eligibility.eligible) {
                throw new DomainError({
                  type: "https://der.invalid/problems/routine-engine-ineligible",
                  title: "Engine is not eligible for unattended schedules",
                  status: 409,
                  detail:
                    eligibility.reason ??
                    `Engine "${targetEngine}" is not eligible for scheduled execution.`,
                  instance: `/api/routines/${routineId}`,
                  code: "routine.engine_ineligible",
                });
              }
            }

            return await routines.updateRoutine(routineId, {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.cron !== undefined ? { cron: input.cron } : {}),
              ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
              ...(input.engine !== undefined ? { engine: input.engine } : {}),
              ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
              ...(input.script !== undefined ? { script: input.script } : {}),
              ...(input.expectedRevision !== undefined
                ? { expectedRevision: input.expectedRevision }
                : {}),
            });
          } catch (error) {
            toRestateTerminalError(error);
          }
        });

        ctx.set("revision", routine.revision);

        if (!routine.enabled) {
          ctx.set("scheduledSlot", null);
          return { routine, nextSlot: null };
        }

        const nowMs = deps.now
          ? await ctx.run("clock-now", () => deps.now!().getTime())
          : await ctx.date.now();
        const nextSlot = nextUtcSlotAfter(routine.cron, nowMs) ?? null;
        ctx.set("scheduledSlot", nextSlot);

        if (nextSlot !== null) {
          const delayMs = computeDelayMs(nextSlot, nowMs);
          ctx
            .objectSendClient(routineSchedule, routine.id)
            .tick(
              { revision: routine.revision, scheduledSlot: nextSlot },
              restate.rpc.sendOpts({ delay: delayMs }),
            );
        }

        return { routine, nextSlot };
      },

      tick: async (
        ctx: restate.ObjectContext,
        input: RoutineTickInput,
      ): Promise<RoutineTickResult> => {
        const routineId = ctx.key;
        const routine = await ctx.run(
          "load-routine",
          async () => (await resolveRoutines().getRoutine(routineId)) ?? null,
        );
        const stateRevision = await ctx.get<number>("revision");

        if (!routine) {
          return {
            routineId,
            revision: input.revision,
            disposition: "skipped_obsolete_revision",
            slot: input.scheduledSlot ?? null,
            runId: null,
            nextSlot: null,
          };
        }

        if (!routine.enabled) {
          return {
            routineId,
            revision: input.revision,
            disposition: "disabled",
            slot: input.scheduledSlot ?? null,
            runId: null,
            nextSlot: null,
          };
        }

        if (
          input.revision !== routine.revision ||
          (stateRevision !== null && input.revision !== stateRevision)
        ) {
          return {
            routineId,
            revision: input.revision,
            disposition: "skipped_obsolete_revision",
            slot: input.scheduledSlot ?? null,
            runId: null,
            nextSlot: null,
          };
        }

        const nowMs =
          input.nowOverride !== undefined
            ? Date.parse(input.nowOverride)
            : deps.now
              ? await ctx.run("clock-now", () => deps.now!().getTime())
              : await ctx.date.now();

        const dueCheck = await ctx.run("resolve-due-slot", async () => {
          const routines = resolveRoutines();
          const latestRecorded = await routines.getLatestSlot(routine.id);
          const afterExclusiveMs = latestRecorded
            ? Date.parse(latestRecorded.slot)
            : input.scheduledSlot !== undefined
              ? Date.parse(input.scheduledSlot) - 1000
              : Date.parse(routine.updatedAt) - 1000;

          const dueSlot = resolveLatestDueUtcSlot(routine.cron, nowMs, afterExclusiveMs);
          if (!dueSlot) {
            if (input.scheduledSlot !== undefined && Date.parse(input.scheduledSlot) <= nowMs) {
              const existing = await routines.getSlot(routine.id, input.scheduledSlot);
              if (existing) {
                return {
                  kind: "already_recorded" as const,
                  slot: existing.slot,
                  runId: existing.runId,
                };
              }
            }
            return { kind: "not_due" as const };
          }

          const existing = await routines.getSlot(routine.id, dueSlot);
          if (existing) {
            return {
              kind: "already_recorded" as const,
              slot: existing.slot,
              runId: existing.runId,
            };
          }

          return { kind: "due" as const, slot: dueSlot };
        });

        const scheduleNext = (afterMs: number): UtcTimestamp | null => {
          const nextSlot = nextUtcSlotAfter(routine.cron, afterMs) ?? null;
          ctx.set("scheduledSlot", nextSlot);
          if (nextSlot !== null) {
            const delayMs = computeDelayMs(nextSlot, nowMs);
            ctx
              .objectSendClient(routineSchedule, routine.id)
              .tick(
                { revision: routine.revision, scheduledSlot: nextSlot },
                restate.rpc.sendOpts({ delay: delayMs }),
              );
          }
          return nextSlot;
        };

        if (dueCheck.kind === "not_due") {
          const nextSlot = nextUtcSlotAfter(routine.cron, nowMs) ?? null;
          ctx.set("scheduledSlot", nextSlot);
          if (nextSlot !== null) {
            const delayMs = Math.max(10, computeDelayMs(nextSlot, nowMs));
            ctx
              .objectSendClient(routineSchedule, routine.id)
              .tick(
                { revision: routine.revision, scheduledSlot: nextSlot },
                restate.rpc.sendOpts({ delay: delayMs }),
              );
          }
          return {
            routineId,
            revision: routine.revision,
            disposition: "not_due",
            slot: null,
            runId: null,
            nextSlot,
          };
        }

        if (dueCheck.kind === "already_recorded") {
          const nextSlot = scheduleNext(Math.max(nowMs, Date.parse(dueCheck.slot)));
          return {
            routineId,
            revision: routine.revision,
            disposition: "already_recorded",
            slot: dueCheck.slot,
            runId: dueCheck.runId,
            nextSlot,
          };
        }

        const dueSlot = dueCheck.slot;
        const eligibility = await ctx.run("check-unattended-eligibility", () =>
          checkUnattendedEligibility(deps.engines, routine.engine),
        );

        if (!eligibility.eligible) {
          const recorded = await ctx.run("record-ineligible-slot", () =>
            resolveRoutines().recordSlot({
              routineId: routine.id,
              slot: dueSlot,
              revision: routine.revision,
              disposition: "blocked_ineligible",
              runId: null,
            }),
          );
          const nextSlot = scheduleNext(Math.max(nowMs, Date.parse(dueSlot)));
          return {
            routineId,
            revision: routine.revision,
            disposition: recorded.slot.disposition,
            slot: dueSlot,
            runId: recorded.slot.runId,
            nextSlot,
          };
        }

        const admissionOutcome = await ctx.run("admit-routine-slot", async () => {
          const store = resolveStore();
          const routines = resolveRoutines();

          const existing = await routines.getSlot(routine.id, dueSlot);
          if (existing) {
            return {
              disposition: existing.disposition,
              runId: existing.runId,
              shouldDispatch: false,
            };
          }

          if (await routines.hasActiveRun(routine.sessionId)) {
            const skipped = await routines.recordSlot({
              routineId: routine.id,
              slot: dueSlot,
              revision: routine.revision,
              disposition: "skipped_active_run",
              runId: null,
            });
            return {
              disposition: skipped.slot.disposition,
              runId: skipped.slot.runId,
              shouldDispatch: false,
            };
          }

          try {
            const admitted = await store.admit({
              botId: routine.botId,
              sessionId: routine.sessionId,
              origin: "routine",
              idempotencyKey: `routine:${routine.id}:${dueSlot}`,
              engine: routine.engine,
              input: {
                parts: [{ type: "text", text: routineRunText(routine) }],
              },
              routineId: routine.id,
              routineSlot: dueSlot,
            });

            const recorded = await routines.recordSlot({
              routineId: routine.id,
              slot: dueSlot,
              revision: routine.revision,
              disposition: "admitted",
              runId: admitted.run.id,
            });

            return {
              disposition: recorded.slot.disposition,
              runId: recorded.slot.runId,
              shouldDispatch:
                recorded.slot.disposition === "admitted" && recorded.slot.runId !== null,
            };
          } catch (error) {
            if (error instanceof DomainError && error.code === "run.active_conflict") {
              const skipped = await routines.recordSlot({
                routineId: routine.id,
                slot: dueSlot,
                revision: routine.revision,
                disposition: "skipped_active_run",
                runId: null,
              });
              return {
                disposition: skipped.slot.disposition,
                runId: skipped.slot.runId,
                shouldDispatch: false,
              };
            }
            toRestateTerminalError(error);
          }
        });

        if (admissionOutcome.shouldDispatch && admissionOutcome.runId !== null) {
          ctx.workflowSendClient(RunWorkflowApi, admissionOutcome.runId).run({
            runId: admissionOutcome.runId,
          });
        }

        const nextSlot = scheduleNext(Math.max(nowMs, Date.parse(dueSlot)));
        return {
          routineId,
          revision: routine.revision,
          disposition: admissionOutcome.disposition,
          slot: dueSlot,
          runId: admissionOutcome.runId,
          nextSlot,
        };
      },

      inspect: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
        const revision = await ctx.get<number>("revision");
        const scheduledSlot = await ctx.get<UtcTimestamp | null>("scheduledSlot");
        return { revision, scheduledSlot };
      }),
    },
  });

  return routineSchedule;
}

export type RoutineScheduleObjectDefinition = ReturnType<typeof createRoutineScheduleObject>;

const RoutineScheduleApi: RoutineScheduleObjectDefinition = {
  name: "RoutineSchedule",
} as RoutineScheduleObjectDefinition;

export interface RoutineScheduleClient {
  configure(routineId: RoutineId, input: ConfigureRoutineInput): Promise<ConfigureRoutineResult>;
  tick(routineId: RoutineId, input: RoutineTickInput): Promise<RoutineTickResult>;
  inspect(
    routineId: RoutineId,
  ): Promise<{ readonly revision: number | null; readonly scheduledSlot: UtcTimestamp | null }>;
}

export function createRoutineScheduleClient(ingressUrl: string): RoutineScheduleClient {
  const ingress = clients.connect({ url: ingressUrl });

  return {
    async configure(
      routineId: RoutineId,
      input: ConfigureRoutineInput,
    ): Promise<ConfigureRoutineResult> {
      try {
        return await ingress.objectClient(RoutineScheduleApi, routineId).configure(input);
      } catch (error) {
        throw mapRestateScheduleError(error, `/api/routines/${routineId}`);
      }
    },

    async tick(routineId: RoutineId, input: RoutineTickInput): Promise<RoutineTickResult> {
      try {
        return await ingress.objectClient(RoutineScheduleApi, routineId).tick(input);
      } catch (error) {
        throw mapRestateScheduleError(error, `/api/routines/${routineId}`);
      }
    },

    async inspect(routineId: RoutineId) {
      try {
        return await ingress.objectClient(RoutineScheduleApi, routineId).inspect();
      } catch (error) {
        throw mapRestateScheduleError(error, `/api/routines/${routineId}`);
      }
    },
  };
}

export interface DirectRoutineScheduleDeps {
  readonly routines: RoutineScheduleStore;
  readonly engines: ReadonlyMap<EngineKind, Engine>;
  readonly admitRun: (input: {
    readonly botId: BotId;
    readonly sessionId: SessionId;
    readonly engine: RunEngineKind;
    readonly routineId: RoutineId;
    readonly routineSlot: UtcTimestamp;
    readonly text: string;
  }) => Promise<{ readonly runId: RunId }>;
  readonly now?: () => Date;
}

export function createDirectRoutineScheduleClient(
  deps: DirectRoutineScheduleDeps,
): RoutineScheduleClient {
  const nowFn = deps.now ?? (() => new Date());
  const scheduledSlots = new Map<RoutineId, UtcTimestamp | null>();

  return {
    async configure(
      routineId: RoutineId,
      input: ConfigureRoutineInput,
    ): Promise<ConfigureRoutineResult> {
      let routine: Routine;
      if (input.kind === "create") {
        parseUtcCron(input.cron, `/api/bots/${input.botId}/routines`);
        if (input.enabled) {
          const eligibility = await checkUnattendedEligibility(deps.engines, input.engine);
          if (!eligibility.eligible) {
            throw new DomainError({
              type: "https://der.invalid/problems/routine-engine-ineligible",
              title: "Engine is not eligible for unattended schedules",
              status: 409,
              detail:
                eligibility.reason ??
                `Engine "${input.engine}" is not eligible for scheduled execution.`,
              instance: `/api/bots/${input.botId}/routines`,
              code: "routine.engine_ineligible",
            });
          }
        }
        routine = await deps.routines.createRoutine(createRoutineInput(routineId, input));
      } else {
        const existing = await deps.routines.getRoutine(routineId);
        if (!existing) {
          throw new DomainError({
            type: "https://der.invalid/problems/routine-not-found",
            title: "Routine not found",
            status: 404,
            detail: `Routine ${routineId} does not exist.`,
            instance: `/api/routines/${routineId}`,
            code: "routine.not_found",
          });
        }
        const targetCron = input.cron ?? existing.cron;
        const targetEngine = input.engine ?? existing.engine;
        const targetEnabled = input.enabled ?? existing.enabled;
        parseUtcCron(targetCron, `/api/routines/${routineId}`);
        if (targetEnabled) {
          const eligibility = await checkUnattendedEligibility(deps.engines, targetEngine);
          if (!eligibility.eligible) {
            throw new DomainError({
              type: "https://der.invalid/problems/routine-engine-ineligible",
              title: "Engine is not eligible for unattended schedules",
              status: 409,
              detail:
                eligibility.reason ??
                `Engine "${targetEngine}" is not eligible for scheduled execution.`,
              instance: `/api/routines/${routineId}`,
              code: "routine.engine_ineligible",
            });
          }
        }
        routine = await deps.routines.updateRoutine(routineId, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.cron !== undefined ? { cron: input.cron } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.engine !== undefined ? { engine: input.engine } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.script !== undefined ? { script: input.script } : {}),
          ...(input.expectedRevision !== undefined
            ? { expectedRevision: input.expectedRevision }
            : {}),
        });
      }

      if (!routine.enabled) {
        scheduledSlots.set(routine.id, null);
        return { routine, nextSlot: null };
      }

      const nowMs = nowFn().getTime();
      const nextSlot = nextUtcSlotAfter(routine.cron, nowMs) ?? null;
      scheduledSlots.set(routine.id, nextSlot);
      return { routine, nextSlot };
    },

    async tick(routineId: RoutineId, input: RoutineTickInput): Promise<RoutineTickResult> {
      const routine = await deps.routines.getRoutine(routineId);
      if (!routine || input.revision !== routine.revision) {
        return {
          routineId,
          revision: input.revision,
          disposition: "skipped_obsolete_revision",
          slot: input.scheduledSlot ?? null,
          runId: null,
          nextSlot: null,
        };
      }
      if (!routine.enabled) {
        return {
          routineId,
          revision: input.revision,
          disposition: "disabled",
          slot: input.scheduledSlot ?? null,
          runId: null,
          nextSlot: null,
        };
      }

      const nowMs =
        input.nowOverride !== undefined ? Date.parse(input.nowOverride) : nowFn().getTime();
      const latestRecorded = await deps.routines.getLatestSlot(routine.id);
      const afterExclusiveMs = latestRecorded
        ? Date.parse(latestRecorded.slot)
        : input.scheduledSlot !== undefined
          ? Date.parse(input.scheduledSlot) - 1000
          : Date.parse(routine.updatedAt) - 1000;

      const dueSlot = resolveLatestDueUtcSlot(routine.cron, nowMs, afterExclusiveMs);
      if (!dueSlot) {
        const nextSlot = nextUtcSlotAfter(routine.cron, nowMs) ?? null;
        scheduledSlots.set(routine.id, nextSlot);
        return {
          routineId,
          revision: routine.revision,
          disposition: "not_due",
          slot: null,
          runId: null,
          nextSlot,
        };
      }

      const existingSlot = await deps.routines.getSlot(routine.id, dueSlot);
      if (existingSlot) {
        const nextSlot =
          nextUtcSlotAfter(routine.cron, Math.max(nowMs, Date.parse(dueSlot))) ?? null;
        scheduledSlots.set(routine.id, nextSlot);
        return {
          routineId,
          revision: routine.revision,
          disposition: "already_recorded",
          slot: existingSlot.slot,
          runId: existingSlot.runId,
          nextSlot,
        };
      }

      const eligibility = await checkUnattendedEligibility(deps.engines, routine.engine);
      if (!eligibility.eligible) {
        const recorded = await deps.routines.recordSlot({
          routineId: routine.id,
          slot: dueSlot,
          revision: routine.revision,
          disposition: "blocked_ineligible",
          runId: null,
        });
        const nextSlot =
          nextUtcSlotAfter(routine.cron, Math.max(nowMs, Date.parse(dueSlot))) ?? null;
        scheduledSlots.set(routine.id, nextSlot);
        return {
          routineId,
          revision: routine.revision,
          disposition: recorded.slot.disposition,
          slot: dueSlot,
          runId: null,
          nextSlot,
        };
      }

      if (await deps.routines.hasActiveRun(routine.sessionId)) {
        const skipped = await deps.routines.recordSlot({
          routineId: routine.id,
          slot: dueSlot,
          revision: routine.revision,
          disposition: "skipped_active_run",
          runId: null,
        });
        const nextSlot =
          nextUtcSlotAfter(routine.cron, Math.max(nowMs, Date.parse(dueSlot))) ?? null;
        scheduledSlots.set(routine.id, nextSlot);
        return {
          routineId,
          revision: routine.revision,
          disposition: skipped.slot.disposition,
          slot: dueSlot,
          runId: null,
          nextSlot,
        };
      }

      const admitted = await deps.admitRun({
        botId: routine.botId,
        sessionId: routine.sessionId,
        engine: routine.engine,
        routineId: routine.id,
        routineSlot: dueSlot,
        text: routineRunText(routine),
      });
      const recorded = await deps.routines.recordSlot({
        routineId: routine.id,
        slot: dueSlot,
        revision: routine.revision,
        disposition: "admitted",
        runId: admitted.runId,
      });
      const nextSlot = nextUtcSlotAfter(routine.cron, Math.max(nowMs, Date.parse(dueSlot))) ?? null;
      scheduledSlots.set(routine.id, nextSlot);
      return {
        routineId,
        revision: routine.revision,
        disposition: recorded.slot.disposition,
        slot: dueSlot,
        runId: recorded.slot.runId,
        nextSlot,
      };
    },

    async inspect(routineId: RoutineId) {
      const routine = await deps.routines.getRoutine(routineId);
      return {
        revision: routine?.revision ?? null,
        scheduledSlot: scheduledSlots.get(routineId) ?? null,
      };
    },
  };
}
