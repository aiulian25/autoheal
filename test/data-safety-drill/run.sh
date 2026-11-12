#!/bin/bash
# Data and versions on a real engine of its own: no network, a private socket, nothing shared with this machine's
# engine. The compiled runner code works on it: an update whose tag moves just before Docker makes the new container,
# an update whose data is too big to copy, and the restore of a Compose stack backed up under an older version. Each
# time no version may open data it might not read. Removes all it made. Run `npm run build` first. HELPER_IMAGE is the
# Autoheal image whose helper copies the data.   HELPER_IMAGE=autoheal:local test/data-safety-drill/run.sh
set -u
ENGINE_IMAGE=docker:29.9.0-dind
BASE_IMAGE=docker:29.9.0-cli
export HELPER_IMAGE="${HELPER_IMAGE:-autoheal:dev-latest}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../support/owned-cleanup.sh
. "$HERE/../support/owned-cleanup.sh"
ENGINE="autoheal-data-drill-$DRILL_RUN"
STORE="autoheal-data-drill-store-$DRILL_RUN"
RUN_FOLDER="$HOME/.cache/autoheal-data-drill-$DRILL_RUN"
SOCKET="$RUN_FOLDER/docker.sock"
ENGINE_START_SECONDS=60
OWN_CONTAINERS=("$ENGINE")
OWN_VOLUMES=("$STORE")
OWN_FOLDERS=("$RUN_FOLDER")
trap remove_own EXIT

mkdir -p "$RUN_FOLDER/work"
docker run -d --name "$ENGINE" --privileged --network none --label com.autoheal.helper=true \
  -e DOCKER_TLS_CERTDIR= -v "$STORE:/var/lib/docker" -v "$RUN_FOLDER:/fixture-run" "$ENGINE_IMAGE" \
  dockerd --host=unix:///fixture-run/docker.sock --group="$(id -g)" --bridge=none --iptables=false >/dev/null || exit 9
for _ in $(seq "$ENGINE_START_SECONDS"); do
  DOCKER_HOST="unix://$SOCKET" docker version >/dev/null 2>&1 && break
  sleep 1
done
for image in "$BASE_IMAGE" "$HELPER_IMAGE"; do
  docker save "$image" | DOCKER_HOST="unix://$SOCKET" docker load -q >/dev/null || exit 9
done
export DOCKER_HOST="unix://$SOCKET"

cp "$HERE/app/"* "$RUN_FOLDER/work/"
cd "$RUN_FOLDER/work" || exit 9
build() { docker build -q --network none "$@" . >/dev/null || exit 9; }
build -t drill-app:1
build -t drill-app:2 --build-arg VERSION=2
build -t drill-app:2-sick --build-arg VERSION=2 --build-arg SICK=1
build -f Dockerfile.plain -t drill-plain:1
build -f Dockerfile.plain -t drill-plain:2 --build-arg MARK=2
build -f Dockerfile.plain -t drill-plain:other --build-arg MARK=other --build-arg FILL=1

node "$HERE/driver.mjs" "$SOCKET" "$RUN_FOLDER"
