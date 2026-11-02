#!/usr/bin/env bash
# The SSH sandbox, start to end: a throwaway Docker-in-Docker engine, the given Autoheal image loaded into it, the SSH
# host's image built there, then the browser project that adds that host over SSH and works with it. Everything is
# removed at the end (docker compose down -v), whatever happened.
#
#   test/ssh-sandbox/run.sh <image> [playwright arguments]     e.g. test/ssh-sandbox/run.sh autoheal:local
#
# Nothing but the sandbox itself runs on this machine's engine.
set -euo pipefail

image=${1:?usage: test/ssh-sandbox/run.sh <image built on this machine> [playwright arguments]}
shift
here=$(cd "$(dirname "$0")" && pwd)
project=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
sandbox=autoheal-ssh-sandbox
export SANDBOX_DOCKER_PORT=${SANDBOX_DOCKER_PORT:-23760}
# The machine's own resolver, as systemd-resolved knows it: the sandbox pulls Debian's image and packages.
SANDBOX_DNS=$(resolvectl dns 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n 1 || true)
export SANDBOX_DNS
compose=(docker compose -f "$here/compose.yaml")

cleanup() {
  # On this machine's engine, where the sandbox runs, not in it.
  env -u DOCKER_HOST -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH "${compose[@]}" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf -- "${work:?}"
}
trap cleanup EXIT

within() { # the given seconds, a description, then the check
  local seconds=$1 what=$2
  shift 2
  for _ in $(seq "$seconds"); do
    if "$@" > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "SANDBOX FAILED: $what" >&2
  return 1
}

"${compose[@]}" up -d
# Its engine answers once every certificate is written: the client's key comes before its certificate.
within 60 "the sandbox engine started" docker exec "$sandbox" docker info
docker cp "$sandbox:/certs/client" "$work/certificates" > /dev/null
image_archive="$work/image.tar"
docker save -o "$image_archive" "$image"

export DOCKER_HOST="tcp://127.0.0.1:$SANDBOX_DOCKER_PORT" DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH="$work/certificates"
within 60 "the sandbox engine answers" docker info
docker load -q -i "$image_archive"
rm -f -- "${image_archive:?}"
docker build -q -t autoheal-ssh-host:sandbox -f "$here/host.Dockerfile" "$project/test" > /dev/null

cd "$project"
SSH_SANDBOX=1 E2E_IMAGE="$image" E2E_PUBLISH_ADDRESS=0.0.0.0 \
  npx playwright test -c test/ssh-sandbox/playwright.config.ts "$@"
