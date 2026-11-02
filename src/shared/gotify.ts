import type { GotifySettings } from "../config/shared-settings.js";
import {
  RUNNER_MESSAGES,
  GOTIFY_MESSAGE_PATH,
  GOTIFY_TOKEN_HEADER,
  JSON_CONTENT_TYPE,
  NOTIFY_MESSAGE_LIMIT,
  NOTIFY_TIMEOUT_MILLISECONDS,
  HTTP_HEADERS,
} from "./constants.js";
import { describeError } from "./errors.js";
import { log } from "./log.js";
import { joinUrl } from "./urls.js";

/**
 * Sends one message to a runner's own Gotify. Never throws: a notification that cannot be delivered
 * must not stop the healing.
 */
export async function postToGotify(gotify: GotifySettings, title: string, body: string, priority: number) {
  try {
    const response = await fetch(joinUrl(gotify.url, GOTIFY_MESSAGE_PATH), {
      method: "POST",
      headers: { [HTTP_HEADERS.contentType]: JSON_CONTENT_TYPE, [GOTIFY_TOKEN_HEADER]: gotify.token },
      body: JSON.stringify({ title, message: body.slice(0, NOTIFY_MESSAGE_LIMIT), priority }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      log(RUNNER_MESSAGES.notificationFailed(String(response.status)));
    }
  } catch (error) {
    log(RUNNER_MESSAGES.notificationFailed(describeError(error)));
  }
}
