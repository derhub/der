# der

Self-hosted personal coworker platform built on [Bun](https://bun.sh), [SQLite](https://www.sqlite.org) WAL, [Restate](https://restate.dev), [Hono](https://hono.dev), [TanStack AI](https://tanstack.com/ai), [Astryx](https://astryx.atmeta.com) + [StyleX](https://stylexjs.com), and [Vite+](https://viteplus.dev). The Bun server runs official BYO agent harnesses inside hardened containers on a dedicated rootless Docker daemon, gates host effects behind exact-operation durable Approvals, delivers durable CloudEvents through pluggable outbox sinks, and optionally serves the Astryx operator Web console.

## Workspace layout

- `packages/domain` (`@der/domain`): Zod 4.6.7 schemas, compiled boundary parsers, W3C and open-format protocol modules (CloudEvents v1.0, RFC 9457 Problem Details, RFC 3339 UTC timestamps, W3C SSE), narrow storage ports, `WorkflowDriver` / `RunCoordinator` interfaces, and `defineIntegration` / `defineTool` / `IntegrationRegistry` / `OutboxSink` contracts.
- `packages/storage` (`@der/storage`): SQLite WAL store implementing the domain storage ports, migrations, replay log, effect ledger, Memory Markdown projection, Routine slots, and transactional CloudEvents outbox.
- `packages/runtime` (`@der/runtime`): Hardened rootless Docker launcher, Wasmer WASI/WASIX runner, TanStack AI official BYO engine harnesses (`@tanstack/ai-codex`, `@tanstack/ai-claude-code`, `@tanstack/ai-acp` for Codex, Claude Code, and Antigravity ACP) with live subprocess approval callbacks, doctor probes, context compaction, and Agent Skills catalog.
- `integrations/mcp` (`@der/mcp`): Allowlisted MCP integration exported via `defineIntegration` with exact-operation approval verification.
- `apps/server` (`@der/server`): Singleton Bun server hosting the Hono HTTP/SSE operator API, unified `RunCoordinator`, Restate and direct `WorkflowDriver` implementations, `RoutineSchedule` Virtual Object, and `OutboxSender`.
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

### Integration and outbox contracts

`packages/domain/src/interfaces/integration.ts` defines the declarative extension surface:

- `defineTool`: declares a typed tool (`id`, `operationKind`, `description`, Zod `inputSchema`, `approval` policy `"none" | "always" | predicate`, and `execute`).
- `defineIntegration`: declares a lifecycle-managed integration (`id`, `setup(ctx)`) returning an `IntegrationContribution` of static `tools`, dynamic `listTools`, `outboxSinks`, and optional `start` / `stop` hooks.
- `IntegrationRegistry`: implements `Tools`, rejects duplicate integration IDs, duplicate tool IDs, and duplicate `OutboxSink` kinds fail-fast with `409` `DomainError`, validates tool arguments against each tool's Zod schema, and checks exact-operation approvals before dispatch.
- `OutboxSink`: delivery-only outbound contract (`kind`, `deliver(destination, event)`) consumed by `OutboxSender` (`apps/server/src/messaging/outbox-sender.ts`). When no sink is registered for a destination or a destination is disabled, due outbox rows remain durably retained in SQLite. Transient delivery failures retry with exponential backoff (`DER_OUTBOX_POLL_INTERVAL_MS`, `DER_OUTBOX_INITIAL_BACKOFF_MS`, `DER_OUTBOX_MAX_BACKOFF_MS`).

### RunCoordinator and workflow drivers

`apps/server/src/workflows/coordinator.ts` provides a single `RunCoordinator` that owns run admission, engine execution, live approval waits, effect ledger transitions, and terminal finalization. Execution runs behind the `WorkflowDriver` seam (`packages/domain/src/interfaces/workflow.ts`):

- Restate driver (`apps/server/src/workflows/restate-workflows.ts`, `DER_RESTATE_MODE=restate`): durable step execution (`ctx.run`), awakeable-backed approval waits, and the `RoutineSchedule` Virtual Object (`apps/server/src/workflows/routine-schedule.ts`).
- Direct driver (`apps/server/src/workflows/direct-workflow.ts`, `DER_RESTATE_MODE=direct`): thin in-process driver over the same `RunCoordinator` for local development and fast test runs without a Restate server.

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
- `DER_RESTATE_MODE`: `restate` (default) for durable Restate workflows or `direct` for in-process execution.
- `DER_OUTBOX_POLL_INTERVAL_MS`, `DER_OUTBOX_INITIAL_BACKOFF_MS`, `DER_OUTBOX_MAX_BACKOFF_MS`: Outbox polling interval and exponential backoff bounds.

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
