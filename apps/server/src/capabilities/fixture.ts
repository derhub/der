import * as z from "zod";
import { defineCapability, type Capability, type CapabilityContext } from "@der/domain";

export interface FixtureCall {
  readonly operationId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly canonicalArguments: unknown;
}

export interface FixtureCapabilities {
  readonly capabilities: Capability[];
  readonly applied: FixtureCall[];
}

const fixtureInput = z.object({ target: z.string(), mode: z.string().optional() });

function effectOf(id: string, ctx: CapabilityContext) {
  if (ctx.effect === undefined) {
    throw new Error(`${id} is a write and needs an effect identity.`);
  }
  return ctx.effect;
}

export function createFixtureCapabilities(): FixtureCapabilities {
  const applied: FixtureCall[] = [];
  const capabilities = [
    defineCapability({
      id: "fixture.apply",
      description: "Applies one deterministic credential-free fixture effect.",
      input: fixtureInput,
      output: z.object({ applied: z.boolean(), operationId: z.string(), arguments: z.unknown() }),
      effect: "write",
      approval: "always",
      async execute(input, ctx) {
        const effect = effectOf("fixture.apply", ctx);
        applied.push({
          operationId: effect.operationId,
          attemptId: effect.attemptId,
          runId: effect.runId,
          canonicalArguments: effect.canonicalArguments,
        });
        return { applied: true, operationId: effect.operationId, arguments: input };
      },
    }),
    defineCapability({
      id: "fixture.uncertain",
      description: "Simulates a dispatched effect whose upstream response is lost.",
      input: fixtureInput,
      output: z.unknown(),
      effect: "write",
      approval: "always",
      async execute(_input, ctx) {
        const effect = effectOf("fixture.uncertain", ctx);
        throw new Error(
          `Upstream response lost after dispatching ${effect.operationId} for run ${effect.runId}.`,
        );
      },
    }),
  ] as Capability[];
  return { capabilities, applied };
}
