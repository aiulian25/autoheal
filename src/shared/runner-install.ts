import { COMPOSE_FILE } from "./install.js";
import {
  CHASSIS_TYPE_PATH,
  DOCKER_GID_COMMAND,
  DOCKER_GID_SETTING,
  ENV_JOIN_CODE,
  HEREDOC_END,
  NVIDIA_CONTAINER_HOOK,
  NVIDIA_GPUS_PATH,
  PORTABLE_CHASSIS_TYPES,
  RUNNER_COMPOSE,
  RUNNER_GPU_OVERRIDE,
  RUNNER_GPU_OVERRIDE_FILE,
  RUNNER_IMAGE_FILE,
  RUNNER_INSTALL_DIRECTORY,
  RUNNER_NAS_TEXT,
} from "./constants.js";

// Set when the runner was given the GPU here, so that starting without it undoes only that.
const GIVEN = "autoheal_gpu";

/**
 * A host with an NVIDIA card, Docker's toolkit for it and no laptop's chassis gives the runner the GPU for its dial,
 * never over an override already there. Should Docker refuse it, the runner starts without.
 */
const gpuLines = [
  `${GIVEN}=`,
  `case "$(cat ${CHASSIS_TYPE_PATH} 2>/dev/null)" in ${PORTABLE_CHASSIS_TYPES.join("|")}) ;; *) [ -n "$(ls ${NVIDIA_GPUS_PATH} 2>/dev/null)" ] && command -v ${NVIDIA_CONTAINER_HOOK} >/dev/null && (set -C; cat > ${RUNNER_GPU_OVERRIDE_FILE}) <<'${HEREDOC_END}' && ${GIVEN}=1`,
  RUNNER_GPU_OVERRIDE.trimEnd(),
  HEREDOC_END,
  ";; esac",
];

/**
 * One paste on the new host: a folder with the runner's compose file and an owner-only .env holding
 * the join code and the Docker socket's group (read there, when pasted), the GPU where it fits, then the start.
 */
export const installCommand = (image: string, joinCode: string) =>
  [
    `mkdir -p ${RUNNER_INSTALL_DIRECTORY} && cd ${RUNNER_INSTALL_DIRECTORY}`,
    `cat > ${COMPOSE_FILE} <<'${HEREDOC_END}'`,
    RUNNER_COMPOSE(image).trimEnd(),
    HEREDOC_END,
    `cat > .env <<${HEREDOC_END}`,
    `${ENV_JOIN_CODE}=${joinCode}`,
    `${DOCKER_GID_SETTING}=${DOCKER_GID_COMMAND}`,
    HEREDOC_END,
    "chmod 600 .env",
    ...gpuLines,
    `docker compose up -d || { [ -n "$${GIVEN}" ] && rm ${RUNNER_GPU_OVERRIDE_FILE} && docker compose up -d; }`,
  ].join("\n");

const NAS_SCRIPT_END = "AUTOHEAL_INSTALL";
// Where a NAS keeps its tools, which sudo's own path often leaves out.
const NAS_PATH_LINE = 'PATH="$PATH:/usr/local/bin:/usr/syno/bin:/opt/bin"; export PATH';
const COMPOSE_CHOICE = [
  'if docker compose version >/dev/null 2>&1 </dev/null; then compose="docker compose"',
  "elif command -v docker-compose >/dev/null 2>&1; then compose=docker-compose",
  `else echo "${RUNNER_NAS_TEXT.noCompose}" >&2; exit 1; fi`,
];

/** An image named with no registry or account is one this installation built itself: nothing can download it. */
export const imageCanBePulled = (image: string) => image.includes("/");

/** Made where the dashboard runs, for a host that cannot download the image. */
// It says nothing when it works, so it ends by showing where the file went and how big it is.
export const imageCopyCommand = (image: string) =>
  `docker save ${image} | gzip -1 > ~/${RUNNER_IMAGE_FILE} && ls -lh ~/${RUNNER_IMAGE_FILE}`;

const imageLines = (image: string, folder: string) =>
  imageCanBePulled(image)
    ? []
    : [
        `if ! docker image inspect ${image} >/dev/null 2>&1 </dev/null; then`,
        `  [ -f ${RUNNER_IMAGE_FILE} ] || { echo "${RUNNER_NAS_TEXT.noImage(folder)}" >&2; exit 1; }`,
        `  docker load -i ${RUNNER_IMAGE_FILE} </dev/null || exit 1`,
        "fi",
      ];

/**
 * The same runner for a Synology or another NAS: one paste that runs under sudo, as Docker needs there, in the folder
 * its containers live in. It reads none of the machine's files, as these have no systemd or OS updates to report, and
 * has no GPU to look for. Some of their kernels cannot limit a container's CPU, so it starts without that limit then.
 * The shell reads this script from its input, so nothing it runs may be left reading from there too.
 */
export const nasInstallCommand = (image: string, joinCode: string, folder: string) =>
  [
    `sudo sh <<'${NAS_SCRIPT_END}'`,
    NAS_PATH_LINE,
    `mkdir -p ${folder} && cd ${folder} || exit 1`,
    ...COMPOSE_CHOICE,
    ...imageLines(image, folder),
    `cat > ${COMPOSE_FILE} <<'${HEREDOC_END}'`,
    RUNNER_COMPOSE(image, false).trimEnd(),
    HEREDOC_END,
    "umask 077",
    `cat > .env <<${HEREDOC_END}`,
    `${ENV_JOIN_CODE}=${joinCode}`,
    `${DOCKER_GID_SETTING}=${DOCKER_GID_COMMAND}`,
    HEREDOC_END,
    `$compose up -d </dev/null || { sed -i '/^ *cpus:/d' ${COMPOSE_FILE}; $compose up -d </dev/null; }`,
    NAS_SCRIPT_END,
  ].join("\n");
