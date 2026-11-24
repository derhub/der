import * as z from "zod";
import { defineCapability, type CapabilitySearchHit, type Catalog } from "@der/domain";
import type { AnyTool } from "@tanstack/ai";

const searchInput = z.strictObject({
  query: z.string().describe("Words describing what you want to do, such as `append note`."),
});

export interface SearchToolResult {
  readonly hits: CapabilitySearchHit[];
  readonly truncated: boolean;
}

export interface SearchToolDeps {
  readonly catalog: Catalog;
  readonly maxResultBytes: number;
}

const encoder = new TextEncoder();

function fitHits(hits: readonly CapabilitySearchHit[], maxBytes: number): SearchToolResult {
  const kept: CapabilitySearchHit[] = [];
  let used = 0;
  for (const hit of hits) {
    used += encoder.encode(JSON.stringify(hit)).byteLength;
    if (kept.length > 0 && used > maxBytes) {
      return { hits: kept, truncated: true };
    }
    kept.push(hit);
  }
  return { hits: kept, truncated: false };
}

export function createSearchTool(deps: SearchToolDeps): AnyTool {
  return {
    name: "search",
    description:
      "Find capabilities by query. Returns TypeScript declarations and one-line examples for the capabilities that match, ready to call from `execute` as await step.run(id, input).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words describing what you want to do, such as `append note`.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    } as AnyTool["inputSchema"],
    execute: async (rawArgs: unknown): Promise<SearchToolResult> => {
      const { query } = searchInput.parse(rawArgs);
      return fitHits(deps.catalog.search(query), deps.maxResultBytes);
    },
  };
}

export function createCatalogSearchCapability(catalog: Catalog, maxResultBytes: number) {
  const hit = z.object({
    id: z.string(),
    summary: z.string(),
    declaration: z.string(),
    example: z.string().optional(),
  });
  return defineCapability({
    id: "catalog.search",
    description: "Find capabilities by query and return their declarations.",
    input: z.string().describe("Words describing what you want to do."),
    output: z.object({ hits: z.array(hit), truncated: z.boolean() }),
    effect: "read",
    approval: "none",
    example: 'await step.run("catalog.search", "append note")',
    async execute(query) {
      return fitHits(catalog.search(query), maxResultBytes);
    },
  });
}
