import * as z from "zod";
import { defineCapability, memoryRecord } from "@der/domain";
import type { HttpMemoryPort } from "../http/index";
import { callerBotId, notFound } from "./scope";

export function memoryCapabilities(memory: HttpMemoryPort) {
  return [
    defineCapability({
      id: "memory.read",
      description:
        "Read this bot's memory markdown, latest version or a given version, with the list of versions.",
      input: z.strictObject({ version: z.number().int().positive().optional() }),
      output: z.object({
        memory: memoryRecord.nullable(),
        versions: z.array(z.object({ version: z.number(), updatedAt: z.string() })),
      }),
      effect: "read",
      approval: "none",
      example: 'await step.run("memory.read", {})',
      async execute(input, ctx) {
        const botId = callerBotId(ctx, "memory.read");
        const record = await memory.read(botId, input.version);
        if (input.version !== undefined && !record) {
          throw notFound(
            "memory",
            "memory.not_found",
            `Memory version ${input.version} does not exist for bot ${botId}.`,
            "memory.read",
          );
        }
        const versions = (await memory.listVersions(botId)).map((entry) => ({
          version: entry.version,
          updatedAt: entry.updatedAt,
        }));
        return { memory: record ?? null, versions };
      },
    }),
    defineCapability({
      id: "memory.write",
      description:
        "Write a new version of this bot's memory markdown. Pass expectedVersion to guard against concurrent writes.",
      input: z.strictObject({
        markdown: z.string(),
        expectedVersion: z.number().int().nonnegative().optional(),
      }),
      output: z.object({ memory: memoryRecord }),
      effect: "write",
      approval: "always",
      example: 'await step.run("memory.write", { markdown: "# Notes" })',
      async execute(input, ctx) {
        const botId = callerBotId(ctx, "memory.write");
        const written = await memory.write({
          botId,
          markdown: input.markdown,
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
        });
        return { memory: written };
      },
    }),
  ];
}
