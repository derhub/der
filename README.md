# der

Self-hosted personal coworker platform built on [Bun](https://bun.sh), [SQLite](https://www.sqlite.org) WAL, [Restate](https://restate.dev), [TanStack AI](https://tanstack.com/ai), and [Vite+](https://viteplus.dev). The Bun server runs official BYO engines inside hardened containers on a dedicated rootless Docker daemon, gates host effects behind exact-operation durable Approvals, and optionally serves the Web UI and Telegram bot channel over the same scoped commands.

## Workspace layout

- `packages/domain`: Zod 4.6.7 schemas, compiled boundary parsers, RFC 9457 Problem Details, SSE framing, CloudEvents v1.0 (`der.*`), and domain interfaces (`@der/domain`).
- `packages/storage`: SQLite WAL store, migrations, replay log, effect ledger, Memory Markdown projection, Routine slots, and transactional outbox (`@der/storage`).
- `packages/runtime`: Hardened rootless Docker launcher, Wasmer WASI/WASIX runner, official BYO engine wrappers (`codex`, `claude-code`, `antigravity`), doctor probes, context compaction, and Agent Skills catalog (`@der/runtime`).
- `integrations/mcp`: Allowlisted MCP and Home Assistant tools with exact-operation approval checks (`@der/mcp`).
- `integrations/telegram`: Telegram Bot API long-polling adapter, callback encoding, and CloudEvent formatter using Bun Fetch (`@der/telegram`).
- `apps/server`: Singleton Bun HTTP/SSE operator API, Restate Fetch workflow host, RoutineSchedule Virtual Object, and messaging runtime (`@der/server`).
- `apps/web`: Optional React operator Web UI (`@der/web`).

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
- `DER_SEED_FIXTURE`: Set to `true` only to seed the credential-free `fixture` Bot, Session, and binding.

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

Combine `docker-compose.web.yml` with the base deployment to serve the React operator UI alongside the loopback API:

```bash
docker compose -f docker-compose.yml -f docker-compose.web.yml up -d --build
```

Ensure `DER_ALLOWED_ORIGINS` includes the Web UI's canonical origin.

## Enable the optional Telegram overlay and channel bindings

Telegram integration is opt-in and disabled by default in `docker-compose.yml`. When disabled, `outbox_events` rows remain durably queued in SQLite and no Telegram polling or outbound calls run.

1. Create a bot with Telegram BotFather and keep `DER_TELEGRAM_BOT_TOKEN` strictly in runtime environment variables or a host-only `.env` file outside version control. The adapter and server redact the token and Telegram token patterns from error details and logs.
2. Create a Bot and Session via the operator API (`POST /api/bots`, `POST /api/bots/{botId}/sessions`) or use an existing Bot/Session scope, and record the numeric Telegram `chat.id` and operator `from.id` as strings.
3. Configure one or more authorized `ChannelBinding` entries in `DER_TELEGRAM_BINDINGS_JSON` and start the Telegram overlay (standalone or combined with Web):

```bash
export DER_TELEGRAM_BOT_TOKEN="<bot-token>"
export DER_TELEGRAM_BINDINGS_JSON='[
  {
    "externalChatId": "-1001234567890",
    "externalActorId": "123456789",
    "botId": "bot-fixture",
    "sessionId": "sess-fixture",
    "enabled": true
  }
]'

docker compose -f docker-compose.yml -f docker-compose.telegram.yml up -d --build

# Or with both Web and Telegram overlays:
docker compose -f docker-compose.yml -f docker-compose.web.yml -f docker-compose.telegram.yml up -d --build
```

Telegram runtime settings:

- `DER_TELEGRAM_ENABLED`: Set to `true` (default in `docker-compose.telegram.yml`) to run polling and outbox delivery; set to `false` to disable without clearing other variables.
- `DER_TELEGRAM_BOT_TOKEN`: Required when Telegram is enabled. Never written to SQLite, API responses, or logs.
- `DER_TELEGRAM_API_BASE_URL`: Bot API origin (default `https://api.telegram.org`).
- `DER_TELEGRAM_CONSUMER`: Durable cursor and receipt consumer name (default `telegram-default`).
- `DER_TELEGRAM_POLL_TIMEOUT_SECONDS`: Long-polling timeout between `0` and `50` seconds (default `25`).
- `DER_TELEGRAM_OUTBOX_POLL_INTERVAL_MS`: Singleton outbox sender poll interval in milliseconds (default `500`).
- `DER_TELEGRAM_BINDINGS_JSON`: JSON array of `{ externalChatId, externalActorId, botId, sessionId, enabled }` bindings upserted into SQLite on startup when the referenced Session exists in that Bot's scope.

### Telegram durability and delivery caveats

- **Ordered intake and durable cursor**: Updates are sorted by `update_id` and resumed strictly after the last committed `channel_cursors` position. Each authorized chat message or approval callback invokes the same durable Restate `admit` or `decide` command as HTTP and commits `channel_receipts` plus `channel_cursors` inside the SQLite transaction.
- **Retryable intake preservation**: If a durable command fails transiently (for example `503 restate.unavailable`), no receipt is written, the cursor does not advance, and Telegram callback queries are not acknowledged until a terminal disposition is durable.
- **Scoped approval controls**: `der.approval.requested` outbox events render inline `Approve` and `Deny` buttons carrying compact callback data (`der:a:<approvalId>` / `der:d:<approvalId>`). Inbound callbacks verify that the sender's enabled `ChannelBinding` matches the Approval's exact `botId` and `sessionId` before settling.
- **Possible duplicate outbound delivery after an ambiguous response**: Outbox delivery calls Telegram `sendMessage` outside SQLite transactions and persists delivery receipts, retry deadlines, or terminal failures afterward. If the HTTP response is lost or times out after Telegram already accepted the message, the sender records a retryable failure and retries the same stable `eventId` after backoff or server restart, which can produce a duplicate message in the Telegram chat.

## Verify locally

```bash
vp -C integrations/telegram run test
vp -C apps/server run test -- test/messaging
docker compose -f docker-compose.yml -f docker-compose.telegram.yml config --quiet
```
