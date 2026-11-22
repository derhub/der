#!/usr/bin/env bash
set -euo pipefail

# Live Phase 1 end-to-end smoke check.
# Prerequisites:
#   - Docker Engine with Compose v2 (`docker compose`)
#   - Bun (`bun`) and curl (`curl`)
#   - Either an existing dedicated rootless Docker daemon socket in DER_ROOTLESS_DOCKER_SOCKET
#     (e.g. /run/user/1000/docker.sock) or `dockerd-rootless.sh` + `rootlesskit` + `pasta`/`slirp4netns`
#     so this script can boot an isolated ephemeral rootless daemon and tear it down on exit.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SMOKE_ID="$$-$(date +%s)"
SMOKE_PROJECT="der-smoke-${SMOKE_ID}"
SMOKE_TMP="$(mktemp -d "/tmp/der-smoke-${SMOKE_ID}-XXXXXX")"
SMOKE_SKILLS_DIR="${SMOKE_TMP}/skills"
SMOKE_WORK_DIR="${SMOKE_TMP}/work"
SMOKE_ROOTLESS_RUN_DIR=""
ROOTLESS_PID=""
STARTED_EPHEMERAL_ROOTLESS=0
SMOKE_ROOTLESS_HOST=""
WASMER_IMAGE="der-wasmer-runner:smoke-${SMOKE_ID}"

log() {
  printf '[smoke] %s\n' "$*"
}

fail() {
  printf '[smoke] FAIL: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

cleanup() {
  local exit_code=$?
  set +e
  log "Cleaning up isolated smoke project ${SMOKE_PROJECT}"
  COMPOSE_PROJECT_NAME="${SMOKE_PROJECT}" \
    DER_SMOKE_HTTP_PORT="${DER_SMOKE_HTTP_PORT:-13000}" \
    DER_SMOKE_SKILLS_DIR="${SMOKE_SKILLS_DIR}" \
    DER_SMOKE_ROOTLESS_RUN_DIR="${SMOKE_ROOTLESS_RUN_DIR:-${SMOKE_SKILLS_DIR}}" \
    docker compose -f docker-compose.yml -f docker-compose.smoke.yml down -v --remove-orphans >/dev/null 2>&1

  if [ -n "${SMOKE_ROOTLESS_HOST}" ]; then
    DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker image rm -f "${WASMER_IMAGE}" >/dev/null 2>&1
    if [ "${STARTED_EPHEMERAL_ROOTLESS}" -eq 0 ]; then
      for vol in der-home-codex der-home-claude-code der-home-antigravity; do
        true
      done
    fi
  fi

  if [ "${STARTED_EPHEMERAL_ROOTLESS}" -eq 1 ] && [ -n "${ROOTLESS_PID}" ]; then
    kill "${ROOTLESS_PID}" >/dev/null 2>&1
    wait "${ROOTLESS_PID}" >/dev/null 2>&1
    rootlesskit rm -rf "${SMOKE_TMP}" >/dev/null 2>&1 || rm -rf "${SMOKE_TMP}" >/dev/null 2>&1
  else
    rm -rf "${SMOKE_TMP}" >/dev/null 2>&1
  fi

  exit "${exit_code}"
}
trap cleanup EXIT

require_cmd docker
require_cmd bun
require_cmd curl
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 plugin is required."

# 1. Verify Compose base and smoke overlay resolution.
log "Validating docker-compose.yml and docker-compose.smoke.yml"
docker compose config --quiet
docker compose -f docker-compose.yml -f docker-compose.smoke.yml config --quiet

# 2. Prepare dedicated rootless Docker daemon (use caller socket if provided, else isolated ephemeral daemon).
if [ -n "${DER_ROOTLESS_DOCKER_SOCKET:-}" ] && [ -S "${DER_ROOTLESS_DOCKER_SOCKET}" ]; then
  SMOKE_ROOTLESS_RUN_DIR="$(dirname "${DER_ROOTLESS_DOCKER_SOCKET}")"
  SMOKE_ROOTLESS_HOST="unix://${DER_ROOTLESS_DOCKER_SOCKET}"
  log "Using configured rootless Docker daemon at ${SMOKE_ROOTLESS_HOST}"
else
  require_cmd dockerd-rootless.sh
  SMOKE_ROOTLESS_RUN_DIR="${SMOKE_TMP}/rootless-run"
  mkdir -p "${SMOKE_ROOTLESS_RUN_DIR}" "${SMOKE_TMP}/rootless-data" "${SMOKE_TMP}/rootless-exec"
  chmod 0755 "${SMOKE_TMP}" "${SMOKE_ROOTLESS_RUN_DIR}"

  ROOTLESS_NET="pasta"
  if ! command -v pasta >/dev/null 2>&1; then
    ROOTLESS_NET="slirp4netns"
  fi

  log "Starting isolated ephemeral rootless Docker daemon (net=${ROOTLESS_NET})"
  XDG_RUNTIME_DIR="${SMOKE_ROOTLESS_RUN_DIR}" \
    DOCKERD_ROOTLESS_ROOTLESSKIT_NET="${ROOTLESS_NET}" \
    dockerd-rootless.sh \
      --data-root "${SMOKE_TMP}/rootless-data" \
      --exec-root "${SMOKE_TMP}/rootless-exec" \
      --pidfile "${SMOKE_TMP}/rootless-docker.pid" \
      >"${SMOKE_TMP}/rootless-dockerd.log" 2>&1 &
  ROOTLESS_PID=$!
  STARTED_EPHEMERAL_ROOTLESS=1
  SMOKE_ROOTLESS_HOST="unix://${SMOKE_ROOTLESS_RUN_DIR}/docker.sock"

  for _ in $(seq 1 60); do
    if [ -S "${SMOKE_ROOTLESS_RUN_DIR}/docker.sock" ] \
      && DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker info >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker info >/dev/null 2>&1 \
    || { tail -n 40 "${SMOKE_TMP}/rootless-dockerd.log" >&2; fail "Ephemeral rootless Docker daemon failed to become ready."; }
fi

# 3. Verify rootless daemon isolation controls (rootless + cgroup memory/cpu/pids) via runtime probe.
log "Probing rootless Docker daemon isolation controls"
DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" bun -e '
import { probeDockerIsolation, DEFAULT_ENGINE_SHADOW_HOMES } from "./packages/runtime/src/sandbox/index.ts";
const report = await probeDockerIsolation({ dockerHost: process.env["DOCKER_HOST"]! });
if (!report.isolationVerified || !report.isRootless) {
  console.error("Isolation probe failed:", report);
  process.exit(1);
}
console.log("Rootless probe verified:", JSON.stringify({
  daemonVersion: report.daemonVersion,
  isRootless: report.isRootless,
  shadowHomes: Object.values(DEFAULT_ENGINE_SHADOW_HOMES).map((h) => h.volumeName),
}));
'

# Provision named engine shadow-home volumes on the dedicated rootless daemon.
log "Provisioning named engine shadow-home volumes on rootless daemon"
for vol in der-home-codex der-home-claude-code der-home-antigravity; do
  DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker volume create "${vol}" >/dev/null
done

# 4. Build and exercise hardened Wasmer runner on the rootless daemon with --network=none and explicit grants.
log "Building Wasmer runner image (${WASMER_IMAGE}) on rootless daemon"
DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker build \
  -f docker/Dockerfile.wasmer \
  --target der-wasmer-runner \
  -t "${WASMER_IMAGE}" \
  .

mkdir -p "${SMOKE_WORK_DIR}/ro" "${SMOKE_WORK_DIR}/rw" "${SMOKE_WORK_DIR}/secret"
printf 'readonly-fixture-ok\n' > "${SMOKE_WORK_DIR}/ro/hello.txt"
printf 'should-never-be-readable\n' > "${SMOKE_WORK_DIR}/secret/token.txt"
chmod -R a+rX "${SMOKE_WORK_DIR}"
chmod 0777 "${SMOKE_WORK_DIR}/rw"

log "Exercising live hardened container + Wasmer bash guest (network=none, explicit ro/rw grants, limits)"
BASH_REQ='{"command":"bash","args":["-c","cat /workspace/mnt/ro-0/hello.txt && printf written-by-wasmer > /workspace/mnt/rw-0/out.txt && echo bash-ok"],"readonlyPaths":["/work/ro"],"writablePaths":["/work/rw"],"timeoutMs":15000,"network":"none"}'
BASH_OUT="$(printf '%s' "${BASH_REQ}" | DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker run --rm -i \
  --user 1000:1000 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --network=none \
  --cpus=1 \
  --memory=512m \
  --memory-swap=512m \
  --pids-limit=128 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,source=${SMOKE_WORK_DIR}/ro,target=/work/ro,readonly" \
  --mount "type=bind,source=${SMOKE_WORK_DIR}/rw,target=/work/rw" \
  "${WASMER_IMAGE}")"

bun -e '
const res = JSON.parse(process.argv[1]!);
if (res.exitCode !== 0 || res.timedOut !== false || !res.stdout.includes("readonly-fixture-ok") || !res.stdout.includes("bash-ok")) {
  console.error("Unexpected Wasmer bash result:", res);
  process.exit(1);
}
' "${BASH_OUT}"

[ "$(cat "${SMOKE_WORK_DIR}/rw/out.txt")" = "written-by-wasmer" ] \
  || fail "Wasmer writable grant did not sync back to /work/rw/out.txt"

log "Exercising live Wasmer python guest (network=none)"
PY_REQ='{"command":"python","args":["-c","print(6 * 7)"],"timeoutMs":15000,"network":"none"}'
PY_OUT="$(printf '%s' "${PY_REQ}" | DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker run --rm -i \
  --user 1000:1000 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --network=none \
  --cpus=1 \
  --memory=512m \
  --memory-swap=512m \
  --pids-limit=128 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  "${WASMER_IMAGE}")"

bun -e '
const res = JSON.parse(process.argv[1]!);
if (res.exitCode !== 0 || res.timedOut !== false || res.stdout.trim() !== "42") {
  console.error("Unexpected Wasmer python result:", res);
  process.exit(1);
}
' "${PY_OUT}"

log "Verifying hardened rootless container drops capabilities, runs non-root, and isolates network/sockets/homes"
DOCKER_CHECK="$(DOCKER_HOST="${SMOKE_ROOTLESS_HOST}" docker run --rm \
  --user 1000:1000 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --network=none \
  --cpus=1 \
  --memory=256m \
  --memory-swap=256m \
  --pids-limit=64 \
  --mount "type=volume,source=der-home-codex,target=/home/engine" \
  --entrypoint sh \
  "${WASMER_IMAGE}" -c '
    set -eu
    test "$(id -u)" = "1000"
    test ! -e /var/run/docker.sock
    test ! -e /run/der-rootless/docker.sock
    grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status
    grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status
    echo hardened-docker-ok
  ')"
[ "${DOCKER_CHECK}" = "hardened-docker-ok" ] || fail "Hardened Docker container verification failed: ${DOCKER_CHECK}"

# 5. Prepare isolated skills directory and allocate an unused loopback port for the smoke Compose stack.
mkdir -p "${SMOKE_SKILLS_DIR}/smoke-check"
cat > "${SMOKE_SKILLS_DIR}/smoke-check/SKILL.md" <<'EOF'
---
name: smoke-check
description: Verify read-only skills catalog loading during Phase 1 smoke.
---

Inspect health endpoints and confirm durable recovery invariants.
EOF
chmod -R a+rX "${SMOKE_SKILLS_DIR}"

DER_SMOKE_HTTP_PORT="$(bun -e '
import { createServer } from "node:net";
const s = createServer();
s.listen(0, "127.0.0.1", () => {
  const addr = s.address();
  console.log(typeof addr === "object" && addr ? addr.port : 13000);
  s.close();
});
')"
export DER_SMOKE_HTTP_PORT
export DER_SMOKE_SKILLS_DIR="${SMOKE_SKILLS_DIR}"
export DER_SMOKE_ROOTLESS_RUN_DIR="${SMOKE_ROOTLESS_RUN_DIR}"
export COMPOSE_PROJECT_NAME="${SMOKE_PROJECT}"
BASE_URL="http://127.0.0.1:${DER_SMOKE_HTTP_PORT}"

log "Starting isolated Compose stack ${SMOKE_PROJECT} on ${BASE_URL}"
docker compose -f docker-compose.yml -f docker-compose.smoke.yml up -d --build

wait_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml logs --tail=80 >&2
  fail "Server did not become healthy at ${BASE_URL}/healthz"
}

register_deployment() {
  for _ in $(seq 1 40); do
    if docker compose -f docker-compose.yml -f docker-compose.smoke.yml exec -T restate \
      curl -fsS -X POST http://127.0.0.1:9070/deployments \
        -H 'content-type: application/json' \
        -d '{"uri":"http://server:9080","force":true,"use_http_11":true}' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml logs --tail=80 >&2
  fail "Failed to register Bun Fetch deployment with Restate"
}

wait_health
register_deployment

# 6. Verify operator API surface: engines doctor, skills, memory projection, same-origin enforcement.
log "Verifying /api/engines, /api/skills, /api/bots/bot-fixture/memory, and same-origin protection"
bun -e '
const baseUrl = process.argv[1]!;

const enginesRes = await fetch(`${baseUrl}/api/engines`);
if (enginesRes.status !== 200) throw new Error(`/api/engines returned ${enginesRes.status}`);
const enginesBody = (await enginesRes.json()) as { engines: { engine: string; isolationVerified: boolean; unattended: string }[] };
const byName = new Map(enginesBody.engines.map((e) => [e.engine, e]));
if (!byName.has("fixture") || !byName.has("codex") || !byName.has("claude-code") || !byName.has("antigravity")) {
  throw new Error(`Missing expected engines: ${JSON.stringify(enginesBody)}`);
}
for (const kind of ["codex", "claude-code", "antigravity"]) {
  const entry = byName.get(kind)!;
  if (!entry.isolationVerified) {
    throw new Error(`Expected rootless isolationVerified=true for ${kind}, got ${JSON.stringify(entry)}`);
  }
  if (entry.unattended === "ready") {
    throw new Error(`Unverified unattended engine ${kind} must not report ready`);
  }
}

const skillsRes = await fetch(`${baseUrl}/api/skills`);
if (skillsRes.status !== 200) throw new Error(`/api/skills returned ${skillsRes.status}`);
const skillsBody = (await skillsRes.json()) as { skills: { id: string }[] };
if (!skillsBody.skills.some((s) => s.id === "smoke-check")) {
  throw new Error(`Expected smoke-check skill in catalog: ${JSON.stringify(skillsBody)}`);
}

const memWrite = await fetch(`${baseUrl}/api/bots/bot-fixture/memory`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ markdown: "# Smoke Memory\n- Durable recovery verified.\n", expectedVersion: 0 }),
});
if (memWrite.status !== 200) throw new Error(`Memory write failed: ${memWrite.status}`);

const memRead = await fetch(`${baseUrl}/api/bots/bot-fixture/memory`);
const memBody = (await memRead.json()) as { memory: { version: number; markdown: string } | null };
if (memBody.memory?.version !== 1 || !memBody.memory.markdown.includes("Durable recovery verified.")) {
  throw new Error(`Unexpected memory read: ${JSON.stringify(memBody)}`);
}

const badOrigin = await fetch(`${baseUrl}/api/bots`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://evil.example" },
  body: JSON.stringify({ name: "Blocked", defaultEngine: "fixture", allowedEngines: ["fixture"] }),
});
if (badOrigin.status !== 403 || badOrigin.headers.get("content-type") !== "application/problem+json") {
  throw new Error(`Expected 403 problem+json for disallowed origin, got ${badOrigin.status}`);
}
' "${BASE_URL}"

# 7. Admit durable fixture Run, capture initial SSE frames, restart BOTH Bun and Restate, then approve & resume.
log "Admitting durable fixture Run and capturing pre-restart SSE frames"
PRE_RESTART_JSON="$(bun -e '
import { parseSseFrame } from "./packages/domain/src/protocol/sse.ts";

const baseUrl = process.argv[1]!;
const admitRes = await fetch(`${baseUrl}/api/sessions/sess-fixture/runs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "smoke-recovery-key-1",
  },
  body: JSON.stringify({
    input: { parts: [{ type: "text", text: "smoke-lamp-1" }] },
  }),
});
if (admitRes.status !== 202) {
  throw new Error(`Admit failed (${admitRes.status}): ${await admitRes.text()}`);
}
const admission = (await admitRes.json()) as { run: { id: string } };
const runId = admission.run.id;

const dupRes = await fetch(`${baseUrl}/api/sessions/sess-fixture/runs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "smoke-recovery-key-1",
  },
  body: JSON.stringify({
    input: { parts: [{ type: "text", text: "smoke-lamp-1" }] },
  }),
});
if (dupRes.status !== 202) throw new Error(`Duplicate admit failed: ${dupRes.status}`);
const dup = (await dupRes.json()) as { run: { id: string } };
if (dup.run.id !== runId) throw new Error(`Duplicate idempotency replay returned ${dup.run.id} instead of ${runId}`);

const conflictRes = await fetch(`${baseUrl}/api/sessions/sess-fixture/runs`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": "smoke-recovery-key-1",
  },
  body: JSON.stringify({
    input: { parts: [{ type: "text", text: "smoke-lamp-mutated" }] },
  }),
});
if (conflictRes.status !== 409) throw new Error(`Expected 409 idempotency conflict, got ${conflictRes.status}`);

let approvalId = "";
for (let i = 0; i < 100; i += 1) {
  const res = await fetch(`${baseUrl}/api/runs/${runId}`);
  const body = (await res.json()) as { run: { status: string }; approval: { id: string; decision: { status: string } } | null };
  if (body.run.status === "waiting_approval" && body.approval?.decision.status === "pending") {
    approvalId = body.approval.id;
    break;
  }
  await Bun.sleep(100);
}
if (!approvalId) throw new Error("Run did not reach waiting_approval before restart");

const abort = new AbortController();
const sseRes = await fetch(`${baseUrl}/api/runs/${runId}/events`, { signal: abort.signal });
if (sseRes.status !== 200 || !sseRes.body) throw new Error(`SSE failed: ${sseRes.status}`);
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let buf = "";
const ids: number[] = [];
try {
  while (ids.length < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;
      const frame = parseSseFrame(buf.slice(0, idx + 2));
      buf = buf.slice(idx + 2);
      if (frame.kind === "event" && frame.id) {
        ids.push(Number(frame.id));
        if (ids.length >= 2) {
          abort.abort();
          await reader.cancel();
          break;
        }
      }
    }
  }
} catch {
  // Abort expected after reading initial frames.
}
if (ids.length < 2 || ids[0] !== 1 || ids[1] !== 2) {
  throw new Error(`Unexpected pre-restart SSE frame IDs: ${JSON.stringify(ids)}`);
}

console.log(JSON.stringify({ runId, approvalId, lastEventId: ids[ids.length - 1] }));
' "${BASE_URL}")"

RUN_ID="$(bun -e 'console.log(JSON.parse(process.argv[1]!).runId)' "${PRE_RESTART_JSON}")"
APPROVAL_ID="$(bun -e 'console.log(JSON.parse(process.argv[1]!).approvalId)' "${PRE_RESTART_JSON}")"
LAST_EVENT_ID="$(bun -e 'console.log(JSON.parse(process.argv[1]!).lastEventId)' "${PRE_RESTART_JSON}")"
log "Captured pending approval ${APPROVAL_ID} for run ${RUN_ID} (SSE cursor=${LAST_EVENT_ID})"

log "Restarting BOTH Restate and Bun server containers during pending approval"
docker compose -f docker-compose.yml -f docker-compose.smoke.yml restart restate server
wait_health
register_deployment

log "Resolving approval after full restart and verifying SSE continuation, terminal 204, and completion"
bun -e '
import { parseSseFrame } from "./packages/domain/src/protocol/sse.ts";

const [baseUrl, runId, approvalId, lastEventId] = process.argv.slice(1) as [string, string, string, string];

const beforeDecision = await fetch(`${baseUrl}/api/runs/${runId}`);
const beforeBody = (await beforeDecision.json()) as { run: { status: string }; approval: { id: string; decision: { status: string } } | null };
if (beforeBody.run.status !== "waiting_approval" || beforeBody.approval?.id !== approvalId || beforeBody.approval.decision.status !== "pending") {
  throw new Error(`Approval state lost across restart: ${JSON.stringify(beforeBody)}`);
}

const approveRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/decision`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    botId: "bot-fixture",
    sessionId: "sess-fixture",
    runId,
    status: "approved",
    actor: "smoke-operator",
  }),
});
if (approveRes.status !== 200) {
  throw new Error(`Approval decision failed (${approveRes.status}): ${await approveRes.text()}`);
}

const replayRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/decision`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    botId: "bot-fixture",
    sessionId: "sess-fixture",
    runId,
    status: "approved",
    actor: "smoke-operator",
  }),
});
if (replayRes.status !== 200) throw new Error(`Approval replay failed: ${replayRes.status}`);

const conflictRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/decision`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    botId: "bot-fixture",
    sessionId: "sess-fixture",
    runId,
    status: "denied",
    actor: "smoke-operator",
  }),
});
if (conflictRes.status !== 409) throw new Error(`Expected 409 decision conflict, got ${conflictRes.status}`);

let completed = false;
for (let i = 0; i < 150; i += 1) {
  const res = await fetch(`${baseUrl}/api/runs/${runId}`);
  const body = (await res.json()) as { run: { status: string } };
  if (body.run.status === "completed") {
    completed = true;
    break;
  }
  await Bun.sleep(100);
}
if (!completed) throw new Error("Run did not complete after restart and approval");

const resumedRes = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
  headers: { "last-event-id": lastEventId },
});
if (resumedRes.status !== 200 || !resumedRes.body) {
  throw new Error(`SSE resume failed: ${resumedRes.status}`);
}
const rawText = await resumedRes.text();
const frames = rawText
  .split("\n\n")
  .filter((chunk) => chunk.trim().length > 0)
  .map((chunk) => parseSseFrame(`${chunk}\n\n`))
  .filter((frame) => frame.kind === "event");

const ids = frames.map((frame) => Number(frame.id));
const expectedStart = Number(lastEventId) + 1;
if (ids.length === 0 || ids[0] !== expectedStart) {
  throw new Error(`Expected ordered SSE continuation from ${expectedStart}, got ${JSON.stringify(ids)}`);
}
for (let i = 1; i < ids.length; i += 1) {
  if (ids[i] !== ids[i - 1]! + 1) {
    throw new Error(`Non-contiguous SSE sequence: ${JSON.stringify(ids)}`);
  }
}
const terminalData = JSON.parse(frames[frames.length - 1]!.data) as { type: string; runId: string };
if (terminalData.type !== "RUN_FINISHED" || terminalData.runId !== runId) {
  throw new Error(`Expected RUN_FINISHED terminal frame, got ${JSON.stringify(terminalData)}`);
}

const terminalId = ids[ids.length - 1]!;
const reconnectRes = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
  headers: { "last-event-id": String(terminalId) },
});
if (reconnectRes.status !== 204) {
  throw new Error(`Expected HTTP 204 at terminal cursor ${terminalId}, got ${reconnectRes.status}`);
}
console.log(`SSE continuation verified (${ids[0]}..${terminalId}) + terminal HTTP 204`);
' "${BASE_URL}" "${RUN_ID}" "${APPROVAL_ID}" "${LAST_EVENT_ID}"

# 8. Verify SQLite WAL mode, exactly one completed effect, and matching committed outbox rows inside server container.
log "Verifying SQLite WAL mode, single completed effect, and committed outbox rows"
docker compose -f docker-compose.yml -f docker-compose.smoke.yml exec -T server \
  bun -e '
import { Database } from "bun:sqlite";

const runId = process.argv[1]!;
const approvalId = process.argv[2]!;
const db = new Database("/data/der.sqlite", { readonly: true });

const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode;").get();
if (journal?.journal_mode?.toLowerCase() !== "wal") {
  throw new Error(`Expected WAL journal mode, got ${JSON.stringify(journal)}`);
}

const effects = db
  .query<{ id: string; operation_id: string; status: string }, [string]>(
    "SELECT id, operation_id, status FROM effects WHERE run_id = ?",
  )
  .all(runId);
if (effects.length !== 1 || effects[0]?.status !== "completed" || effects[0]?.operation_id !== "fixture.apply") {
  throw new Error(`Expected exactly one completed fixture.apply effect, got ${JSON.stringify(effects)}`);
}

const approvalOutbox = db
  .query<{ event_id: string; envelope_json: string }, [string]>(
    "SELECT event_id, envelope_json FROM outbox_events WHERE event_id = ?",
  )
  .all(`approval:${approvalId}`);
if (approvalOutbox.length !== 1) {
  throw new Error(`Expected 1 der.approval.requested outbox row, got ${approvalOutbox.length}`);
}

const replyOutbox = db
  .query<{ event_id: string; envelope_json: string }, [string]>(
    "SELECT event_id, envelope_json FROM outbox_events WHERE event_id = ?",
  )
  .all(`chat.replied:${runId}`);
if (replyOutbox.length !== 1) {
  throw new Error(`Expected 1 der.chat.replied outbox row, got ${replyOutbox.length}`);
}
const replyEnvelope = JSON.parse(replyOutbox[0]!.envelope_json) as { type: string; specversion: string };
if (replyEnvelope.type !== "der.chat.replied" || replyEnvelope.specversion !== "1.0") {
  throw new Error(`Unexpected outbox CloudEvent envelope: ${JSON.stringify(replyEnvelope)}`);
}

const memFile = await Bun.file("/data/memory/bot-fixture.md").text();
if (!memFile.includes("Durable recovery verified.")) {
  throw new Error(`Memory Markdown projection missing expected content: ${memFile}`);
}
db.close();
console.log("SQLite WAL, effect ledger (1 completed), outbox (approval + reply), and Markdown projection verified.");
' "${RUN_ID}" "${APPROVAL_ID}"

# 9. Exercise concurrent SQLite WAL reads and writes against the live server without SQLITE_BUSY errors.
log "Exercising concurrent SQLite WAL reads and writes"
bun -e '
const baseUrl = process.argv[1]!;
const runId = process.argv[2]!;

const sessions: string[] = [];
for (let i = 0; i < 4; i += 1) {
  const res = await fetch(`${baseUrl}/api/bots/bot-fixture/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `WAL Session ${i}` }),
  });
  if (res.status !== 201) throw new Error(`Create WAL session failed: ${res.status}`);
  sessions.push(((await res.json()) as { id: string }).id);
}

const writeTasks = sessions.map(async (sessionId, idx) => {
  const admit = await fetch(`${baseUrl}/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `wal-direct-${idx}`,
    },
    body: JSON.stringify({
      input: { parts: [{ type: "text", text: `direct: wal concurrent reply ${idx}` }] },
    }),
  });
  if (admit.status !== 202) {
    throw new Error(`Concurrent direct run ${idx} failed (${admit.status}): ${await admit.text()}`);
  }
  const admittedRunId = ((await admit.json()) as { run: { id: string } }).run.id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const check = await fetch(`${baseUrl}/api/runs/${admittedRunId}`);
    if (check.status !== 200) throw new Error(`Concurrent run read failed: ${check.status}`);
    const body = (await check.json()) as { run: { status: string } };
    if (body.run.status === "completed") return admittedRunId;
    await Bun.sleep(50);
  }
  throw new Error(`Concurrent direct run ${admittedRunId} did not complete`);
});

const readTasks = Array.from({ length: 24 }, async (_, idx) => {
  const path =
    idx % 3 === 0
      ? `/api/runs/${runId}`
      : idx % 3 === 1
        ? "/api/sessions/sess-fixture/messages"
        : "/api/bots/bot-fixture/memory";
  const res = await fetch(`${baseUrl}${path}`);
  if (res.status !== 200) {
    throw new Error(`Concurrent WAL read ${path} failed (${res.status}): ${await res.text()}`);
  }
});

const memoryWriters = Array.from({ length: 6 }, async (_, idx) => {
  const res = await fetch(`${baseUrl}/api/bots/bot-fixture/memory`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: `# Smoke Memory\n- WAL write ${idx}\n` }),
  });
  if (res.status !== 200) {
    throw new Error(`Concurrent memory write ${idx} failed (${res.status}): ${await res.text()}`);
  }
});

await Promise.all([...writeTasks, ...readTasks, ...memoryWriters]);
console.log("Concurrent SQLite WAL reads (24) and writes (4 runs + 6 memory versions) succeeded with zero contention failures.");
' "${BASE_URL}" "${RUN_ID}"

log "PASS: Phase 1 live compose + restart recovery + rootless Docker + Wasmer + WAL smoke succeeded."
