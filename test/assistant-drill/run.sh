#!/bin/bash
# The assistant's whole loop on a real engine of its own: no network, a private socket, nothing shared with this
# machine's engine. A control plane and an acting runner from this checkout's image run inside it, with a stand-in for
# Home Assistant that keeps what it is sent and sets a Text helper as an automation would. A newer image of a small
# app is out; the assistant must ask, a yes written into the helper must update the app, and what came of it must be
# told. Removes all it made.   test/assistant-drill/run.sh
set -u
ENGINE_IMAGE=docker:29.9.0-dind
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../support/owned-cleanup.sh
. "$HERE/../support/owned-cleanup.sh"
IMAGE="autoheal:assistant-drill-$DRILL_RUN"
APP_ONE="autoheal:assistant-drill-app-one-$DRILL_RUN"
APP_TWO="autoheal:assistant-drill-app-two-$DRILL_RUN"
declare -A APP_OF=([one]="$APP_ONE" [two]="$APP_TWO")
APP=localhost:5000/drill-app:1
ENGINE="autoheal-assistant-drill-$DRILL_RUN"
STORE="autoheal-assistant-drill-store-$DRILL_RUN"
RUN_FOLDER="$HOME/.cache/autoheal-assistant-drill-$DRILL_RUN"
SOCKET="$RUN_FOLDER/docker.sock"
WORK="$(mktemp -d -p "$HOME/.cache")"
ENGINE_START_SECONDS=60
NODE=/nodejs/bin/node
PASSPHRASE=assistant-drill-backup-passphrase
HOME_TOKEN=assistant-drill-home-token
BOX=input_text.autoheal_answers
# The runner first checks its images two minutes after it starts, and the detectors look every thirty seconds.
UPDATE_SEEN_SECONDS=300
SAID_SECONDS=120
UPDATED_SECONDS=300
# What fixes itself within ten minutes is never asked about: the drill moves its task's start back past that.
SETTLED_MILLISECONDS=660000

OWN_CONTAINERS=("$ENGINE")
OWN_VOLUMES=("$STORE")
OWN_IMAGES=("$IMAGE" "$APP_ONE" "$APP_TWO")
OWN_FOLDERS=("$RUN_FOLDER" "$WORK")
trap remove_own EXIT
step() { printf '\n== %s\n' "$1"; }
fail() {
  echo "DRILL FAILED: $1" >&2
  inner ps -a >&2
  inner logs autoheal-control-plane 2>&1 | tail -25 >&2
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
# What the stand-in was sent, of one tier, as JSON lines.
sent() {
  inner exec drill-home "$NODE" -e "
    fetch('http://127.0.0.1:8123/drill/sent').then((answer) => answer.json()).then((sent) =>
      process.stdout.write(sent.filter(({ tier }) => tier === process.argv[1]).map((one) => JSON.stringify(one)).join('\n')));" "$1"
}
# A line set on the answer box, as an automation does.
write_line() {
  inner exec drill-home "$NODE" -e "
    fetch('http://127.0.0.1:8123/drill/state', { method: 'POST', body: JSON.stringify({ entity_id: process.argv[1], state: process.argv[2] }) })
      .then((answer) => process.exit(answer.ok ? 0 : 1));" "$BOX" "$1"
}
field() { python3 -I -c 'import json, sys; print(json.loads(sys.argv[1])[sys.argv[2]])' "$1" "$2"; }
# The registry in the engine: every tag names the first version given, and the others are still there by digest, as
# a registry keeps them; the runner offers an update only for an image whose registry still knows the one it runs.
registry() {
  local older=()
  for version in "${@:2}"; do older+=("/tmp/$version"); done
  inner rm -f drill-registry >/dev/null 2>&1
  inner create --name drill-registry --network host --entrypoint "$NODE" "$IMAGE" /tmp/registry.mjs "/tmp/$1" 5000 \
    "${older[@]}" >/dev/null
  inner cp "$HERE/../runner-update-drill/registry.mjs" drill-registry:/tmp/registry.mjs
  for version in "$@"; do inner cp "$WORK/$version" drill-registry:/tmp/; done
  inner start drill-registry >/dev/null
  for _ in $(seq 30); do inner exec drill-registry "$NODE" -e "fetch('http://127.0.0.1:5000/v2/').then((answer) => process.exit(answer.ok ? 0 : 1), () => process.exit(1))" && return; sleep 1; done
  fail "the registry never answered"
}

step "images: this checkout's, and a small app in two versions"
docker build -q -t "$IMAGE" "$HERE/../.." >/dev/null || exit 9
app_image() {
  printf 'FROM %s\nLABEL autoheal.drill.app=%s\nHEALTHCHECK NONE\nENTRYPOINT ["%s", "-e", "setInterval(() => {}, 2 ** 30)"]\nCMD []\n' \
    "$IMAGE" "$2" "$NODE" | docker build -q -t "$1" - >/dev/null
}
app_image "$APP_ONE" one && app_image "$APP_TWO" two || exit 9
for version in one two; do
  docker save "${APP_OF[$version]}" -o "$WORK/$version.tar" || exit 9
  mkdir "$WORK/$version" && tar -xf "$WORK/$version.tar" -C "$WORK/$version" || exit 9
done
TWO_ID=$(docker inspect -f '{{.Id}}' "$APP_TWO")

step "a disposable engine with no network"
mkdir -p "$RUN_FOLDER"
docker run -d --name "$ENGINE" --privileged --network none --label com.autoheal.helper=true \
  -e DOCKER_TLS_CERTDIR= -v "$STORE:/var/lib/docker" -v "$RUN_FOLDER:/fixture-run" "$ENGINE_IMAGE" \
  dockerd --host=unix:///fixture-run/docker.sock --group="$(id -g)" --bridge=none --iptables=false >/dev/null || exit 9
for _ in $(seq "$ENGINE_START_SECONDS"); do inner version >/dev/null 2>&1 && break; sleep 1; done
docker save "$IMAGE" | inner load -q >/dev/null || exit 9

step "the app, pulled from the registry in there so it has a digest to compare, and then a newer image out"
registry one
inner pull -q "$APP" >/dev/null || fail "the app could not be pulled"
inner run -d --name drill-app --network none "$APP" >/dev/null || fail "the app did not start"
registry two one
[[ "$(inner inspect -f '{{.Image}}' drill-app)" != "$TWO_ID" ]] || fail "the app already runs the newer image"

step "a stand-in for Home Assistant, a control plane that knows it, and an acting runner"
inner create --name drill-home --network host --entrypoint "$NODE" "$IMAGE" /tmp/home-assistant.mjs 8123 "$HOME_TOKEN" >/dev/null
inner cp "$HERE/home-assistant.mjs" drill-home:/tmp/home-assistant.mjs
inner cp "$HERE/../../node_modules/ws" drill-home:/tmp/ws
inner start drill-home >/dev/null
printf '%s' "$HOME_TOKEN" >"$WORK/home-token"
inner create --name autoheal-control-plane --network host -v cp-data:/data -v cp-join:/join \
  -e PUBLIC_BASE_URL=https://autoheal.example.org -e OLLAMA_URL=http://127.0.0.1:11434 \
  -e BACKUP_PASSPHRASE="$PASSPHRASE" -e HOME_ASSISTANT_URL=http://127.0.0.1:8123 \
  -e HOME_ASSISTANT_TOKEN_FILE=/tmp/home-token "$IMAGE" >/dev/null
inner cp "$WORK/home-token" autoheal-control-plane:/tmp/home-token
inner start autoheal-control-plane >/dev/null
for _ in $(seq 60); do
  inner exec autoheal-control-plane "$NODE" /app/dist/server/main.js healthcheck >/dev/null 2>&1 && break
  sleep 1
done
inner run -d --name autoheal --network host --add-host control-plane:127.0.0.1 \
  --user 65532:65532 --group-add "$(id -g)" --read-only --tmpfs /tmp:size=8m --cap-drop ALL \
  --security-opt no-new-privileges:true -v /fixture-run/docker.sock:/var/run/docker.sock -v cp-join:/join:ro \
  -e AUTOHEAL_CONTAINER_NAME=autoheal -e DRY_RUN=0 "$IMAGE" runner >/dev/null
HOST_ID=""
for _ in $(seq 90); do
  HOST_ID=$(query "SELECT id FROM hosts WHERE last_heartbeat_at IS NOT NULL LIMIT 1" 2>/dev/null)
  [[ -n "$HOST_ID" ]] && break
  sleep 2
done
[[ -n "$HOST_ID" ]] || fail "the runner never reported"
HOST_LABEL=$(query "SELECT label FROM hosts WHERE id = ?" "$HOST_ID")
echo "runner reports as $HOST_LABEL"
ADMIN_ID=$(query "SELECT id FROM users WHERE role = 'admin' LIMIT 1")
[[ -n "$ADMIN_ID" ]] || fail "no admin account"
# A person who has set a password and two factors, as anyone who can connect the assistant has.
run_query "UPDATE users SET must_change_password = 0, totp_enabled = 1 WHERE id = ?" "$ADMIN_ID"

step "the assistant connected, set to ask before updating a container"
inner cp "$HERE/connect.mjs" autoheal-control-plane:/tmp/connect.mjs
inner exec autoheal-control-plane "$NODE" /tmp/connect.mjs "$PASSPHRASE" || fail "could not connect the assistant"

step "the newer image is seen, and its task waits on a person"
TASK=""
for _ in $(seq "$UPDATE_SEEN_SECONDS"); do
  TASK=$(query "SELECT id FROM tasks WHERE detector_key = ? AND closed_at IS NULL" "update:$HOST_ID:drill-app")
  [[ -n "$TASK" ]] && break
  sleep 1
done
reported() {
  query "SELECT containers_json FROM hosts WHERE id = ?" "$HOST_ID" |
    python3 -I -c 'import json, sys; print([one.get("update") for one in json.load(sys.stdin) if one["name"] == "drill-app"])'
}
[[ -n "$TASK" ]] || fail "no update task for the app; its runner reports $(reported)"
[[ -z "$(query "SELECT assignee_agent FROM tasks WHERE id = ? AND assignee_agent IS NOT NULL" "$TASK")" ]] ||
  fail "the update is not a person's"
run_query "UPDATE tasks SET created_at = created_at - ? WHERE id = ?" "$SETTLED_MILLISECONDS" "$TASK"

step "the assistant asks"
QUESTION=""
for _ in $(seq "$SAID_SECONDS"); do
  QUESTION=$(sent ask | head -1)
  [[ -n "$QUESTION" ]] && break
  sleep 1
done
[[ -n "$QUESTION" ]] || fail "the assistant never asked"
echo "asked: $(field "$QUESTION" say)"

step "heard, and answered yes in the answer box"
write_line "autoheal heard $(field "$QUESTION" id) $(date +%s)" || fail "the stand-in took no line"
write_line "autoheal yes $(field "$QUESTION" code) $(($(date +%s) + 1)) voice Drill Room" || fail "the stand-in took no line"

step "it says it is updating, updates the app, and tells what came of it"
REPLIES=""
for _ in $(seq "$UPDATED_SECONDS"); do
  REPLIES=$(sent reply)
  [[ "$(printf '%s\n' "$REPLIES" | grep -c .)" -ge 2 ]] && break
  sleep 1
done
printf '%s\n' "$REPLIES" | while read -r reply; do [[ -n "$reply" ]] && echo "said: $(field "$reply" say)"; done
FIRST=$(printf '%s\n' "$REPLIES" | sed -n 1p)
LAST=$(printf '%s\n' "$REPLIES" | sed -n 2p)
# The written words keep names as they are; the spoken ones say them as Piper reads them.
[[ -n "$FIRST" && "$(field "$FIRST" text)" == "$HOST_LABEL: updating drill-app now." ]] || fail "it did not say it was updating"
[[ -n "$LAST" && "$(field "$LAST" text)" == "$HOST_LABEL: drill-app is updated." ]] || fail "it did not say the app is updated"
[[ "$(inner inspect -f '{{.Image}}' drill-app)" == "$TWO_ID" ]] || fail "the app does not run the newer image"
[[ "$(inner inspect -f '{{.State.Running}}' drill-app)" == "true" ]] || fail "the app is not running"
echo "the app runs the newer image"
[[ "$(query "SELECT status FROM tasks WHERE id = ?" "$TASK")" == "done" ]] || fail "the update's task is not done"
[[ "$(query "SELECT status FROM jarvis_items WHERE id = ?" "$(field "$QUESTION" id)")" == "done" ]] ||
  fail "the question is not done"
ANSWERED=$(query "SELECT actor_label || ' ' || details_json FROM audit_events WHERE action = 'assistant.answered'")
echo "audit: $ANSWERED"
[[ "$ANSWERED" == *'"answer":"yes"'*'"how":"voice"'* ]] || fail "the audit log does not say who answered, and how"

printf '\nDRILL PASSED\n'
