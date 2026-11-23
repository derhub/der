import * as z from "zod";
import { DomainError } from "../protocol/problem-details";
import type { EffectIdentity } from "../schemas/approval";
import type { JsonValue } from "../schemas/common";
import type { CapabilityDescriptor, CapabilitySearchHit } from "../schemas/execution";

export interface CapabilityContext {
  readonly botId?: string;
  readonly effect?: EffectIdentity;
  readonly signal?: AbortSignal;
}

export type CapabilityApprovalPolicy<TInput = unknown> =
  | "none"
  | "always"
  | ((input: TInput) => boolean);

export interface Capability<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly effect: "read" | "write";
  readonly approval: CapabilityApprovalPolicy<z.infer<TInput>>;
  readonly example?: string;
  execute(input: z.infer<TInput>, ctx: CapabilityContext): Promise<z.infer<TOutput>>;
}

export interface Catalog {
  list(): CapabilityDescriptor[];
  search(query: string, limit?: number): CapabilitySearchHit[];
  requiresApproval(id: string, input: JsonValue): boolean;
  invoke(id: string, input: JsonValue, ctx: CapabilityContext): Promise<JsonValue>;
}

const ID_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DEFAULT_SEARCH_LIMIT = 10;

function invalidCapability(id: string, detail: string): DomainError {
  return new DomainError({
    type: "https://der.invalid/problems/invalid-capability-definition",
    title: "Invalid capability definition",
    status: 400,
    detail,
    instance: `/integrations/capabilities/${id}`,
    code: "integration.invalid_capability",
  });
}

export function defineCapability<TInput extends z.ZodType, TOutput extends z.ZodType>(
  def: Capability<TInput, TOutput>,
): Capability<TInput, TOutput> {
  const segments = def.id.split(".");
  if (segments.length < 2 || !segments.every((segment) => ID_SEGMENT.test(segment))) {
    throw invalidCapability(
      def.id,
      `Capability id "${def.id}" must be dot-separated identifiers with a namespace, such as "memory.write".`,
    );
  }
  if (def.effect === "read" && def.approval !== "none") {
    throw invalidCapability(
      def.id,
      `Capability "${def.id}" is a read and cannot require approval; declare it as a write.`,
    );
  }
  return def;
}

interface JsonSchema {
  readonly type?: unknown;
  readonly const?: unknown;
  readonly enum?: unknown;
  readonly anyOf?: unknown;
  readonly oneOf?: unknown;
  readonly allOf?: unknown;
  readonly items?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly additionalProperties?: unknown;
  readonly description?: unknown;
}

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): JsonValue {
  return JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any" })),
  ) as JsonValue;
}

function isObject(value: unknown): value is JsonSchema & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaList(value: unknown): JsonSchema[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function docComment(node: JsonSchema, indent: string): string {
  const description = typeof node.description === "string" ? node.description.trim() : "";
  if (description === "") {
    return "";
  }
  return `${indent}/** ${description.replace(/\s*\n\s*/g, " ").replaceAll("*/", "* /")} */\n`;
}

function renderObject(node: JsonSchema, indent: string): string {
  const properties: Record<string, unknown> = isObject(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const inner = `${indent}  `;
  const lines: string[] = [];
  for (const [name, child] of Object.entries(properties)) {
    if (!isObject(child)) {
      continue;
    }
    const key = ID_SEGMENT.test(name) ? name : JSON.stringify(name);
    const optional = required.has(name) ? "" : "?";
    lines.push(
      `${docComment(child, inner)}${inner}${key}${optional}: ${renderType(child, inner)};`,
    );
  }
  if (node.additionalProperties === true) {
    lines.push(`${inner}[key: string]: unknown;`);
  } else if (isObject(node.additionalProperties)) {
    lines.push(`${inner}[key: string]: ${renderType(node.additionalProperties, inner)};`);
  }
  return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`;
}

function renderType(node: JsonSchema, indent: string): string {
  if ("const" in node) {
    return JSON.stringify(node.const);
  }
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const union = schemaList(node.anyOf ?? node.oneOf);
  if (union.length > 0) {
    return union.map((member) => renderType(member, indent)).join(" | ");
  }
  const intersection = schemaList(node.allOf);
  if (intersection.length > 0) {
    return intersection.map((member) => renderType(member, indent)).join(" & ");
  }
  if (Array.isArray(node.type)) {
    return node.type.map((type) => renderType({ ...node, type }, indent)).join(" | ");
  }
  switch (node.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      if (!isObject(node.items)) {
        return "unknown[]";
      }
      const item = renderType(node.items, indent);
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case "object":
      return renderObject(node, indent);
    default:
      return isObject(node.properties) ? renderObject(node, indent) : "unknown";
  }
}

function typeBaseName(id: string): string {
  return id
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

export function renderDeclaration(capability: Capability): string {
  const base = typeBaseName(capability.id);
  const inputName = `${base}Input`;
  const outputName = `${base}Output`;
  const input = toJsonSchema(capability.input, "input") as JsonSchema;
  const output = toJsonSchema(capability.output, "output") as JsonSchema;
  const description = capability.description.trim();
  const doc = description === "" ? "" : docComment({ description }, "");
  return [
    `type ${inputName} = ${renderType(input, "")};`,
    `type ${outputName} = ${renderType(output, "")};`,
    `${doc}declare function der.${capability.id}(input: ${inputName}): Promise<${outputName}>;`,
  ].join("\n");
}

function summaryOf(description: string): string {
  return description.trim().split("\n", 1)[0]!.trim();
}

function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

function scoreCapability(capability: Capability, terms: readonly string[]): number {
  const id = capability.id.toLowerCase();
  const description = capability.description.toLowerCase();
  const example = (capability.example ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (id.split(".").includes(term)) {
      score += 4;
    } else if (id.includes(term)) {
      score += 3;
    }
    if (description.includes(term)) {
      score += 2;
    }
    if (example.includes(term)) {
      score += 1;
    }
  }
  return score;
}

export class CapabilityCatalog implements Catalog {
  private readonly capabilities = new Map<string, Capability>();

  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  add(capability: Capability): void {
    if (this.capabilities.has(capability.id)) {
      throw new DomainError({
        type: "https://der.invalid/problems/duplicate-capability-id",
        title: "Duplicate capability ID",
        status: 409,
        detail: `Capability "${capability.id}" is already registered.`,
        instance: `/integrations/capabilities/${capability.id}`,
        code: "integration.duplicate_capability_id",
      });
    }
    this.capabilities.set(capability.id, capability);
  }

  list(): CapabilityDescriptor[] {
    return [...this.capabilities.values()]
      .map((capability) => ({
        id: capability.id,
        description: capability.description,
        effect: capability.effect,
        requiresApproval: capability.approval !== "none",
        inputSchema: toJsonSchema(capability.input, "input"),
        outputSchema: toJsonSchema(capability.output, "output"),
        ...(capability.example === undefined ? {} : { example: capability.example }),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): CapabilitySearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    return [...this.capabilities.values()]
      .map((capability) => ({ capability, score: scoreCapability(capability, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
      .slice(0, limit)
      .map(({ capability }) => ({
        id: capability.id,
        summary: summaryOf(capability.description),
        declaration: renderDeclaration(capability),
        ...(capability.example === undefined ? {} : { example: capability.example }),
      }));
  }

  private require(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (capability === undefined) {
      throw new DomainError({
        type: "https://der.invalid/problems/unknown-capability",
        title: "Unknown capability",
        status: 404,
        detail: `Capability "${id}" is not registered.`,
        instance: `/capabilities/${id}`,
        code: "capability.unknown",
      });
    }
    return capability;
  }

  requiresApproval(id: string, input: JsonValue): boolean {
    const capability = this.require(id);
    if (capability.approval === "none" || capability.approval === "always") {
      return capability.approval === "always";
    }
    const parsed = capability.input.safeParse(input);
    return parsed.success && capability.approval(parsed.data);
  }

  async invoke(id: string, input: JsonValue, ctx: CapabilityContext): Promise<JsonValue> {
    const capability = this.require(id);
    const parsed = capability.input.safeParse(input);
    if (!parsed.success) {
      throw new DomainError({
        type: "https://der.invalid/problems/invalid-capability-input",
        title: "Invalid capability input",
        status: 400,
        detail: `Invalid input for capability "${id}": ${parsed.error.message}`,
        instance: `/capabilities/${id}`,
        code: "capability.invalid_input",
      });
    }
    const result = await capability.execute(parsed.data, ctx);
    return capability.output.parse(result) as JsonValue;
  }
}
