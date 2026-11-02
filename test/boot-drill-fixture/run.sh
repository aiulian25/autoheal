#!/bin/bash
# A boot drill on a real engine of its own: no network, a private socket, nothing shared with this machine's engine.
# Removes all it made. Run `npm run build` first. HELPER_IMAGE is the Autoheal image whose helper copies the data.
# REAL_IMAGE also runs a published application, which must be on this machine, with /data and API on port 81.
#   test/boot-drill-fixture/run.sh
#   REAL_IMAGE=jc21/nginx-proxy-manager:latest test/boot-drill-fixture/run.sh
set -u
ENGINE_IMAGE=docker:29.9.0-dind
BASE_IMAGE=docker:29.9.0-cli
export HELPER_IMAGE="${HELPER_IMAGE:-autoheal:dev-latest}"
export REAL_IMAGE="${REAL_IMAGE:-}"
ENGINE=autoheal-boot-fixture
STORE=autoheal-boot-fixture-store
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_FOLDER="$HOME/.cache/autoheal-boot-fixture"
SOCKET="$RUN_FOLDER/docker.sock"
WORK="$(mktemp -d)"
ENGINE_START_SECONDS=60

cleanup() {
  unset DOCKER_HOST
  docker rm -f "$ENGINE" >/dev/null 2>&1
  docker volume rm "$STORE" >/dev/null 2>&1
  rm -rf "${RUN_FOLDER:?}" "${WORK:?}"
}
trap cleanup EXIT

mkdir -p "$RUN_FOLDER"
docker run -d --name "$ENGINE" --privileged --network none --label com.autoheal.helper=true \
  -e DOCKER_TLS_CERTDIR= -v "$STORE:/var/lib/docker" -v "$RUN_FOLDER:/fixture-run" "$ENGINE_IMAGE" \
  dockerd --host=unix:///fixture-run/docker.sock --group="$(id -g)" --bridge=none --iptables=false >/dev/null || exit 9
for _ in $(seq "$ENGINE_START_SECONDS"); do
  DOCKER_HOST="unix://$SOCKET" docker version >/dev/null 2>&1 && break
  sleep 1
done
for image in "$BASE_IMAGE" "$HELPER_IMAGE" $REAL_IMAGE; do
  docker save "$image" | DOCKER_HOST="unix://$SOCKET" docker load -q >/dev/null || exit 9
done
export DOCKER_HOST="unix://$SOCKET"

cp "$HERE/app/"* "$WORK/"
cd "$WORK" || exit 9
build() { docker build -q --network none "$@" . >/dev/null || exit 9; }
build -t fixture-app:1
build -t fixture-app:2 --build-arg FORMAT=2
{ cat Dockerfile; echo 'HEALTHCHECK --interval=1s --timeout=1s --retries=2 CMD test -f /tmp/ready'; } >Dockerfile.health
build -f Dockerfile.health -t fixture-app:health
{ cat Dockerfile; echo 'HEALTHCHECK --interval=1s --timeout=1s --retries=2 CMD false'; } >Dockerfile.sick
build -f Dockerfile.sick -t fixture-app:unhealthy

node "$HERE/driver.mjs" "$SOCKET"
