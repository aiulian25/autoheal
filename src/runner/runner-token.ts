import { setTimeout as sleep } from "node:timers/promises";
import { ConfigError } from "../config/environment-schema.js";
import type { RunnerConfig } from "../config/runner-config.js";
import {
  CONFIG_MESSAGES,
  ENV_JOIN_CODE,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  HTTP_CLIENT_ERRORS,
  HTTP_STATUS,
  MILLISECONDS_PER_SECOND,
  RUNNER_MESSAGES,
  RUNNER_TOKEN_PATTERN,
  RUNNER_TOKEN_VOLUME,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { sha256Hex } from "../shared/hash.js";
import { log } from "../shared/log.js";
import { newToken, type EnrolmentDetails } from "../shared/join-code.js";
import { ControlPlaneError, JoinCodeRefusedError, redeemJoinCode } from "./control-plane-client.js";
import type { DockerClient } from "./docker-client.js";

type Store = Pick<DockerClient, "volumes" | "createVolume">;
type Redeem = (code: EnrolmentDetails, token: string) => Promise<void>;
type Pause = (milliseconds: number) => Promise<unknown>;

const RETRY_SECONDS = HEARTBEAT_INTERVAL_MILLISECONDS / MILLISECONDS_PER_SECOND;

// One volume for each join code, named after it: a runner given a new code trades that one, and runners sharing an
// engine keep theirs apart.
const volumeOf = (enrolment: string) =>
  `${RUNNER_TOKEN_VOLUME.prefix}${sha256Hex(enrolment).slice(0, RUNNER_TOKEN_VOLUME.codeHashCharacters)}`;

// Worth asking again: no answer, a busy control plane or one that failed. Any other answer is its last word.
function answersLater(error: unknown): boolean {
  if (!(error instanceof ControlPlaneError)) {
    return true;
  }
  const clientError = error.status >= HTTP_CLIENT_ERRORS.from && error.status <= HTTP_CLIENT_ERRORS.through;
  return !clientError || error.status === HTTP_STATUS.tooManyRequests;
}

async function keptToken(store: Store, enrolment: string): Promise<string | null> {
  const name = volumeOf(enrolment);
  const volume = (await store.volumes(RUNNER_TOKEN_VOLUME.label)).find((each) => each.Name === name);
  const token = volume?.Labels?.[RUNNER_TOKEN_VOLUME.label] ?? "";
  return RUNNER_TOKEN_PATTERN.test(token) ? token : null;
}

// Asked again with the same token until the control plane answers, so an answer lost on the way costs nothing. A
// code it refuses stays refused: the runner stops, saying what to do.
async function redeemed(code: EnrolmentDetails, redeem: Redeem, pause: Pause): Promise<string> {
  const token = newToken();
  for (;;) {
    try {
      await redeem(code, token);
      return token;
    } catch (error) {
      if (error instanceof JoinCodeRefusedError) {
        throw new ConfigError([`${ENV_JOIN_CODE}: ${CONFIG_MESSAGES.joinCodeRefused}`]);
      }
      if (!answersLater(error)) {
        throw error;
      }
      log(RUNNER_MESSAGES.joinCodeRetry(describeError(error), RETRY_SECONDS));
      await pause(HEARTBEAT_INTERVAL_MILLISECONDS);
    }
  }
}

/**
 * A runner whose join code works once reports with a token it made itself: traded for the code on first contact, and
 * kept in the label of a Docker volume, as its safety records are. Started again, it finds the token there and asks
 * nothing. Any other runner's configuration stays as it is.
 */
export async function withRunnerToken(
  config: RunnerConfig,
  store: Store,
  redeem: Redeem = redeemJoinCode,
  pause: Pause = sleep,
): Promise<RunnerConfig> {
  const code = config.enrolment;
  if (code === null) {
    return config;
  }
  const kept = await keptToken(store, code.enrolment);
  const token = kept ?? (await redeemed(code, redeem, pause));
  if (kept === null) {
    await store
      .createVolume(volumeOf(code.enrolment), { [RUNNER_TOKEN_VOLUME.label]: token })
      .catch((error: unknown) => log(RUNNER_MESSAGES.tokenNotKept(describeError(error))));
  }
  return { ...config, controlPlane: { url: code.url, pin: code.pin, token }, enrolment: null };
}
