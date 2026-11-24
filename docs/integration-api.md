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

See `Capability` and `CapabilityContext` in `@der/domain` for the full type definitions.

- `input` and `output` are Zod schemas over JSON-compatible values.
- `ctx.botId` identifies the bot that owns the calling Run; scope data by it.
- `ctx.effect` is present for writes called from a Script and carries a stable `attemptId` across re-runs to use as an upstream idempotency key.
- `ctx.signal` aborts on server shutdown, not Script cancellation. An in-flight call gets a short grace period to finish while no new steps start.
- `example` is one line of Script calling the capability, shown to the agent and used in search ranking.

### Ids

Ids are dot-separated identifier segments starting with a namespace (`tasks.list`, `mcp.github.create_issue`). A Script calls a capability with `step.run("<id>", input)`.

### Effect class and approval

- `effect: "read"` cannot require approval. A read caches its result with its step on re-run and leaves no Effect record.
- `effect: "write"` records an Effect before running so re-runs return the stored outcome and never apply the write twice.
- `approval` (`"none"`, `"always"`, or a predicate evaluated once when the step is first stored) sets the capability's default. Each bot's policy (`allow`, `ask`, or `deny`, most specific match wins; see README, "Per-bot policy") overrides it. A read set to `ask` still runs without prompting, and a capability cannot widen a `deny`.
- A denied or expired Approval or policy refusal rejects only that step's promise; the Script can catch it and continue. Unawaited steps still run before the Script ends. Writes are refused while another write in the same Run has an unknown outcome.

### Input validation

The host validates input against the capability's `input` schema before storing a step, so invalid input fails the Script without reaching `execute` or storage.

### Errors

- Throw a `DomainError` from a `write` when the upstream side effect is known not to have happened: it records a failed Effect and rejects only that step so the Script can catch it.
- Any other error thrown after a `write` starts (or a server stop mid-write) leaves an unknown outcome: the Effect is marked unknown and never repeated, the step never settles, and the execution ends `in_doubt`. An active owning Run is interrupted; if it already ended, the `script.finished` event carries the `in_doubt` outcome. Stopping for another reason while a write is in doubt also ends `in_doubt` and accounts for the unknown writes even when the result is bounded to fit the size limit.
- Any error thrown by a `read` rejects that step. Because an interrupted read re-runs on resume, reads must have no side effects.
- Unknown capability ids and invalid inputs fail the Script before any step is stored.

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

With two or more open tasks and no policy entry for `tasks`, the `tasks.remove` call waits for an operator Approval and then records one Effect. A bot with `"tasks.remove": "allow"` skips the Approval, and one with `"tasks": "deny"` refuses the call. With one open task it runs at once and still records an Effect.

## Remote MCP tools

`@der/mcp` (`integrations/mcp/src/mcp-tools.ts`) is an integration that uses `listCapabilities`. For each tool of each configured server it registers `mcp.<server>.<tool>`. Characters outside `[A-Za-z0-9_$]` in the server id or tool name become `_`, and a name that starts with a digit gets a leading `_`; two tools that map to the same id fail the integration with `mcp.duplicate_capability_id`. Every MCP capability is a `write` with `approval: "always"` as its default, unless the tool is named in the server's `readOnlyTools` or the server sets `defaultRequiresApproval: false`. In both cases `approval` is `"none"`. A tool outside `allowedTools` (when set) is not registered. The server reads the server list from `DER_MCP_SERVERS_JSON`.

## Run usage and context mode

A Run (`GET /api/runs/:runId`) carries two extra fields:

- `usage`: `null` until the Run finishes, then `inputTokens`, `cachedInputTokens`, `cacheWriteTokens`, `outputTokens` and `reportedCostUsd`. The cache fields and the cost are `null` when the engine does not report them.
- `contextMode`: `"resumed"` or `"rebuilt"`; `null` for a Script Run. The README section "Session resume" says when a Run rebuilds.

`reportedCostUsd` is the vendor's figure, cumulative per vendor session, so do not sum it across Runs.

`GET /api/sessions/:sessionId/runs` lists the Session's Runs, newest first, as `{ runs }`. An unknown session returns `404` with code `session.not_found`.

`GET /api/runs/:runId/events` can send a `CUSTOM` chunk named `der.attempt-reset` when the engine step starts over. Discard the text streamed so far for that Run and render the chunks that follow.
