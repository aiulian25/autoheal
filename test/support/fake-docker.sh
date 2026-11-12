#!/bin/bash
# A stand-in for the docker command, for the drills' tests: no engine is ever asked. What exists is a list of lines in
# $FAKE_DOCKER_WORLD ("container NAME", "volume NAME", "image NAME", "network NAME"); every call is noted in
# $FAKE_DOCKER_CALLS, after the engine it was asked of; a command named in $FAKE_DOCKER_FAIL (run, build, save, load…)
# fails.
echo "${DOCKER_HOST:-default} $*" >>"$FAKE_DOCKER_CALLS"
world="$FAKE_DOCKER_WORLD"
has() { grep -qxF "$1 $2" "$world"; }
add() { has "$1" "$2" || echo "$1 $2" >>"$world"; }
drop() {
  local kind=$1 name gone=0
  shift
  for name in "$@"; do
    has "$kind" "$name" || {
      gone=1
      continue
    }
    grep -vxF "$kind $name" "$world" >"$world.next"
    mv "$world.next" "$world"
  done
  return "$gone"
}
failing() { [[ " ${FAKE_DOCKER_FAIL:-} " == *" $1 "* ]]; }
name_after() {
  local wanted=$1
  shift
  while (($# > 0)); do
    [[ "$1" == "$wanted" ]] && echo "$2" && return
    shift
  done
}
case "$1" in
container | volume | image | network)
  case "$2" in
  inspect) has "$1" "$3" ;;
  create)
    failing "$1-create" && exit 1
    add "$1" "${@: -1}"
    ;;
  rm) drop "$1" "${@:3}" ;;
  *) exit 0 ;;
  esac
  ;;
rm)
  failing rm && exit 1
  [[ "$2" == "-f" ]] && shift
  drop container "${@:2}"
  ;;
rmi) drop image "${@:2}" ;;
run)
  failing run && exit 1
  add container "$(name_after --name "$@")"
  echo "fake-container-id"
  ;;
build)
  failing build && exit 1
  add image "$(name_after -t "$@")"
  ;;
*)
  failing "$1" && exit 1
  [[ "$1" == "inspect" ]] && echo "sha256:fake"
  exit 0
  ;;
esac
