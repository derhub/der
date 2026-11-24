# der

Self-hosted personal coworker platform built on [Bun](https://bun.sh), [SQLite](https://www.sqlite.org) WAL, [Restate](https://restate.dev), [Hono](https://hono.dev), [TanStack AI](https://tanstack.com/ai), [Astryx](https://astryx.atmeta.com) + [StyleX](https://stylexjs.com), and [Vite+](https://viteplus.dev). The Bun server runs official BYO agent harnesses inside hardened containers on a dedicated rootless Docker daemon, gates host effects behind exact-operation durable Approvals, delivers durable CloudEvents through pluggable outbox sinks, and optionally serves the Astryx operator Web console.

## Workspace layout

- `packages/domain` (`@der/domain`): Zod 4.6.7 schemas, compiled boundary parsers, W3C and open-format protocol modules (CloudEvents v1.0, RFC 9457 Problem Details, RFC 3339 UTC timestamps, W3C SSE), narrow storage ports, `WorkflowDriver` / `RunCoordinator` interfaces, and `defineCapability` / `defineIntegration` / `IntegrationRegistry` / `Catalog` / `OutboxSink` contracts.
- `packages/storage` (`@der/storage`): SQLite WAL store implementing the domain storage ports, migrations, replay log, effect ledger, the SQLite `ScriptStore` adapter (`packages/storage/src/script-store.ts`), session events (`packages/storage/src/session-events.ts`), Memory Markdown projection, Routine slots, and transactional CloudEvents outbox.
- `packages/runtime` (`@der/runtime`): Hardened rootless Docker launcher, the Docker-hosted Wasmer sandbox behind `sandbox.wasmer`, the Script runner (`quickjs-emscripten` in a Bun Worker), TanStack AI official BYO engine harnesses (`@tanstack/ai-codex`, `@tanstack/ai-claude-code`, `@tanstack/ai-acp` for Codex, Claude Code, and Antigravity ACP) with live subprocess approval callbacks, doctor probes, context compaction, engine session resume, and Agent Skills catalog.
- `integrations/mcp` (`@der/mcp`): Allowlisted MCP integration exported via `defineIntegration`; each remote MCP tool becomes an `mcp.<server>.<tool>` capability.
- `apps/server` (`@der/server`): Singleton Bun server hosting the Hono HTTP/SSE operator API, unified `RunCoordinator`, Restate and direct `WorkflowDriver` implementations, the host capabilities and the `search` / `execute` tools, the Script driver (`apps/server/src/scripts/`), session event delivery (`apps/server/src/events/`), the `RoutineSchedule` Virtual Object, and `OutboxSender`.
- `apps/web` (`@der/web`): Optional React 19 operator Web console built on `@astryxdesign/core`, `@astryxdesign/theme-neutral`, and `@stylexjs/stylex`.

## Architecture

### Narrow domain storage ports

`packages/domain/src/interfaces/store.ts` splits persistence into six narrow ports composed by `Store`:

- `BotStore`: bot CRUD (`createBot`, `getBot`, `listBots`, `updateBot`).
- `SessionStore`: session CRUD and paginated message reads (`createSession`, `getSession`, `listSessions`, `listMessages`).
- `RunStore`: idempotent run admission, status transitions, ordered event log, stream state, and replay (`admit`, `getRun`, `markRunRunning`, `appendRunEvents`, `getRunStreamState`, `readRunEventsAfter`, `replay`, `finishRun`).
- `ApprovalEffectStore`: exact-operation approval requests, decisions, and effect ledger state transitions (`requestApproval`, `getApproval`, `getLatestApprovalForRun`, `decide`, `beginEffect`, `completeEffect`, `markEffectUnknown`, `getEffect`).
- `OutboxStore`: durable outbox queries and delivery recording (`listOutboxEvents`, `listDueOutboxEvents`, `recordOutboxDelivery`).
- `RoutineStore`: scheduled routine storage (`createRoutine`, `getRoutine`).

`apps/server/src/http`, `apps/server/src/workflows`, and `apps/server/src/messaging` depend only on these narrow ports. Concrete SQLite wiring stays in `packages/storage` and `apps/server/src/main.ts`.

### Capability catalog and integrations

Everything an agent can do on the host is a capability: a typed, namespaced function with an input schema, an output schema, an effect class (`read` or `write`) and a default approval rule that each bot's policy can override. Capabilities live in one `Catalog` (`packages/domain/src/interfaces/capability.ts`). Integrations contribute to it; agents reach it only through the `search` and `execute` tools described below. The full integration API, with a worked example, is in [docs/integration-api.md](docs/integration-api.md).

- `defineCapability`: declares one capability (`id`, `description`, Zod `input` and `output`, `effect`, `approval` `"none" | "always" | predicate`, optional `example`, `execute`). Ids are dot-separated identifiers with a namespace (`memory.write`). A `read` cannot require approval. `approval` is the default: a bot's policy (see [Per-bot policy](#per-bot-policy)) can allow, ask or deny a capability regardless of it.
- `defineIntegration`: declares a lifecycle-managed integration (`id`, `setup(ctx)`) returning an `IntegrationContribution` of static `capabilities`, a dynamic `listCapabilities`, `outboxSinks`, and optional `start` / `stop` hooks.
- `IntegrationRegistry`: owns the `Catalog`. It rejects duplicate integration IDs, duplicate capability IDs and duplicate `OutboxSink` kinds with a `409` `DomainError`. The catalog validates input against the capability's schema before `execute` and parses the output after it.
- `OutboxSink`: delivery-only outbound contract (`kind`, `deliver(destination, event)`) consumed by `OutboxSender` (`apps/server/src/messaging/outbox-sender.ts`). When no sink is registered for a destination or a destination is disabled, due outbox rows remain durably retained in SQLite. Transient delivery failures retry with exponential backoff (`DER_OUTBOX_POLL_INTERVAL_MS`, `DER_OUTBOX_INITIAL_BACKOFF_MS`, `DER_OUTBOX_MAX_BACKOFF_MS`).

`GET /api/capabilities` returns the catalog as `{ capabilities }`, each entry with `id`, `description`, `effect`, `requiresApproval`, `inputSchema`, `outputSchema` and `example`. The web console lists it on the Readiness tab.

The `host` integration (`apps/server/src/main.ts`, `apps/server/src/capabilities/`) contributes:

- `memory.read`, `skills.list`, `skills.read`, `sessions.list`, `sessions.messages`, `routines.list`, `catalog.search`: reads, no approval.
- `memory.write`, `routines.create`, `routines.update`, `sandbox.docker`, `sandbox.wasmer`: writes, approval on every call by default.
- `fixture.apply`, `fixture.uncertain`: writes with approval, registered only when the `fixture` engine is enabled or `DER_SEED_FIXTURE=true`.
- `mcp.<server>.<tool>`: one capability per tool of each server in `DER_MCP_SERVERS_JSON`, registered by `@der/mcp`. Server id and tool name are sanitised to identifier characters. Each is a `write`; it requires approval unless the tool is listed in the server's `readOnlyTools` or the server sets `defaultRequiresApproval` to `false`.

### Code mode: `search` and `execute`

An engine run receives exactly two tools (`apps/server/src/main.ts`), plus system instructions that describe them (`apps/server/src/code-mode/instructions.ts`):

- `search({ query })` returns TypeScript declarations, a one-line summary and an example for the capabilities that match, best match first (`apps/server/src/code-mode/search.ts`). Input shapes come from these declarations; the agent does not guess them.
- `execute({ script })` runs a Script (`apps/server/src/code-mode/execute.ts`). It waits up to `DER_SCRIPT_INLINE_WAIT_MS` for the Script to end. A Script that ends in time returns `{ ok: true, result, logs, truncated }` or `{ ok: false, error: { kind, message }, logs }`. A Script still running returns `{ status: "pending", executionId, proposedWrites }` and its result arrives later as an event (see [Pending Scripts and events](#pending-scripts-and-events)). `execute` never throws. `kind` is one of `script`, `denied`, `expired`, `limit`, `capability`, `cancelled`, `nondeterministic`.

A Script is the body of an async function. It performs capabilities with `await step.run(id, input)` and gives its result back with `return`:

```js
const { hits } = await step.run("catalog.search", "append note");
const { memory } = await step.run("memory.read", {});
return { matches: hits.map((hit) => hit.id), memoryVersion: memory?.version ?? null };
```

- `step.run(id, input)` performs one capability. `id` is a capability id as a string and `input` is plain JSON. The promise resolves with the capability's output. The catalog says whether the capability is a read or a write; the Script does not.
- `step.all([...])` and `step.allSettled([...])` wait for several steps or async branches. `Promise.all`, `allSettled`, `race` and `any` also work on steps.
- A step starts when `step.run` is called. Steps started before the next `await` run together. Writes apply one at a time, lowest position first, so `await` writes one after another when their order matters.
- A failed step, a denied or expired Approval and a policy refusal reject that step's promise with an error carrying `kind` (`failed`, `denied`, `expired` or `refused`), `message`, `step`, `capability` and `input`. Only that step is rejected; a `try`/`catch` continues the Script, and an uncaught error ends it.
- A step that is started and never awaited still runs. If it was rejected and nothing observed it, the Script fails when it ends.
- A Script that fails or hits a limit leaves its earlier writes applied. Nothing is rolled back.

What a Script can and cannot reach:

- It reaches capabilities and nothing else. It runs in `quickjs-emscripten` inside a Bun Worker started with an empty environment (`packages/runtime/src/script/script-runner.ts`, `script-worker.ts`). There is no network, filesystem, process environment or timer.
- Modules and `import` are not available, and `eval` and `new Function` are unavailable; using them fails as a `script` error (`packages/runtime/src/script/guest-step.ts`).
- `Date` and `Math.random` derive from the execution's recorded start time and seed, and `performance.now` is constant, so a re-run sees the same values. A Script must not branch on anything else that changes between runs.
- Wasmer is not part of the Script engine. It backs only the `sandbox.wasmer` capability.

Limits are server config (`apps/server/src/config.ts`). A step, in-flight or element limit ends the Script with kind `limit` and lists the writes already applied.

- `DER_SCRIPT_MAX_STEPS` (default `2000`): steps per execution.
- `DER_SCRIPT_MAX_IN_FLIGHT` (default `2000`): steps started and not yet answered.
- `DER_SCRIPT_MAX_ALL` (default `1000`): elements per `step.all` or `step.allSettled`.
- `DER_SCRIPT_ACTIVE_MS` (default `30000`): time spent running guest code. Time spent waiting for a step or an Approval does not count.
- `DER_SCRIPT_MEMORY_BYTES` (default `268435456`): memory limit of the guest.
- `DER_SCRIPT_OUTPUT_BYTES` (default `1048576`): total bytes the guest sends to the host (logs, step inputs and the result).
- `DER_SCRIPT_RESULT_BYTES` (default `65536`): size cap on what `execute`, `search` and `catalog.search` hand back to the agent. A larger `execute` result is cut and flagged `truncated: true`; logs past the cap are dropped; `search` keeps at least one hit.
- `DER_SCRIPT_INLINE_WAIT_MS` (default `3000`): how long `execute` waits before it returns `pending`. `0` returns `pending` at once.
- `DER_SCRIPT_SWEEP_INTERVAL_MS` (default `1000`): how often the Script driver expires overdue Approvals, resumes executions that no driver holds, and delivers queued events.
- `DER_APPROVAL_TIMEOUT_MS` (default `300000`): how long an Approval waits before it expires. An expired Approval rejects its step with kind `expired`.

### Script execution

A Script's state lives behind the `ScriptStore` port (`packages/domain/src/interfaces/script-store.ts`), with SQLite as its adapter (`packages/storage/src/script-store.ts`). The store holds the Script text, one row per execution (status `running`, `waiting_approval`, `completed`, `failed`, `cancelled`, `interrupted` or `in_doubt`, and the final result) and one row per step (position, capability, input, status, delivery order, result or error). The driver (`apps/server/src/scripts/script-driver.ts`, `script-execution.ts`) runs each execution under a lease, so one driver owns it at a time. Restate drives agent Runs and routines, not Scripts; `DER_RESTATE_MODE` does not change how a Script runs.

- A step's identity is the execution and its position, the n-th `step.run` call. The step is stored before it is performed. The catalog checks the capability id and the input (`validateInput`) before the step is stored; an unknown id or invalid input ends the Script with kind `capability` and stores nothing.
- A read runs at once and its result is stored. A stored read is never invoked again.
- A write is stored, resolved against the bot's policy, and applied once through the effect ledger. Where policy says `ask`, an Approval for the exact capability and arguments is requested first. Writes waiting for an Approval at the same moment are requested together.
- A denied or expired Approval rejects that step only. The rest of the Script carries on.
- Resume is a re-run. After a restart or an Approval decision the execution runs the Script again from the top in a fresh sandbox, and each step returns its stored result in the order it was first delivered. Nothing is performed twice.
- A re-run that asks for a different capability, input or position than the stored one ends as `failed` with kind `nondeterministic` and applies nothing further.
- A write whose outcome is unknown (the server stopped after the request left and before the answer was stored, or the capability threw something other than a `DomainError`) is never repeated. The execution ends `in_doubt` with kind `capability`, and the owning Run is interrupted with `effect.outcome_uncertain`. A later write in that Run fails while the write is in doubt.
- If a Run ends (finished, cancelled or interrupted) while its Script is unfinished and has not returned `pending`, the Script is cancelled. A step already running gets up to ten seconds to finish, pending Approvals expire, and the Script ends with kind `cancelled`. The `signal` a capability receives aborts when the server closes, not when a Script is cancelled. A Script that returned `pending` keeps running after its Run ends.
- A repeated `execute` with the identical Script returns the same execution, or its stored result once it has finished, until that result was handed over. After that the same Script runs again, so repeating a Script on purpose works.
- der does not change Codex's tool timeout, so Codex may end a long `execute` call; calling `execute` again with the same Script reattaches.

### Per-bot policy

A bot's `capabilityPolicy` maps a capability id or a dotted namespace to `allow`, `ask` or `deny`. The most specific key wins: the exact id, then the longest matching namespace (`mcp.github` before `mcp`), then the capability's own `approval` (`ask` when it requires approval for that input, otherwise `allow`). A read set to `ask` runs without asking. `deny` rejects the step with kind `refused` without performing it. Policy is read when a step is first stored, so a change applies to new steps, not to stored ones.

Set it on create or with `PATCH /api/bots/:botId`, or in the bot editor of the web console. The `PATCH` field replaces the whole map. Agents have no capability that changes policy.

`PATCH /api/bots/:botId`:

```json
{ "capabilityPolicy": { "memory.write": "allow", "mcp": "ask", "sandbox": "deny" } }
```

### Pending Scripts and events

When `execute` returns `pending`, the Script keeps running. `proposedWrites` lists the writes now waiting for an Approval, each with `position`, `capability` and `input`. When the Script ends, the host stores a `script.finished` event (`event`, `executionId`, `status`, `result`) for the session. Events are delivered as Runs with origin `event` (`apps/server/src/events/event-delivery.ts`):

- An event waits while its session has an active Run, and is delivered when the session is idle, oldest first.
- At most `eventChainLimit` event Runs follow one non-event Run in a session. A Run from a human message or a routine resets the count. Further events stay queued until then. `eventChainLimit` is a bot setting (default `3`), changed with `PATCH /api/bots/:botId`.
- The Run's message is the event as JSON, with the Script result cut to `DER_SCRIPT_RESULT_BYTES`.
- An event Run has no human present and passes the same unattended gate as a routine Run.
- Origin `event` cannot be posted through the HTTP API (`apps/server/src/http/router.ts`).

### Script routines

A Routine carries either a `prompt` or a `script` (`packages/domain/src/schemas/routine.ts`). Create one with `POST /api/bots/:botId/routines` and a `script` field instead of `prompt`, or update it with `PATCH /api/routines/:routineId`; the `routines.create` and `routines.update` capabilities take the same fields. A script routine fires a Run with engine `script`: the Script runs as above, no engine adapter starts, and no unattended-terms check applies. The Script's result becomes the assistant message (`Script result: <json>`), and a failed Script fails the Run with code `script.<kind>`. Writes that policy sets to `ask` request an Approval on every firing. The `script` engine cannot be chosen on the chat and run routes; only a Routine firing selects it.

### Session resume

On Claude Code and Antigravity a Run resumes the vendor CLI's session instead of sending the whole conversation again. Codex does not resume yet; every Codex Run rebuilds its context from the stored messages. `Run.contextMode` reports `resumed` or `rebuilt`.

A Run rebuilds when:

- it runs on Codex, or on a different engine than the previous Run of the Session;
- the previous Run did not complete, or was a Script Run;
- the Bot's persona, a system message or the engine model changed;
- more than 200 messages arrived since the previous Run, or any of them is not plain user text;
- the vendor refuses the stored session. The Run then retries once as a rebuild.

A memory or skill edit reaches a resumed session with the next user message. A resumed Claude Code session keeps its original system prompt until it rebuilds.

### RunCoordinator and workflow drivers

`apps/server/src/workflows/coordinator.ts` provides a single `RunCoordinator` that owns run admission, engine execution, live approval waits, effect ledger transitions, and terminal finalization. Execution runs behind the `WorkflowDriver` seam (`packages/domain/src/interfaces/workflow.ts`):

- Restate driver (`apps/server/src/workflows/restate-workflows.ts`, `DER_RESTATE_MODE=restate`): durable step execution (`ctx.run`), awakeable-backed approval waits, and the `RoutineSchedule` Virtual Object (`apps/server/src/workflows/routine-schedule.ts`).
- Direct driver (`apps/server/src/workflows/direct-workflow.ts`, `DER_RESTATE_MODE=direct`): thin in-process driver over the same `RunCoordinator` for local development and fast test runs without a Restate server.

These drivers carry agent Runs and routines. Scripts run on the Script driver in both modes.

### Hono HTTP/SSE server and wire standards

`apps/server/src/http/router.ts`, `apps/server/src/http/sse.ts`, and `apps/server/src/http/problem.ts` implement `/healthz` and `/api/*` on Hono while enforcing `der`'s open-format standards:

- CloudEvents v1.0 (`packages/domain/src/protocol/cloud-events.ts`): event types follow `der.<domain>.<past-tense-event>` (`der.chat.replied`, `der.approval.requested`, `der.routine.finished`) with `source: /bots/<botId>` and `datacontenttype: application/json`.
- RFC 9457 Problem Details (`packages/domain/src/protocol/problem-details.ts`): errors return `application/problem+json` with `type: https://der.invalid/problems/<slug>`, `title`, `status`, `detail`, `instance`, and lowercase machine-readable `code`.
- RFC 3339 UTC timestamps (`packages/domain/src/protocol/timestamp.ts`): all protocol timestamps use UTC ending in `Z`.
- W3C SSE (`packages/domain/src/protocol/sse.ts`, `apps/server/src/http/sse.ts`): `GET /api/runs/:runId/events` streams `text/event-stream; charset=utf-8` frames with `event: message`, resumes from `Last-Event-ID` or `?after=`, emits keep-alive comments, and returns HTTP `204` when reconnecting at a terminal sequence.

### Operator web console

`apps/web` provides a five-tab operator console (Chat, Memory, Routines, Readiness, Skills) built on `@astryxdesign/core`, `@astryxdesign/theme-neutral`, and `@stylexjs/stylex`. Chat streaming and tool/approval rendering use Astryx's native chat primitives (`ChatLayout`, `ChatMessageList`, `ChatMessage`, `ChatComposer`, `ChatSendButton`, `ChatToolCalls`) connected to `/api/*` and resumable SSE.

## Start Phase 1 base deployment

The base Compose file (`docker-compose.yml`) runs a private Restate runtime (`restate`) and the Bun server (`server`) bound to loopback `127.0.0.1:3000`.

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/api/engines
```

Key base settings:

- `DER_HTTP_PORT`: Loopback port published on `127.0.0.1` (default `3000`).
- `DER_ALLOWED_ORIGINS`: Comma-separated canonical `http(s)` origins permitted for mutating JSON requests.
- `DER_SKILLS_HOST_DIR`: Host directory mounted read-only to `/data/skills` (default `./docker/skills`).
- `DER_SEED_FIXTURE`: Set to `true` only to seed the credential-free `fixture` Bot and Session.
- `DER_RESTATE_MODE`: `restate` (default) for durable Restate workflows of agent Runs and routines, or `direct` for in-process execution. It does not change how a Script runs.
- `DER_OUTBOX_POLL_INTERVAL_MS`, `DER_OUTBOX_INITIAL_BACKOFF_MS`, `DER_OUTBOX_MAX_BACKOFF_MS`: Outbox polling interval and exponential backoff bounds.
- `DER_SCRIPT_INLINE_WAIT_MS`, `DER_SCRIPT_SWEEP_INTERVAL_MS`, `DER_SCRIPT_MAX_STEPS`, `DER_SCRIPT_MAX_IN_FLIGHT`, `DER_SCRIPT_MAX_ALL`, `DER_SCRIPT_ACTIVE_MS`, `DER_SCRIPT_MEMORY_BYTES`, `DER_SCRIPT_OUTPUT_BYTES`, `DER_SCRIPT_RESULT_BYTES`, `DER_APPROVAL_TIMEOUT_MS`: inline wait, sweep interval, Script limits and Approval wait; defaults are under [Code mode](#code-mode-search-and-execute).
- `DER_MEMORY_PROMPT_MAX_BYTES`: Size cap of the memory text in the system prompt (default `24000`, minimum `1024`). Longer text ends with a `[truncated: the rest is available through the memory capability]` line.
- `DER_SKILL_CATALOG_MAX_BYTES`: Same cap for the skill catalog (default `8000`, minimum `1024`).
- `DER_CONTEXT_MAX_TOKENS`: Token budget a rebuilt conversation is compacted to (default `32000`).
- `DER_ENGINE_COMPACT_TOKENS`: Auto-compact window passed to Claude Code and Codex (default `100000`). Antigravity has none.
- `DER_MCP_SERVERS_JSON`: JSON array of remote MCP servers whose tools become `mcp.<server>.<tool>` capabilities.

## Configure dedicated rootless Docker daemon and shadow-home logins

Live official engines require a dedicated rootless Docker daemon. Never mount `/var/run/docker.sock` or host `~/.codex`, `~/.claude`, or `~/.gemini` directories into containers.

1. Start a dedicated rootless Docker daemon on the host (for example via `dockerd-rootless.sh`) and record its socket path in `DER_DOCKER_HOST` (such as `unix:///run/der-rootless/docker.sock`).
2. Bind-mount the rootless socket directory into the `server` container and set `DER_DOCKER_HOST` so engine doctor probes verify rootless mode, cgroup memory/CPU/PIDs limits, `--cap-drop=ALL`, and `no-new-privileges`.
3. Build the official engine images from `docker/Dockerfile.engines` on the rootless daemon:

```bash
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker build -f docker/Dockerfile.engines --target der-engine-codex -t der-engine-codex:latest .
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker build -f docker/Dockerfile.engines --target der-engine-claude-code -t der-engine-claude-code:latest .
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker build -f docker/Dockerfile.engines --target der-engine-antigravity -t der-engine-antigravity:latest .
```

4. Provision the named per-engine shadow-home volumes on that rootless daemon and complete interactive official CLI login inside each volume:

```bash
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker volume create der-home-codex
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker volume create der-home-claude-code
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker volume create der-home-antigravity

# Codex interactive login
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker run --rm -it \
  --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges:true \
  --mount type=volume,source=der-home-codex,target=/home/engine \
  der-engine-codex:latest codex login --device-auth

# Claude Code interactive login
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker run --rm -it \
  --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges:true \
  --mount type=volume,source=der-home-claude-code,target=/home/engine \
  der-engine-claude-code:latest claude login

# Antigravity ACP login (after supplying AGY_CLI_URL and AGY_CLI_SHA256 at build time)
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock docker run --rm -it \
  --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges:true \
  --mount type=volume,source=der-home-antigravity,target=/home/engine \
  der-engine-antigravity:latest agy acp --login
```

Check `GET /api/engines` after login. Failed isolation controls block interactive and unattended readiness, and unverified unattended terms coverage keeps scheduled Routine execution disabled.

## Run the live Phase 1 smoke check

`scripts/smoke-phase-one.sh` starts an isolated Compose project using `docker-compose.yml` and `docker-compose.smoke.yml`, verifies rootless Docker and Wasmer containment, restarts both Restate and the Bun server during a pending Approval, checks resumable SSE plus terminal HTTP 204, verifies SQLite WAL contention and outbox rows, and removes its temporary project resources on exit.

```bash
bash scripts/smoke-phase-one.sh
```

Set `DER_ROOTLESS_DOCKER_SOCKET=/run/user/$(id -u)/docker.sock` to reuse an existing rootless daemon; otherwise the script starts and tears down an ephemeral `dockerd-rootless.sh` instance.

## Enable the optional Web UI overlay

Combine `docker-compose.web.yml` with the base deployment to serve the Astryx operator UI alongside the loopback API:

```bash
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d --build
```

Ensure `DER_ALLOWED_ORIGINS` includes the Web UI's canonical origin.

## Verify locally

```bash
bun run test
docker compose -f docker-compose.yml -f docker-compose.web.yml config --quiet
```

## Contributor notes

Do not import through a `src` path (`../src/...`, `@der/domain/src/...`). The lint rule `no-restricted-imports` in `vite.config.ts` rejects any specifier matching `(^|/)src(/|$)`. Import a package by name (`@der/<pkg>`), `apps/server` by its `#` imports map (`"#*": "./src/*.ts"` in `apps/server/package.json`), and `apps/web` by the `@/` alias.
