# A drill's clean-up, sourced by each drill. Every run names what it makes after itself, and lists those names before
# making anything; its exit removes whichever of them exist, on the engine it was started against, and says what it
# could not. A name alone proves nothing: a person's, or another run's, may share a fixed one.
DRILL_RUN="$(date +%s)-$$-$RANDOM"
DRILL_DOCKER_HOST="${DOCKER_HOST:-}"
OWN_CONTAINERS=()
OWN_VOLUMES=()
OWN_IMAGES=()
OWN_FOLDERS=()

# The engine the drill was started against, whatever DOCKER_HOST says by the time it ends.
outer() {
  if [[ -n "$DRILL_DOCKER_HOST" ]]; then
    DOCKER_HOST="$DRILL_DOCKER_HOST" docker "$@"
  else
    env -u DOCKER_HOST docker "$@"
  fi
}

remove_own() {
  local left=() name
  for name in "${OWN_CONTAINERS[@]}"; do
    outer container inspect "$name" >/dev/null 2>&1 || continue
    outer rm -f "$name" >/dev/null 2>&1 || left+=("container $name")
  done
  for name in "${OWN_VOLUMES[@]}"; do
    outer volume inspect "$name" >/dev/null 2>&1 || continue
    outer volume rm "$name" >/dev/null 2>&1 || left+=("volume $name")
  done
  for name in "${OWN_IMAGES[@]}"; do
    outer image inspect "$name" >/dev/null 2>&1 || continue
    outer rmi "$name" >/dev/null 2>&1 || left+=("image $name")
  done
  for name in "${OWN_FOLDERS[@]}"; do
    [[ -e "$name" ]] || continue
    rm -rf -- "${name:?}" || left+=("folder $name")
  done
  if ((${#left[@]} > 0)); then printf 'LEFT BEHIND: %s\n' "${left[@]}" >&2; fi
}
