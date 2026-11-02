#!/usr/bin/env bash
# Container smoke test: runs the image the way production does (non-root, read-only root,
# no capabilities) and checks it starts, reports healthy and refuses bad configuration.
# Everything it starts carries one label and is removed on exit, with the state its runners keep on
# the engine. So it runs only on an engine that keeps none, such as a sandbox: never next to a real runner.
set -euo pipefail
# Checks read with grep -c, not -q: -q stops at the first match, and under pipefail the writer it
# leaves behind (docker logs, curl) would fail the check with SIGPIPE.

image="${1:-autoheal:smoke}"
label="com.autoheal.smoke=1"
fixtures="$(cd "$(dirname "$0")/../fixtures/tls" && pwd)"
hardened=(--read-only --cap-drop ALL --security-opt no-new-privileges:true --label "$label")
main=/app/dist/server/main.js

# What a runner keeps on its engine: its safety record and its journals. A real runner's must never be
# adopted or removed, so an engine that holds any is refused before anything starts or is cleaned up.
runner_state_labels=(autoheal.guard.state autoheal.shutdown.journal autoheal.result.journal
  autoheal.rollback.journal autoheal.application-backup.journal)
runner_state() {
  for state_label in "${runner_state_labels[@]}"; do
    docker volume ls -q --filter "label=$state_label"
  done | sort -u
}
if [[ -n "$(runner_state)" ]]; then
  echo "SMOKE REFUSED: this engine keeps a runner's state; use a disposable engine. Nothing was removed." >&2
  exit 1
fi

network=autoheal-smoke
volume=autoheal-smoke-data
join_volume=autoheal-smoke-join
scratch="$(mktemp -d)"

cleanup() {
  docker ps -aq --filter "label=$label" | xargs -r docker rm -f >/dev/null
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$join_volume" >/dev/null 2>&1 || true
  runner_state | xargs -r docker volume rm >/dev/null 2>&1 || true
  rm -r "$scratch"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }
fail() {
  echo "SMOKE FAILED: $1" >&2
  exit 1
}

wait_healthy() {
  local container=$1
  for _ in $(seq 1 30); do
    if docker exec "$container" /nodejs/bin/node "$main" healthcheck >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2
  fail "$container never became healthy"
}

# docker stop sends SIGTERM to PID 1: the app must end on it, or Docker kills it ten seconds later.
stops_quickly() {
  local container=$1 started elapsed
  started=$(date +%s)
  docker stop "$container" >/dev/null
  elapsed=$(($(date +%s) - started))
  [[ $elapsed -lt 8 ]] || fail "$container took ${elapsed}s to stop; SIGTERM was ignored"
}

step "image runs as the non-root numeric user"
[[ "$(docker inspect -f '{{.Config.User}}' "$image")" == "65532:65532" ]] || fail "image user is not 65532:65532"

# Reads a file inside a running container: the image has no shell and no cat, only node.
read_file() { docker exec "$1" /nodejs/bin/node -e "process.stdout.write(require('fs').readFileSync('$2'))"; }

step "native modules load as UID 65532 on a read-only root"
docker run --rm "${hardened[@]}" "$image" self-test

step "the app cannot modify its own code, even without --read-only"
if docker run --rm --label "$label" --entrypoint /nodejs/bin/node "$image" \
  -e "require('fs').writeFileSync('/app/dist/planted.js', '')" 2>/dev/null; then
  fail "UID 65532 could write into /app"
fi

step "bad configuration is refused with exit code 1"
set +e
docker run --rm "${hardened[@]}" "$image" check-config control-plane
exit_code=$?
set -e
[[ $exit_code -eq 1 ]] || fail "check-config exited $exit_code, expected 1"

step "control plane starts from two settings on fresh volumes, making its certificate and passphrase"
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker volume create "$join_volume" >/dev/null
docker run -d --name autoheal-smoke-control-plane "${hardened[@]}" --tmpfs /tmp:size=16m \
  --network "$network" --network-alias control-plane -p 127.0.0.1::8443 \
  -v "$volume:/data" -v "$join_volume:/join" \
  -e PUBLIC_BASE_URL=https://autoheal.example.org \
  -e OLLAMA_URL=http://ollama:11434 \
  "$image" >/dev/null
wait_healthy autoheal-smoke-control-plane
logs=$(docker logs autoheal-smoke-control-plane 2>&1)
for expected in "First run: created admin account" "Made a TLS certificate" "Made a backup passphrase" \
  "Added this machine as a host" "Ollama is reached over plain http"; do
  grep -c "$expected" <<<"$logs" >/dev/null || fail "control plane never said: $expected"
done
[[ "$(docker exec autoheal-smoke-control-plane /nodejs/bin/node -p \
  "(require('fs').statSync('/data/backup-passphrase').mode & 0o777).toString(8)")" == "600" ]] ||
  fail "the backup passphrase is readable by others"

step "dashboard answers over HTTPS, with its own certificate for its name, and the strict CSP"
port=$(docker port autoheal-smoke-control-plane 8443/tcp | head -1 | cut -d: -f2)
read_file autoheal-smoke-control-plane /data/tls/certificate.pem >"$scratch/certificate.pem"
# The certificate is checked for the dashboard's name; the Host header is the address people type.
dashboard=(curl -s --cacert "$scratch/certificate.pem" --resolve "autoheal.example.org:$port:127.0.0.1"
  -H "Host: autoheal.example.org")
"${dashboard[@]}" -D - -o /dev/null "https://autoheal.example.org:$port/" | grep -ci "content-security-policy: default-src 'self'" >/dev/null || fail "no CSP on the dashboard"
[[ "$("${dashboard[@]}" "https://autoheal.example.org:$port/")" == *'<div id="root"></div>'* ]] || fail "dashboard shell not served"
[[ "$("${dashboard[@]}" -o /dev/null -w '%{http_code}' "https://autoheal.example.org:$port/api/hosts")" == "401" ]] || fail "API answered without a session"

socket_group=$(stat -c %g /var/run/docker.sock)

step "this host's runner joins by itself, through the join volume, trusting the certificate by its key"
docker run -d --name autoheal-smoke-joined "${hardened[@]}" --tmpfs /tmp:size=8m \
  --network "$network" --group-add "$socket_group" -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$join_volume:/join:ro" -e AUTOHEAL_CONTAINER_NAME=autoheal-smoke-joined \
  "$image" runner >/dev/null
wait_healthy autoheal-smoke-joined
for _ in $(seq 1 30); do
  if docker logs autoheal-smoke-joined 2>&1 | grep -c "reporting to the control plane at https://control-plane:9443" >/dev/null; then
    break
  fi
  sleep 1
done
docker logs autoheal-smoke-joined 2>&1 | grep -c "reporting to the control plane" >/dev/null || {
  docker logs autoheal-smoke-joined >&2
  fail "the joined runner never reached the control plane"
}

step "the joined runner stops on docker stop, and what it kept on the engine goes with it"
# Both runners would read and write the engine's one safety record, and the joined one, which sees the next
# container's die event too, would claim it first. One runner on the engine at a time.
stops_quickly autoheal-smoke-joined
docker rm autoheal-smoke-joined >/dev/null
runner_state | xargs -r docker volume rm >/dev/null

step "a runner on its own watches the real Docker and escalates a container that keeps failing, and one that crashed before it started"
# No event will ever tell the runner about this one: it crashed before the runner was there.
docker run -d --name autoheal-smoke-crashed --label "$label" "$image" check-config runner >/dev/null
docker wait autoheal-smoke-crashed >/dev/null
# A runner with no saved safety record holds automatic recovery for its first hour. A mature record, as the
# acceptance suite seeds one, lets this runner act at once; the fresh-install hold is covered by the GuardState tests.
record=$(printf '{"version":1,"revision":0,"bootId":"%s","savedAt":%s,"uptime":%s,"uncertainAt":null,"entries":[]}' \
  "$(cat /proc/sys/kernel/random/boot_id)" "$(date +%s)" "$(cut -d' ' -f1 /proc/uptime)")
docker volume create --label autoheal.guard.state=1 --label "autoheal.guard.record=$record" autoheal-guard-0 >/dev/null
docker run -d --name autoheal-smoke-runner "${hardened[@]}" --tmpfs /tmp:size=8m \
  --group-add "$socket_group" -v /var/run/docker.sock:/var/run/docker.sock \
  -e HOST_LABEL=smoke -e AUTOHEAL_CONTAINER_NAME=autoheal-smoke-runner \
  -e OLLAMA_URL=https://ollama.invalid:11443 -e DRY_RUN=1 \
  "$image" runner >/dev/null
wait_healthy autoheal-smoke-runner
docker run -d --name autoheal-smoke-victim --label "$label" "$image" check-config runner >/dev/null
for _ in $(seq 1 60); do
  if docker logs autoheal-smoke-runner 2>&1 | grep -c "autoheal-smoke-victim needs you" >/dev/null &&
    docker logs autoheal-smoke-runner 2>&1 | grep -c "autoheal-smoke-crashed needs you" >/dev/null; then
    break
  fi
  sleep 1
done
docker logs autoheal-smoke-runner 2>&1 | grep -c "container(s) broke while it was not, handling them now" >/dev/null || fail "runner did not catch up on the container that crashed before it started"
docker logs autoheal-smoke-runner 2>&1 | grep -c "autoheal-smoke-crashed needs you" >/dev/null || fail "runner did not escalate the container that crashed before it started"
docker logs autoheal-smoke-runner 2>&1 | grep -c "autoheal-smoke-victim: die, looking again in 30s" >/dev/null || fail "runner did not see the die event"
docker logs autoheal-smoke-runner 2>&1 | grep -c "autoheal-smoke-victim needs you" >/dev/null || {
  docker logs autoheal-smoke-runner >&2
  fail "runner did not escalate"
}
docker logs autoheal-smoke-runner 2>&1 | grep -c "Ollama could not be asked" >/dev/null || fail "escalation did not say why"

step "docker stop is handled (SIGTERM as PID 1) in both modes"
for container in autoheal-smoke-control-plane autoheal-smoke-runner; do
  stops_quickly "$container"
done

printf '\nSMOKE PASSED\n'
