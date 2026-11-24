# Integration API

An integration adds capabilities to the catalog that agents reach through the `search` and `execute` tools. This page covers `defineIntegration`, `defineCapability`, effect classes, approval policy, ids, and the declaration an agent sees. Both functions are exported from `@der/domain`. The code is in `packages/domain/src/interfaces/capability.ts` and `packages/domain/src/interfaces/integration.ts`.

## How an agent uses a capability

1. The agent calls `search({ query })`. The catalog scores every capability against the query and returns the best matches with a TypeScript declaration and an example.
2. The agent calls `execute({ script })` with a Script that calls `await step.run("<namespace>.<name>", input)`.
3. The host validates the input against the capability's `input` schema before it stores the step, runs `execute`, and parses the result against the `output` schema. A `write` waits for an operator decision first when the bot's policy says `ask`.

Everything else (limits, resume, policy, events, script routines) is in the README under "Code mode" and the sections that follow it.

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
  readonly approval: "none" | "always" | ((input: z.infer<TInput>) => boolean); // the default; a bot's policy can override it
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
- `ctx.effect` is set for a `write` called from a Script. It carries the identity of the recorded Effect (`runId`, `operationKind: "capability"`, `operationId` = the capability id, `canonicalArguments`, `attemptId`). `attemptId` is the execution id and the step's position, and stays the same when the Script is re-run. Use it as an idempotency key against the upstream system.
- `ctx.signal` aborts when the server closes. Cancelling a Script does not abort a call that is already running: the call gets up to ten seconds to finish, and no further step starts.
- `example` is one line of Script that calls the capability. It is shown to the agent and counts toward search ranking.

### Ids

An id is dot-separated, with at least two segments, and every segment matches `[A-Za-z_$][A-Za-z0-9_$]*`: `tasks.list`, `mcp.github.create_issue`. The first segment is the namespace. A Script calls the capability as `step.run("<id>", input)`. `defineCapability` throws `integration.invalid_capability` for any other id.

### Effect class and approval

- `effect: "read"` must have `approval: "none"`; `defineCapability` throws otherwise. A read's result is stored with its step and the read is not invoked again on a re-run; it leaves no Effect record.
- `effect: "write"` is stored as a step and gets an Effect record before it runs. The recorded outcome is returned when the Script is re-run, so the call is applied once.
- `approval: "always"` asks an operator for an exact-operation Approval on every call unless the bot's policy says otherwise (below). The prompt shows the capability id and the first 400 characters of the input.
- `approval: (input) => boolean` is evaluated against the validated input, once, when the step is first stored. The answer is stored with the step, so a re-run does not evaluate it again.
- `approval: "none"` on a `write` runs without an Approval but is still recorded as an Effect.

`approval` is the default, not the final word. Each bot has a policy that maps a capability id or a namespace to `allow`, `ask` or `deny`; the most specific entry wins, and the capability's `approval` applies where none matches (README, "Per-bot policy"). `ask` requests an Approval for the exact capability and arguments, `allow` runs the write without one, and `deny` rejects the step with error kind `refused`. A `read` set to `ask` runs without asking. A capability author cannot widen a deny.

A denied or expired Approval rejects that step's promise with error kind `denied` or `expired`. The Script can catch it and carry on; an uncaught rejection ends the Script. A step a Script starts and never awaits still runs before the Script ends. A write is refused while another write of the same Run has an unknown outcome.

### Input validation

`Catalog.validateInput(id, input)` checks the input against the capability's `input` schema and throws `capability.invalid_input` (`400`). The host calls it before it stores a step, so an input that fails never reaches `execute` and nothing is stored; the Script ends with error kind `capability`. `Catalog.invoke` calls it again, so the schema is also the check for any other caller.

### Errors

- A `DomainError` thrown by a `write` is recorded as a failed Effect and rejects the step with kind `failed`. A Script can catch it.
- Any other error thrown by a `write` after dispatch is treated as an unknown outcome: the Effect is marked unknown and the write is not repeated. The step's promise never settles, so nothing that depends on it runs. The execution ends `in_doubt` with error kind `capability`. If its owning Run is still active, that Run is interrupted with `effect.outcome_uncertain`; if the Run already ended, it stays as it ended and the `script.finished` event carries the `in_doubt` outcome. An execution that stops for another reason (a re-run mismatch, a limit, a Script error, cancellation) while one of its writes has an unknown outcome also ends `in_doubt`, keeps that reason's error kind, and names the write in its message. The same holds when the server stops after a write began and before its outcome was recorded. Throw a `DomainError` when the upstream call is known not to have happened.
- Any error thrown by a `read` rejects the step with kind `failed`. A read that was interrupted before its result was stored runs again on a re-run, so a read must have no effect.
- Unknown ids fail with `capability.unknown` (`404`), invalid input with `capability.invalid_input` (`400`). Both end the Script with kind `capability` before a step is stored.

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
declare const step: {
  run(id: "tasks.remove", input: TasksRemoveInput): Promise<TasksRemoveOutput>;
};
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
    example: 'await step.run("tasks.list", { openOnly: true })',
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
    example: 'await step.run("tasks.remove", { ids: ["t1"] })',
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
const { tasks } = await step.run("tasks.list", { openOnly: true });
return await step.run("tasks.remove", { ids: tasks.map((entry) => entry.id) });
```

With two or more open tasks and no policy entry for `tasks`, the `tasks.remove` call waits for an operator Approval and then records one Effect. A bot with `"tasks.remove": "allow"` skips the Approval, and one with `"tasks": "deny"` has the call rejected with kind `refused`. With one open task it runs at once and still records an Effect.

## Remote MCP tools

`@der/mcp` (`integrations/mcp/src/mcp-tools.ts`) is an integration that uses `listCapabilities`. For each tool of each configured server it registers `mcp.<server>.<tool>`. Characters outside `[A-Za-z0-9_$]` in the server id or tool name become `_`, and a name that starts with a digit gets a leading `_`; two tools that map to the same id fail the integration with `mcp.duplicate_capability_id`. Every MCP capability is a `write` with `approval: "always"` as its default, unless the tool is named in the server's `readOnlyTools` or the server sets `defaultRequiresApproval: false`. In both cases `approval` is `"none"`. A tool outside `allowedTools` (when set) is not registered. The server reads the server list from `DER_MCP_SERVERS_JSON`.

## Run usage and context mode

A Run (`GET /api/runs/:runId`) carries two extra fields:

- `usage`: `null` until the Run finishes, then `inputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens` and `reportedCostUsd`. The cache fields and the cost are `null` when the engine does not report them.
- `contextMode`: `"resumed"` or `"rebuilt"`; `null` for a Script Run. The README section "Session resume" says when a Run rebuilds.

`reportedCostUsd` is the vendor's figure, cumulative per vendor session, so do not sum it across Runs.

`GET /api/sessions/:sessionId/runs` lists the Session's Runs, newest first, as `{ runs }`. An unknown session returns `404` with code `session.not_found`.

`GET /api/runs/:runId/events` can send a `CUSTOM` chunk named `der.attempt-reset` when the engine step starts over. Discard the text streamed so far for that Run and render the chunks that follow.
