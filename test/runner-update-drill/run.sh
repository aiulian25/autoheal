#!/bin/bash
# A sidecar runner updating itself on a real engine of its own: no network, a private socket, nothing shared with
# this machine's engine. A control plane and a runner from this checkout's image run inside it; the runner is on a
# channel tag (localhost:5000/autoheal:latest), and a registry in there serves a newer image under that tag. The
# runner is given an "Update runner" job and must come back on the new image, keeping how it was run.
# Removes all it made.   test/runner-update-drill/run.sh [where the runner's container has the Docker socket]
set -u
# A path other than the default is the runner's DOCKER_SOCKET_PATH too.
RUNNER_SOCKET="${1:-/var/run/docker.sock}"
ENGINE_IMAGE=docker:29.9.0-dind
OLD=autoheal:runner-drill-old
NEW=autoheal:runner-drill-new
CHANNEL=localhost:5000/autoheal:latest
ENGINE=autoheal-runner-drill
STORE=autoheal-runner-drill-store
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_FOLDER="$HOME/.cache/autoheal-runner-drill"
SOCKET="$RUN_FOLDER/docker.sock"
WORK="$(mktemp -d -p "$HOME/.cache")"
ENGINE_START_SECONDS=60
# The helper keeps the old runner 10 minutes after the new one is healthy, then removes it and ends.
HELPER_END_SECONDS=900
NODE=/nodejs/bin/node

cleanup() {
  unset DOCKER_HOST
  docker rm -f "$ENGINE" >/dev/null 2>&1
  docker volume rm "$STORE" >/dev/null 2>&1
  docker rmi "$OLD" "$NEW" >/dev/null 2>&1
  rm -rf "${RUN_FOLDER:?}" "${WORK:?}"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$1"; }
fail() {
  echo "DRILL FAILED: $1" >&2
  inner ps -a >&2
  inner logs autoheal 2>&1 | grep -v "remains unacknowledged" | tail -20 >&2
  exit 1
}
inner() { DOCKER_HOST="unix://$SOCKET" docker "$@"; }
# Reads the control plane's database with the image's own SQLite.
query() {
  inner exec autoheal-control-plane "$NODE" -e "
    const db = new (require('/app/node_modules/better-sqlite3'))('/data/autoheal.sqlite');
    const rows = db.prepare(process.argv[1]).all(...process.argv.slice(2));
    process.stdout.write(rows.map((row) => Object.values(row).join('|')).join('\n'));" "$@"
}
run_query() {
  inner exec autoheal-control-plane "$NODE" -e "
    const db = new (require('/app/node_modules/better-sqlite3'))('/data/autoheal.sqlite');
    db.prepare(process.argv[1]).run(...process.argv.slice(2));" "$@"
}

step "images: this checkout, and the same with one label more, so it is another image"
docker build -q -t "$OLD" "$HERE/../.." >/dev/null || exit 9
printf 'FROM %s\nLABEL autoheal.drill=new\n' "$OLD" | docker build -q -t "$NEW" - >/dev/null || exit 9
docker save "$NEW" -o "$WORK/new.tar" && mkdir "$WORK/oci" && tar -xf "$WORK/new.tar" -C "$WORK/oci" || exit 9
NEW_ID=$(docker inspect -f '{{.Id}}' "$NEW")
OLD_ID=$(docker inspect -f '{{.Id}}' "$OLD")

step "a disposable engine with no network"
mkdir -p "$RUN_FOLDER"
docker run -d --name "$ENGINE" --privileged --network none --label com.autoheal.helper=true \
  -e DOCKER_TLS_CERTDIR= -v "$STORE:/var/lib/docker" -v "$RUN_FOLDER:/fixture-run" "$ENGINE_IMAGE" \
  dockerd --host=unix:///fixture-run/docker.sock --group="$(id -g)" --bridge=none --iptables=false >/dev/null || exit 9
for _ in $(seq "$ENGINE_START_SECONDS"); do inner version >/dev/null 2>&1 && break; sleep 1; done
docker save "$OLD" | inner load -q >/dev/null || exit 9
inner tag "$OLD" "$CHANNEL"

step "a registry in there, serving the new image under the runner's tag"
inner create --name drill-registry --network host --entrypoint "$NODE" "$OLD" /tmp/registry.mjs /tmp/oci 5000 >/dev/null
inner cp "$HERE/registry.mjs" drill-registry:/tmp/registry.mjs
inner cp "$WORK/oci" drill-registry:/tmp/oci
inner start drill-registry >/dev/null
for _ in $(seq 30); do inner pull -q "$CHANNEL" >/dev/null 2>&1 && break; sleep 1; done
# The runner must be on the old image; the pull above only proved the registry answers.
inner tag "$OLD" "$CHANNEL"

step "a control plane and its sidecar runner, run the way the runner's compose file runs it"
inner run -d --name autoheal-control-plane --network host -v cp-data:/data -v cp-join:/join \
  -e PUBLIC_BASE_URL=https://autoheal.example.org -e OLLAMA_URL=http://127.0.0.1:11434 "$OLD" >/dev/null
for _ in $(seq 60); do
  inner exec autoheal-control-plane "$NODE" /app/dist/server/main.js healthcheck >/dev/null 2>&1 && break
  sleep 1
done
inner run -d --name autoheal --network host --add-host control-plane:127.0.0.1 --restart unless-stopped \
  --user 65532:65532 --group-add "$(id -g)" --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
  --security-opt no-new-privileges:true -v "/fixture-run/docker.sock:$RUNNER_SOCKET" -v cp-join:/join:ro \
  -e DOCKER_SOCKET_PATH="$RUNNER_SOCKET" -e AUTOHEAL_CONTAINER_NAME=autoheal "$CHANNEL" runner >/dev/null
HOST_ID=""
for _ in $(seq 90); do
  HOST_ID=$(query "SELECT id FROM hosts WHERE last_heartbeat_at IS NOT NULL LIMIT 1" 2>/dev/null)
  [[ -n "$HOST_ID" ]] && break
  sleep 2
done
[[ -n "$HOST_ID" ]] || fail "the runner never reported"
BEFORE=$(inner inspect -f '{{.Id}}' autoheal)
[[ "$(inner inspect -f '{{.Image}}' autoheal)" == "$OLD_ID" ]] || fail "the runner does not run the old image"
echo "runner reports as host $HOST_ID, on the old image"
# Asked as the first-run admin, as the dashboard's button would: delivery checks the person may still ask.
ADMIN_ID=$(query "SELECT id FROM users WHERE role = 'admin' LIMIT 1")
[[ -n "$ADMIN_ID" ]] || fail "no admin account"
# A person who has set a password and two factors, as anyone who can press the button has.
run_query "UPDATE users SET must_change_password = 0, totp_enabled = 1 WHERE id = ?" "$ADMIN_ID"

step "asked to update itself, it hands over to the helper"
JOB=$(cat /proc/sys/kernel/random/uuid)
NOW=$(($(date +%s) * 1000))
run_query "INSERT INTO jobs (id, host_id, container_name, action, status, created_at, expires_at, requested_by_user_id)
  VALUES (?, ?, '', 'update_runner', 'pending', ?, ?, '$ADMIN_ID')" "$JOB" "$HOST_ID" "$NOW" "$((NOW + 600000))"
STATUS=""
for _ in $(seq 60); do
  STATUS=$(query "SELECT status || ' — ' || coalesce(outcome, '') FROM jobs WHERE id = ?" "$JOB")
  [[ "$STATUS" == succeeded* || "$STATUS" == failed* ]] && break
  sleep 2
done
echo "job: $STATUS"
[[ "$STATUS" == succeeded* ]] || fail "the job did not hand over"

step "the helper replaces the runner, waits for it to hold, and ends"
for _ in $(seq "$HELPER_END_SECONDS"); do
  [[ -z "$(inner ps -aq --filter name=^autoheal-self-update$)" ]] && break
  sleep 1
done
[[ -z "$(inner ps -aq --filter name=^autoheal-self-update$)" ]] || fail "the helper never ended"
inner ps -a --format '{{.Names}} {{.Image}} {{.Status}}'

step "the runner is back, on the new image, run as before"
AFTER=$(inner inspect -f '{{.Id}}' autoheal) || fail "no container named autoheal"
[[ "$AFTER" != "$BEFORE" ]] || fail "the runner's container was not replaced"
[[ "$(inner inspect -f '{{.Image}}' autoheal)" == "$NEW_ID" ]] || fail "the runner is not on the new image"
# The helper runs it by image id and notes the tag it was asked for, as for the control plane's own update.
[[ "$(inner inspect -f '{{index .Config.Labels "autoheal.self-update.reference"}}' autoheal)" == "$CHANNEL" ]] ||
  fail "the runner left its tag"
[[ "$(inner inspect -f '{{.Id}}' "$CHANNEL")" == "$NEW_ID" ]] || fail "the tag does not point to the new image"
[[ "$(inner inspect -f '{{.State.Health.Status}}' autoheal)" == "healthy" ]] || fail "the new runner is not healthy"
for setting in '{{.HostConfig.NetworkMode}}' '{{.HostConfig.ReadonlyRootfs}}' '{{.Config.User}}' \
  '{{.HostConfig.RestartPolicy.Name}}' '{{json .HostConfig.ExtraHosts}}' '{{json .HostConfig.CapDrop}}' \
  '{{json .HostConfig.GroupAdd}}' '{{json .HostConfig.Tmpfs}}' '{{range .Mounts}}{{.Source}}>{{.Destination}} {{end}}'; do
  echo "  $setting = $(inner inspect -f "$setting" autoheal)"
done
[[ "$(inner inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.Config.User}}' autoheal)" == "true 65532:65532" ]] ||
  fail "the new runner lost its hardening"
SOCKET_NOW=$(inner inspect -f '{{range .Mounts}}{{if eq .Source "/fixture-run/docker.sock"}}{{.Destination}}{{end}}{{end}}' autoheal)
[[ "$SOCKET_NOW" == "$RUNNER_SOCKET" ]] || fail "the new runner has the socket at $SOCKET_NOW, not $RUNNER_SOCKET"
LEFT=$(inner ps -a --format '{{.Names}}' | sort | tr '\n' ' ')
[[ "$LEFT" == "autoheal autoheal-control-plane drill-registry " ]] || fail "left behind: $LEFT"
SEEN=$(query "SELECT last_heartbeat_at FROM hosts WHERE id = ?" "$HOST_ID")
(( $(date +%s) * 1000 - SEEN < 120000 )) || fail "the new runner is not reporting"
echo "reports again: last heartbeat $(( ($(date +%s) * 1000 - SEEN) / 1000 ))s ago"

step "asked again, it says it already runs that image and changes nothing"
NOW=$(($(date +%s) * 1000))
AGAIN=$(cat /proc/sys/kernel/random/uuid)
run_query "INSERT INTO jobs (id, host_id, container_name, action, status, created_at, expires_at, requested_by_user_id)
  VALUES (?, ?, '', 'update_runner', 'pending', ?, ?, '$ADMIN_ID')" "$AGAIN" "$HOST_ID" "$NOW" "$((NOW + 600000))"
for _ in $(seq 60); do
  STATUS=$(query "SELECT status || ' — ' || coalesce(outcome, '') FROM jobs WHERE id = ?" "$AGAIN")
  [[ "$STATUS" == succeeded* || "$STATUS" == failed* ]] && break
  sleep 2
done
echo "job: $STATUS"
[[ "$STATUS" == "succeeded — "*"already runs"* ]] || fail "a second update did not say it was already there"
[[ "$(inner inspect -f '{{.Id}}' autoheal)" == "$AFTER" ]] || fail "a second update replaced the runner"

printf '\nDRILL PASSED\n'
