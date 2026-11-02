import { z } from "zod";
import {
  HTTPS_PROTOCOL_PATTERN,
  JOIN_CODE_ENCODING,
  JOIN_CODE_PREFIX,
  PUBLIC_KEY_PIN_PATTERN,
  RUNNER_TOKEN_PATTERN,
} from "./constants.js";

const joinDetailsSchema = z.object({
  url: z.url({ protocol: HTTPS_PROTOCOL_PATTERN }),
  token: z.string().regex(RUNNER_TOKEN_PATTERN),
  // The control plane's public key: the runner accepts its certificate by it, with no CA file.
  pin: z.string().regex(PUBLIC_KEY_PIN_PATTERN),
});

/** Where a runner reports, the token it reports with, and how it knows the control plane. */
export type JoinDetails = z.infer<typeof joinDetailsSchema>;

export const encodeJoinCode = (details: JoinDetails) =>
  `${JOIN_CODE_PREFIX}${Buffer.from(JSON.stringify(details)).toString(JOIN_CODE_ENCODING)}`;

/** The details in a join code, or null when it is not one. */
export function decodeJoinCode(code: string): JoinDetails | null {
  if (!code.startsWith(JOIN_CODE_PREFIX)) {
    return null;
  }
  try {
    const encoded = Buffer.from(code.slice(JOIN_CODE_PREFIX.length), JOIN_CODE_ENCODING).toString();
    const parsed = joinDetailsSchema.safeParse(JSON.parse(encoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
