import type { ToolDescriptor, ToolOperation, ToolResult, Tools } from "@der/domain";
import { compiledParsers } from "@der/domain/compiled";
import { deniedToolResult } from "./authorization";

export function createHostTools(providers: readonly Tools[]): Tools & {
  list(): Promise<readonly ToolDescriptor[]>;
} {
  async function loadRouteMap(): Promise<{
    readonly descriptors: readonly ToolDescriptor[];
    readonly routes: ReadonlyMap<string, Tools>;
  }> {
    const descriptors: ToolDescriptor[] = [];
    const routes = new Map<string, Tools>();

    for (const provider of providers) {
      if (!provider.list) {
        continue;
      }
      const listed = await provider.list();
      for (const descriptor of listed) {
        const validated = compiledParsers.toolDescriptor.parse(descriptor);
        const key = `${validated.kind}:${validated.id}`;
        routes.set(key, provider);
        descriptors.push(validated);
      }
    }

    descriptors.sort((a, b) => a.id.localeCompare(b.id));
    return { descriptors, routes };
  }

  return {
    async list(): Promise<readonly ToolDescriptor[]> {
      const { descriptors } = await loadRouteMap();
      return descriptors;
    },

    async invoke(operation: ToolOperation): Promise<ToolResult> {
      const parsedOp = compiledParsers.toolOperation.safeParse(operation);
      if (!parsedOp.success) {
        return deniedToolResult(
          "tool.invalid_arguments",
          `Invalid tool operation payload: ${parsedOp.error.message}`,
        );
      }

      const { routes } = await loadRouteMap();
      const key = `${parsedOp.data.effect.operationKind}:${parsedOp.data.effect.operationId}`;
      const target = routes.get(key);
      if (!target) {
        return deniedToolResult(
          "tool.unrecognized_operation",
          `Host operation "${key}" is unrecognized and denied by default.`,
        );
      }

      return target.invoke(parsedOp.data);
    },
  };
}
