# Integration API

An integration adds capabilities to the catalog that agents reach through the `search` and `execute` tools. This page covers `defineIntegration`, `defineCapability`, effect classes, approval policy, ids, and the declaration an agent sees. Both functions are exported from `@der/domain`. The code is in `packages/domain/src/interfaces/capability.ts` and `packages/domain/src/interfaces/integration.ts`.

## How an agent uses a capability

1. The agent calls `search({ query })`. The catalog scores every capability against the query and returns the best matches with a TypeScript declaration and an example.
2. The agent calls `execute({ script })` with a Script that calls `await der.<namespace>.<name>(input)`.
3. The catalog validates the input against the capability's `input` schema, runs `execute`, and parses the result against the `output` schema. A `write` that needs approval waits for an operator decision first.

Everything else (limits, durability, script routines) is in the README under "Code mode".

## Define an integration

```ts
// packages/domain/src/interfaces/integration.ts
interface IntegrationContribution {
  readonly capabilities?: readonly Capability[];
  readonly listCapabilities?: () => Promise<readonly Capability[]>;
  readonly outboxSinks?: readonly OutboxSink[];
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
interface Integration {
  readonly id: string;
  setup(ctx: IntegrationContext): Promise<IntegrationContribution> | IntegrationContribution;
}
```

- `defineIntegration` rejects an empty `id` with `integration.invalid_definition`.
- `capabilities` are registered when the integration is registered. `listCapabilities` is called once, in `IntegrationRegistry.start()`, after every integration's `start()` has run. Use it for capabilities that exist only after a connection is made, such as the tools of a remote MCP server (`integrations/mcp/src/mcp-tools.ts`).
- `stop()` runs in reverse registration order. Failures are collected and rethrown after every `stop()` has run.
- A duplicate integration id, capability id or outbox sink kind fails with a `409` `DomainError` (`integration.duplicate_id`, `integration.duplicate_capability_id`, `integration.duplicate_outbox_sink`).

Pass integrations to the server with `startServer({ integrations })` (`CreateServerOptions` in `apps/server/src/main.ts`). They are registered after the `host` integration and after the MCP integration, and the option is ignored when `startServer` is given its own `catalog`.

## Define a capability

```ts
// packages/domain/src/interfaces/capability.ts
interface Capability<TInput extends z.ZodType, TOutput extends z.ZodType> {
  readonly id: string;
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly effect: "read" | "write";
  readonly approval: "none" | "always" | ((input: z.infer<TInput>) => boolean);
  readonly example?: string;
  execute(input: z.infer<TInput>, ctx: CapabilityContext): Promise<z.infer<TOutput>>;
}
interface CapabilityContext {
  readonly botId?: string;
  readonly effect?: EffectIdentity;
  readonly signal?: AbortSignal;
}
```

- `input` and `output` are Zod schemas. Inputs and outputs cross a JSON boundary, so use JSON-compatible types.
- `ctx.botId` is the bot that owns the calling Run. Scope data by it, as the host capabilities do (`apps/server/src/capabilities/scope.ts`).
- `ctx.effect` is set for a `write` called from a Script. It carries the identity of the recorded Effect (`runId`, `operationKind: "capability"`, `operationId` = the capability id, `canonicalArguments`, `attemptId`). Use `attemptId` as an idempotency key against the upstream system.
- `ctx.signal` in direct mode aborts when the ScriptRun is cancelled or the server closes. Under Restate a cancel does not abort it: cancel marks the ScriptRun and later calls end as cancelled, while a call already running continues. There the signal aborts when the current attempt ends (for example a server restart), which is not a cancel.
- `example` is one line of Script that calls the capability. It is shown to the agent and counts toward search ranking.

### Ids

An id is dot-separated, with at least two segments, and every segment matches `[A-Za-z_$][A-Za-z0-9_$]*`: `tasks.list`, `mcp.github.create_issue`. The first segment is the namespace. A Script calls the capability as `der.<id>`. `defineCapability` throws `integration.invalid_capability` for any other id.

### Effect class and approval

- `effect: "read"` must have `approval: "none"`; `defineCapability` throws otherwise. Reads run as journaled steps and leave no Effect record.
- `effect: "write"` gets an Effect record before it runs. The recorded outcome is replayed if the Script resumes, so the call is not repeated.
- `approval: "always"` asks an operator for an exact-operation Approval on every call. The prompt shows the capability id and the first 400 characters of the input.
- `approval: (input) => boolean` is evaluated against the validated input. It runs once per call, before the Approval is requested, in a journaled step: a replay reuses the recorded answer instead of evaluating it again. If the input does not validate, it counts as no approval and the call then fails with `capability.invalid_input`.
- `approval: "none"` on a `write` runs without an Approval but is still recorded as an Effect.

A denied or expired Approval ends the Script with error kind `denied` or `expired`.

Scripts run one at a time per Run. A call a Script issues without `await` is carried to its recorded outcome before the Script's result is reported, unless the Script has already hit a limit or been cancelled; a call that ends in a `capability`, `denied`, `expired` or `cancelled` error replaces the Script's own result with that error. A `write` is refused, and the Run interrupted, when the Run has a write whose outcome is unknown.

### Errors

- A `DomainError` thrown by a `write` is recorded as a failed Effect and reaches the Script as an error of kind `capability`. A Script can catch it.
- Any other error thrown by a `write` after dispatch is treated as an unknown outcome: the Effect is marked unknown, and the Script ends with kind `capability` and status `interrupted`. Throw a `DomainError` when the upstream call is known not to have happened.
- Any error thrown by a `read` reaches the Script as kind `capability`.
- Unknown ids fail with `capability.unknown` (`404`), invalid input with `capability.invalid_input` (`400`).

## The declaration an agent sees

`search` renders each match with `renderDeclaration`. The input and output schemas become TypeScript types named from the id, and the description becomes the doc comment. For `tasks.remove` in the example below:

```ts
// Output of search("remove tasks"), hit for tasks.remove
type TasksRemoveInput = {
  ids: string[];
};
type TasksRemoveOutput = {
  removed: number;
};
/** Remove tasks by id. Removing more than one task needs approval. */
declare function der.tasks.remove(input: TasksRemoveInput): Promise<TasksRemoveOutput>;
```

- Optional Zod fields render as optional properties. `.describe("...")` on a field renders as a doc comment on it.
- Write descriptions for the model: the first line of `description` is the one-line summary of the hit, and the whole description is the doc comment on the declaration.
- Ranking is a sum over the query's words: an id segment equal to the word scores 4, an id containing it scores 3, the description 2, the example 1. A capability with score 0 is not returned. The limit is 10 hits.
- The tool result is cut to `DER_SCRIPT_RESULT_BYTES` (default `65536`); at least one hit is always returned.
- `GET /api/capabilities` lists the same capabilities with their JSON Schemas, `effect` and `requiresApproval`.

## Worked example

An integration with a read and a write. Removing one task runs directly; removing several asks for approval.

```ts
// tasks-integration.ts
import * as z from "zod";
import { defineCapability, defineIntegration } from "@der/domain";

const task = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
type Task = z.infer<typeof task>;

export function createTasksIntegration(tasks: Task[] = []) {
  const list = defineCapability({
    id: "tasks.list",
    description: "List tasks. Pass openOnly to skip finished ones.",
    input: z.strictObject({
      openOnly: z.boolean().optional().describe("Skip finished tasks."),
    }),
    output: z.object({ tasks: z.array(task) }),
    effect: "read",
    approval: "none",
    example: "await der.tasks.list({ openOnly: true })",
    async execute(input) {
      return { tasks: tasks.filter((entry) => !input.openOnly || !entry.done) };
    },
  });

  const remove = defineCapability({
    id: "tasks.remove",
    description: "Remove tasks by id. Removing more than one task needs approval.",
    input: z.strictObject({ ids: z.array(z.string()).min(1) }),
    output: z.object({ removed: z.number().int() }),
    effect: "write",
    approval: (input) => input.ids.length > 1,
    example: 'await der.tasks.remove({ ids: ["t1"] })',
    async execute(input) {
      const before = tasks.length;
      tasks.splice(0, tasks.length, ...tasks.filter((entry) => !input.ids.includes(entry.id)));
      return { removed: before - tasks.length };
    },
  });

  return defineIntegration({
    id: "tasks",
    setup: () => ({ capabilities: [list, remove] }),
  });
}
```

Register it when starting the server:

```ts
// an entry file inside apps/server, using its "#" imports map
import { startServer } from "#main";
import { createTasksIntegration } from "./tasks-integration";

await startServer({ integrations: [createTasksIntegration()] });
```

An agent can then run:

```js
const { tasks } = await der.tasks.list({ openOnly: true });
return await der.tasks.remove({ ids: tasks.map((entry) => entry.id) });
```

With two or more open tasks the `tasks.remove` call waits for an operator Approval and then records one Effect. With one open task it runs at once and still records an Effect.

## Remote MCP tools

`@der/mcp` (`integrations/mcp/src/mcp-tools.ts`) is an integration that uses `listCapabilities`. For each tool of each configured server it registers `mcp.<server>.<tool>`. Characters outside `[A-Za-z0-9_$]` in the server id or tool name become `_`, and a name that starts with a digit gets a leading `_`; two tools that map to the same id fail the integration with `mcp.duplicate_capability_id`. Every MCP capability is a `write` with `approval: "always"`, unless the tool is named in the server's `readOnlyTools` or the server sets `defaultRequiresApproval: false`. In both cases `approval` is `"none"`. A tool outside `allowedTools` (when set) is not registered. The server reads the server list from `DER_MCP_SERVERS_JSON`.
