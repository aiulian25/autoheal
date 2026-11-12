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

type Store = Pick<DockerClient, "volumes" | "createVolume" | "removeVolume">;
type Redeem = (code: EnrolmentDetails, token: string) => Promise<void>;
type Pause = (milliseconds: number) => Promise<unknown>;

const RETRY_SECONDS = HEARTBEAT_INTERVAL_MILLISECONDS / MILLISECONDS_PER_SECOND;

// One volume for each join code, named after it: a runner given a new code trades that one, and runners sharing an
// engine keep theirs apart. Beside it, while its token is on its way to the control plane, the same token as waiting.
const volumeOf = (enrolment: string) =>
  `${RUNNER_TOKEN_VOLUME.prefix}${sha256Hex(enrolment).slice(0, RUNNER_TOKEN_VOLUME.codeHashCharacters)}`;
const waitingVolumeOf = (enrolment: string) => `${volumeOf(enrolment)}${RUNNER_TOKEN_VOLUME.waitingSuffix}`;

// Worth asking again: no answer, a busy control plane or one that failed. Any other answer is its last word.
function answersLater(error: unknown): boolean {
  if (!(error instanceof ControlPlaneError)) {
    return true;
  }
  const clientError = error.status >= HTTP_CLIENT_ERRORS.from && error.status <= HTTP_CLIENT_ERRORS.through;
  return !clientError || error.status === HTTP_STATUS.tooManyRequests;
}

// The token kept for this code once traded, and one still waiting to be.
async function savedTokens(store: Store, enrolment: string) {
  const volumes = await store.volumes(RUNNER_TOKEN_VOLUME.label);
  const tokenIn = (name: string) => {
    const token = volumes.find((each) => each.Name === name)?.Labels?.[RUNNER_TOKEN_VOLUME.label] ?? "";
    return RUNNER_TOKEN_PATTERN.test(token) ? token : null;
  };
  return { kept: tokenIn(volumeOf(enrolment)), waiting: tokenIn(waitingVolumeOf(enrolment)) };
}

// Null once Docker keeps it; otherwise what Docker said.
const keptIn = (store: Store, name: string, token: string) =>
  store.createVolume(name, { [RUNNER_TOKEN_VOLUME.label]: token }).then(
    () => null,
    (error: unknown) => describeError(error),
  );

// Asked again with the same token until the control plane answers, so an answer lost on the way costs nothing. A
// code it refuses stays refused: the runner stops, saying what to do.
async function redeemed(code: EnrolmentDetails, token: string, redeem: Redeem, pause: Pause): Promise<void> {
  for (;;) {
    try {
      await redeem(code, token);
      return;
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
 * Kept as waiting before the code is spent, traded, then kept: a runner stopped anywhere in between trades the same
 * token on its next start, which the control plane takes again, so it needs no new code. Where Docker keeps neither,
 * it still reports, until a restart, and says so.
 */
async function traded(
  store: Store,
  code: EnrolmentDetails,
  waiting: string | null,
  redeem: Redeem,
  pause: Pause,
): Promise<string> {
  const token = waiting ?? newToken();
  const waitingName = waitingVolumeOf(code.enrolment);
  const notWaiting = waiting === null ? await keptIn(store, waitingName, token) : null;
  // A code refused for good opens nothing for this token either: nothing is kept of it.
  await redeemed(code, token, redeem, pause).catch(async (error: unknown) => {
    await store.removeVolume(waitingName).catch(() => undefined);
    throw error;
  });
  const notKept = await keptIn(store, volumeOf(code.enrolment), token);
  if (notKept === null) {
    await store.removeVolume(waitingName).catch(() => undefined);
    return token;
  }
  log(notWaiting === null ? RUNNER_MESSAGES.tokenStillWaiting(notKept) : RUNNER_MESSAGES.tokenNotKept(notKept));
  return token;
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
  const { kept, waiting } = await savedTokens(store, code.enrolment);
  if (kept !== null && waiting !== null)
    await store.removeVolume(waitingVolumeOf(code.enrolment)).catch(() => undefined);
  const token = kept ?? (await traded(store, code, waiting, redeem, pause));
  return { ...config, controlPlane: { url: code.url, pin: code.pin, token }, enrolment: null };
}
