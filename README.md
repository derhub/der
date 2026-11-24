# der

Self-hosted personal coworker platform built on [Bun](https://bun.sh), [SQLite](https://www.sqlite.org) WAL, [Restate](https://restate.dev), [Hono](https://hono.dev), [TanStack AI](https://tanstack.com/ai), [Astryx](https://astryx.atmeta.com) + [StyleX](https://stylexjs.com), and [Vite+](https://viteplus.dev). The Bun server runs official BYO agent harnesses inside hardened containers on a dedicated rootless Docker daemon, gates host effects behind exact-operation durable Approvals, delivers durable CloudEvents through pluggable outbox sinks, and optionally serves the Astryx operator Web console.

## Workspace layout

- `packages/domain` (`@der/domain`): Zod 4.6.7 schemas, compiled boundary parsers, W3C and open-format protocol modules (CloudEvents v1.0, RFC 9457 Problem Details, RFC 3339 UTC timestamps, W3C SSE), narrow storage ports, `WorkflowDriver` / `RunCoordinator` interfaces, and `defineCapability` / `defineIntegration` / `IntegrationRegistry` / `Catalog` / `OutboxSink` contracts.
- `packages/storage` (`@der/storage`): SQLite WAL store implementing the domain storage ports, migrations, replay log, effect ledger, the SQLite `ScriptStore` adapter, session events, Memory Markdown projection, Routine slots, and transactional CloudEvents outbox.
- `packages/runtime` (`@der/runtime`): Hardened rootless Docker launcher, the Docker-hosted Wasmer sandbox behind `sandbox.wasmer`, the Script runner (`quickjs-emscripten` in a Bun Worker), TanStack AI official BYO engine harnesses (`@tanstack/ai-codex`, `@tanstack/ai-claude-code`, `@tanstack/ai-acp` for Codex, Claude Code, and Antigravity ACP) with live subprocess approval callbacks, doctor probes, context compaction, engine session resume, and Agent Skills catalog.
- `integrations/mcp` (`@der/mcp`): Allowlisted MCP integration exported via `defineIntegration`; each remote MCP tool becomes an `mcp.<server>.<tool>` capability.
- `apps/server` (`@der/server`): Singleton Bun server hosting the Hono HTTP/SSE operator API, unified `RunCoordinator`, Restate and direct `WorkflowDriver` implementations, the host capabilities and the `search` / `execute` tools, the Script driver, session event delivery, the `RoutineSchedule` Virtual Object, and `OutboxSender`.
- `apps/web` (`@der/web`): Optional React 19 operator Web console built on `@astryxdesign/core`, `@astryxdesign/theme-neutral`, and `@stylexjs/stylex`.

## Architecture

### Narrow domain storage ports

`@der/domain` (`Store`) splits persistence into six narrow ports so server modules stay independent of SQLite wiring:

- `BotStore`: bot configuration, capability policy, and event chain budget.
- `SessionStore`: sessions and paginated messages.
- `RunStore`: idempotent run admission, status transitions, ordered stream log, and replay. One lifecycle owner (`run-lifecycle` in `@der/storage`) owns every Run status transition and writes the single terminal stream chunk when a Run finishes, first writer wins. Normal stream appends cannot carry terminal chunks, so an engine stream cannot contradict the stored Run status.
- `ApprovalEffectStore`: exact-operation approval requests, decisions, and effect ledger transitions.
- `OutboxStore`: durable outbox queries and delivery recording.
- `RoutineStore`: scheduled routine storage.

### Capability catalog and integrations

Everything an agent can do on the host is a capability: a typed, namespaced function with Zod input and output schemas, an effect class (`read` or `write`), and a default approval rule that each bot's policy can override. Integrations contribute capabilities to one `Catalog` (`@der/domain`); agents reach it only through `search` and `execute`. See [docs/integration-api.md](docs/integration-api.md) for the authoring overview and worked example.

- `defineCapability`: declares one capability. Ids are dot-separated with a namespace (`memory.write`). A `read` cannot require approval; a capability's `approval` rule is the default, overridable by [Per-bot policy](#per-bot-policy).
- `defineIntegration`: declares a lifecycle-managed integration contributing static capabilities, dynamic capabilities discovered on startup, and optional `OutboxSink`s.
- `IntegrationRegistry`: owns the `Catalog`, rejects duplicate integration, capability, or sink registrations, and validates inputs and outputs against capability schemas.
- `OutboxSink`: delivery-only outbound contract consumed by `OutboxSender`. Undelivered outbox rows remain durably retained in SQLite and retry transient failures with exponential backoff.

`GET /api/capabilities` exposes the catalog (schemas, effect class, default approval, example), which the web console lists on the Readiness tab.

The `host` integration contributes:

- `memory.read`, `skills.list`, `skills.read`, `sessions.list`, `sessions.messages`, `routines.list`, `catalog.search`: reads, no approval.
- `memory.write`, `routines.create`, `routines.update`, `sandbox.docker`, `sandbox.wasmer`: writes, approval on every call by default.
- `fixture.apply`, `fixture.uncertain`: writes with approval, registered only when the `fixture` engine is enabled or `DER_SEED_FIXTURE=true`.
- `mcp.<server>.<tool>`: one write capability per allowed tool of each configured MCP server (`@der/mcp`), requiring approval by default unless marked read-only or opted out in server config.

### Code mode: `search` and `execute`

Every engine Run receives exactly two host tools, plus instructions describing them:

- `search({ query })` returns TypeScript declarations, summaries, and examples for matching capabilities so the agent works from real schemas rather than guessing input shapes.
- `execute({ script, key? })` runs a sandboxed Script. If it finishes within the inline wait, `execute` returns the result directly; otherwise it returns `pending` with any proposed writes waiting on Approval and delivers the final outcome later as a session event. `execute` never throws.

A Script is the body of an async function that invokes capabilities with `await step.run(id, input)` and returns plain JSON:

```js
const { hits } = await step.run("catalog.search", "append note");
const { memory } = await step.run("memory.read", {});
return { matches: hits.map((hit) => hit.id), memoryVersion: memory?.version ?? null };
```

- `step.run(id, input)` starts a step immediately; steps started before the next `await` (or grouped via `step.all`, `step.allSettled`, or `Promise` combinators) run concurrently. Writes still apply one at a time in step order, so `await` writes sequentially when ordering matters.
- A failed step, denied or expired Approval, or policy refusal rejects only that step's promise. Catching it lets the Script continue; an uncaught or unobserved rejection fails the Script. Earlier writes stay applied; nothing rolls back.
- Scripts run in `quickjs-emscripten` inside an empty-environment Bun Worker with no network, filesystem, process env, timers, modules, `eval`, or `Function`. Clock and randomness derive from recorded execution inputs so re-runs are deterministic. (`sandbox.wasmer` is a separate capability, not the Script engine.)
- Server config (`Config` in `apps/server`) bounds steps, in-flight calls, guest CPU time, guest memory, guest output, serialized result size, inline wait, sweep cadence, and approval timeout. Hitting a limit stops the Script and reports which writes already applied. Serialized results cross one size boundary (`result-boundary` in `apps/server`) for both inline `execute` responses and event Run payloads.

### Script execution

Script state lives behind `ScriptStore` (SQLite adapter), driven under a lease by `ScriptDriver` so only one driver advances an execution at a time. Restate drives agent Runs and routines, not Scripts; `DER_RESTATE_MODE` does not change Script execution.

- **No write twice:** every step is validated against the catalog and stored before running. Reads cache their result with the step and never re-run; writes apply once through the effect ledger. A write whose outcome is unknown (crash mid-call or unexpected host error) is never repeated: the execution ends `in_doubt`, an active owning Run is interrupted, and further writes in that Run are blocked while doubt remains.
- **Same key, same execution:** within a Run, an execution is identified by Script text and optional `key` (absent and empty match). Calling `execute` again with the same Script and key reattaches while running and returns the stored result once finished, so reattaching after a vendor tool timeout (such as Codex's default timeout) never repeats writes. Pass a new `key` to run the same Script again intentionally.
- **Resume is a re-run:** after a restart or Approval decision, the Script runs from the top in a fresh sandbox and replays stored step results in their original delivery order. Diverging from stored steps or hitting a changed or removed capability stops the execution without applying further writes.
- **Denial stops one step:** writes waiting on Approval at the same point are requested together; denying or expiring one rejects only that step so independent work can proceed.
- **Run end and pending detachment:** ending a Run cancels unfinished Scripts that have not returned `pending` and expires their pending Approvals. A Script that already returned `pending` continues running independently after its Run ends.

### Per-bot policy

A bot's `capabilityPolicy` maps a capability id or dotted namespace to `allow`, `ask`, or `deny`. The most specific match wins (exact id, then longest namespace, then the capability's default `approval`). A read set to `ask` still runs without prompting; `deny` refuses the step without invoking it. Policy is recorded when a step is first stored, so later policy edits affect only new steps. Policy is configured via the bot API or the web console; agents have no capability to edit policy.

`PATCH /api/bots/:botId`:

```json
{ "capabilityPolicy": { "memory.write": "allow", "mcp": "ask", "sandbox": "deny" } }
```

### Pending Scripts and events

When `execute` returns `pending`, the Script keeps running and records a `script.finished` session event on completion. Event delivery turns queued events into `event`-origin Runs:

- Events wait while the session has an active Run and deliver oldest first once the session is idle.
- **Chain budget resets on human messages:** a per-bot `eventChainLimit` caps consecutive event Runs so event chains cannot loop indefinitely. Only a human-started Run (`http`, `web`, or `telegram`) resets the count; routine Runs do not. Excess events stay queued until a human Run runs.
- Event Run messages cross the same result-size boundary as inline `execute` results, preserving the outcome and accounting for unknown-outcome writes.
- Event Runs cannot be posted through the HTTP API and pass the same unattended eligibility gate as routine Runs.
- **Direct-mode recovery:** every active Run has a driver. Direct startup recovers active Runs from an exhaustive status-and-origin table: queued Runs start, Script Runs resume, and in-progress non-Script Runs (which hold no saved engine state in direct mode) end `interrupted` so the session's next event can deliver. An engine failure or stream rejection ends the Run as failed through the lifecycle owner and runs the same finish hook.

### Script routines

A Routine carries either a `prompt` or a `script`. A script routine fires a Run with engine `script`: no engine adapter starts, no unattended-terms check applies, and writes requiring approval per bot policy ask on each firing. The `script` engine can only be triggered by a Routine, not through chat or run routes.

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
- Script execution limits, inline wait, sweep interval, result cap, and approval timeout: see `Config` in `apps/server` (`config.ts`).
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
