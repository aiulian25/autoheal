import { CSRF_HEADER } from "../../src/shared/api.js";
import {
  HTTP_HEADERS,
  HTTP_STATUS,
  JSON_CONTENT_TYPE,
  MILLISECONDS_PER_SECOND,
  OCTET_STREAM,
  RATE_LIMIT_WINDOW_MILLISECONDS,
} from "../../src/shared/constants.js";
import { QUERY_RETRIES, QUERY_RETRY_DELAY_MILLISECONDS, RATE_LIMITED_RETRIES } from "./constants.js";

/** A refusal from the API, with its stable error code and any detail it sent. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(code);
  }
}

/** An error whose message is for people as it is: a runner's word on why it could not, or the dashboard's own. */
export class ReadableError extends Error {}

let csrfToken: string | null = null;

export const rememberCsrfToken = (token: string | null) => {
  csrfToken = token;
};

export function api<Result>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Result> {
  const contentType = body === undefined ? null : JSON_CONTENT_TYPE;
  return send<Result>(method, path, contentType, body === undefined ? undefined : JSON.stringify(body), signal);
}

/** Raw bytes, for uploading a backup file to restore. */
export const upload = <Result>(path: string, file: File) => send<Result>("POST", path, OCTET_STREAM, file);

async function send<Result>(
  method: string,
  path: string,
  contentType: string | null,
  body?: BodyInit,
  signal?: AbortSignal,
): Promise<Result> {
  const headers: Record<string, string> = {};
  if (contentType !== null) {
    headers[HTTP_HEADERS.contentType] = contentType;
  }
  if (method !== "GET" && csrfToken !== null) {
    headers[CSRF_HEADER] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body,
    ...(signal === undefined ? {} : { signal }),
  });
  if (response.status === HTTP_STATUS.noContent) {
    return undefined as Result;
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(response.status, String(data.error ?? response.status), data);
  }
  return data as Result;
}

const isRateLimited = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === HTTP_STATUS.tooManyRequests;

/** Whether a failed query is asked again: a refusal for too many requests is not the end of the page. */
export const shouldRetryQuery = (failures: number, error: unknown) =>
  failures < (isRateLimited(error) ? RATE_LIMITED_RETRIES : QUERY_RETRIES);

/** When to ask again: when the server said, for a refusal for too many requests, else in a second. */
export function queryRetryDelay(_failures: number, error: unknown): number {
  if (!isRateLimited(error)) {
    return QUERY_RETRY_DELAY_MILLISECONDS;
  }
  const seconds = error.body.retryAfterSeconds;
  return typeof seconds === "number" ? seconds * MILLISECONDS_PER_SECOND : RATE_LIMIT_WINDOW_MILLISECONDS;
}
