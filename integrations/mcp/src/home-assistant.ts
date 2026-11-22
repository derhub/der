import type { JsonValue, ToolDescriptor, ToolOperation, ToolResult, Tools } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import * as z from "zod";
import { deniedToolResult, type ApprovalVerifier } from "./authorization";
import { redactSecrets, ToolConfigurationError, ToolEffectUncertainError } from "./errors";

export interface HomeAssistantConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly allowedServices?: readonly string[];
  readonly allowedEntities?: readonly string[];
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly verifyApproval?: ApprovalVerifier;
}

const SAFE_SEGMENT = /^[a-z0-9_]+$/;
const SAFE_ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

const getStateArgsSchema = z.compile(
  z.object({
    entityId: z.string().regex(SAFE_ENTITY_ID),
  }),
);

const listStatesArgsSchema = z.compile(
  z.object({
    domain: z.string().regex(SAFE_SEGMENT).optional(),
  }),
);

const callServiceArgsSchema = z.compile(
  z.object({
    domain: z.string().regex(SAFE_SEGMENT),
    service: z.string().regex(SAFE_SEGMENT),
    entityId: z.string().regex(SAFE_ENTITY_ID).optional(),
    serviceData: z.record(z.string(), z.json()).optional(),
  }),
);

const HOME_ASSISTANT_DESCRIPTORS: readonly ToolDescriptor[] = [
  compiledParsers.toolDescriptor.parse({
    kind: "home-assistant",
    id: "home_assistant.get_state",
    name: "Home Assistant Get State",
    description: "Read the current state of an allowed Home Assistant entity.",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
      },
      required: ["entityId"],
      additionalProperties: false,
    },
  }),
  compiledParsers.toolDescriptor.parse({
    kind: "home-assistant",
    id: "home_assistant.list_states",
    name: "Home Assistant List States",
    description: "List current states of allowed Home Assistant entities.",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
      },
      additionalProperties: false,
    },
  }),
  compiledParsers.toolDescriptor.parse({
    kind: "home-assistant",
    id: "home_assistant.call_service",
    name: "Home Assistant Call Service",
    description: "Invoke an allowlisted Home Assistant service with exact-operation approval.",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        service: { type: "string" },
        entityId: { type: "string" },
        serviceData: { type: "object" },
      },
      required: ["domain", "service"],
      additionalProperties: false,
    },
  }),
];

function parseJsonResponse(text: string): JsonValue {
  if (text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

export function createHomeAssistantTools(config: HomeAssistantConfig): Tools & {
  list(): Promise<readonly ToolDescriptor[]>;
} {
  let normalizedBaseUrl: string;
  try {
    const parsedUrl = new URL(config.baseUrl);
    normalizedBaseUrl = parsedUrl.toString().replace(/\/+$/, "");
  } catch {
    throw new ToolConfigurationError(
      "home_assistant.invalid_base_url",
      `Invalid Home Assistant baseUrl "${config.baseUrl}".`,
    );
  }
  if (config.token.trim().length === 0) {
    throw new ToolConfigurationError(
      "home_assistant.missing_token",
      "Home Assistant adapter requires a non-empty bearer token.",
    );
  }

  const secretList = [config.token];
  const allowedServices = new Set(config.allowedServices ?? []);
  const allowedEntities = config.allowedEntities ? new Set(config.allowedEntities) : undefined;
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;

  function isEntityAllowed(entityId: string): boolean {
    return allowedEntities === undefined || allowedEntities.has(entityId);
  }

  async function requestHa(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, JsonValue>,
  ): Promise<Response> {
    return fetchFn(`${normalizedBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    async list(): Promise<readonly ToolDescriptor[]> {
      return HOME_ASSISTANT_DESCRIPTORS;
    },

    async invoke(operation: ToolOperation): Promise<ToolResult> {
      const parsedOp = compiledParsers.toolOperation.safeParse(operation);
      if (!parsedOp.success) {
        return deniedToolResult(
          "tool.invalid_arguments",
          `Invalid tool operation payload: ${parsedOp.error.message}`,
        );
      }

      const { effect } = parsedOp.data;
      if (effect.operationKind !== "home-assistant") {
        return deniedToolResult(
          "tool.unrecognized_operation",
          `Operation kind "${effect.operationKind}" is not handled by Home Assistant tools.`,
        );
      }

      if (effect.operationId === "home_assistant.get_state") {
        const parsedArgs = getStateArgsSchema.safeParse(effect.canonicalArguments);
        if (!parsedArgs.success) {
          return deniedToolResult(
            "tool.invalid_arguments",
            `Invalid get_state arguments: ${parsedArgs.error.message}`,
          );
        }
        if (!isEntityAllowed(parsedArgs.data.entityId)) {
          return deniedToolResult(
            "tool.unrecognized_operation",
            `Entity "${parsedArgs.data.entityId}" is outside the Home Assistant allowlist.`,
          );
        }

        try {
          const response = await requestHa("GET", `/api/states/${parsedArgs.data.entityId}`);
          const text = await response.text();
          if (!response.ok) {
            return compiledParsers.toolResult.parse({
              ok: false,
              isError: true,
              outcome: { status: response.status, code: "home_assistant.request_rejected" },
              detail: redactSecrets(text || `HTTP ${response.status}`, secretList),
            });
          }
          return compiledParsers.toolResult.parse({
            ok: true,
            isError: false,
            outcome: parseJsonResponse(text),
          });
        } catch (error) {
          const detail = redactSecrets(
            error instanceof Error ? error.message : String(error),
            secretList,
          );
          return compiledParsers.toolResult.parse({
            ok: false,
            isError: true,
            outcome: { code: "home_assistant.network_error" },
            detail,
          });
        }
      }

      if (effect.operationId === "home_assistant.list_states") {
        const parsedArgs = listStatesArgsSchema.safeParse(effect.canonicalArguments);
        if (!parsedArgs.success) {
          return deniedToolResult(
            "tool.invalid_arguments",
            `Invalid list_states arguments: ${parsedArgs.error.message}`,
          );
        }

        try {
          const response = await requestHa("GET", "/api/states");
          const text = await response.text();
          if (!response.ok) {
            return compiledParsers.toolResult.parse({
              ok: false,
              isError: true,
              outcome: { status: response.status, code: "home_assistant.request_rejected" },
              detail: redactSecrets(text || `HTTP ${response.status}`, secretList),
            });
          }
          const rawList = parseJsonResponse(text);
          if (!Array.isArray(rawList)) {
            return compiledParsers.toolResult.parse({
              ok: true,
              isError: false,
              outcome: rawList,
            });
          }

          const filtered = rawList.filter((item) => {
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
              return false;
            }
            const entityId = (item as Record<string, unknown>)["entity_id"];
            if (typeof entityId !== "string") {
              return false;
            }
            if (!isEntityAllowed(entityId)) {
              return false;
            }
            if (
              parsedArgs.data.domain !== undefined &&
              !entityId.startsWith(`${parsedArgs.data.domain}.`)
            ) {
              return false;
            }
            return true;
          });

          return compiledParsers.toolResult.parse({
            ok: true,
            isError: false,
            outcome: filtered,
          });
        } catch (error) {
          const detail = redactSecrets(
            error instanceof Error ? error.message : String(error),
            secretList,
          );
          return compiledParsers.toolResult.parse({
            ok: false,
            isError: true,
            outcome: { code: "home_assistant.network_error" },
            detail,
          });
        }
      }

      if (effect.operationId === "home_assistant.call_service") {
        const parsedArgs = callServiceArgsSchema.safeParse(effect.canonicalArguments);
        if (!parsedArgs.success) {
          return deniedToolResult(
            "tool.invalid_arguments",
            `Invalid call_service arguments: ${parsedArgs.error.message}`,
          );
        }

        const serviceKey = `${parsedArgs.data.domain}.${parsedArgs.data.service}`;
        if (!allowedServices.has(serviceKey)) {
          return deniedToolResult(
            "tool.unrecognized_operation",
            `Home Assistant service "${serviceKey}" is not in the allowedServices policy.`,
          );
        }

        const entityIdFromData =
          typeof parsedArgs.data.serviceData?.["entity_id"] === "string"
            ? parsedArgs.data.serviceData["entity_id"]
            : undefined;
        const targetEntityId = parsedArgs.data.entityId ?? entityIdFromData;
        if (targetEntityId !== undefined && !isEntityAllowed(targetEntityId)) {
          return deniedToolResult(
            "tool.unrecognized_operation",
            `Entity "${targetEntityId}" is outside the Home Assistant allowlist.`,
          );
        }

        if (config.verifyApproval) {
          const authorized = await config.verifyApproval(effect);
          if (!authorized) {
            return deniedToolResult(
              "tool.approval_required",
              `Exact-operation approval is required for Home Assistant service "${serviceKey}".`,
            );
          }
        }

        const payload: Record<string, JsonValue> = {
          ...parsedArgs.data.serviceData,
          ...(parsedArgs.data.entityId !== undefined
            ? { entity_id: parsedArgs.data.entityId }
            : {}),
        };

        let response: Response;
        try {
          response = await requestHa(
            "POST",
            `/api/services/${parsedArgs.data.domain}/${parsedArgs.data.service}`,
            payload,
          );
        } catch (error) {
          const detail = redactSecrets(
            error instanceof Error ? error.message : String(error),
            secretList,
          );
          throw new ToolEffectUncertainError(
            effect,
            `Home Assistant service "${serviceKey}" outcome is uncertain after dispatch: ${detail}`,
          );
        }

        const text = await response.text();
        if (response.status >= 500) {
          const detail = redactSecrets(text || `HTTP ${response.status}`, secretList);
          throw new ToolEffectUncertainError(
            effect,
            `Home Assistant service "${serviceKey}" returned uncertain server status ${response.status}: ${detail}`,
          );
        }

        if (!response.ok) {
          return compiledParsers.toolResult.parse({
            ok: false,
            isError: true,
            outcome: { status: response.status, code: "home_assistant.request_rejected" },
            detail: redactSecrets(text || `HTTP ${response.status}`, secretList),
          });
        }

        return compiledParsers.toolResult.parse({
          ok: true,
          isError: false,
          outcome: {
            domain: parsedArgs.data.domain,
            service: parsedArgs.data.service,
            changedStates: parseJsonResponse(text),
          },
        });
      }

      return deniedToolResult(
        "tool.unrecognized_operation",
        `Home Assistant operation "${effect.operationId}" is unrecognized.`,
      );
    },
  };
}
