import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  ENROLMENT_PATTERN,
  ENROLMENT_PREFIX,
  HTTPS_PROTOCOL_PATTERN,
  JOIN_CODE_ENCODING,
  JOIN_CODE_PREFIX,
  PUBLIC_KEY_PIN_PATTERN,
  RUNNER_TOKEN_BYTES,
  RUNNER_TOKEN_PATTERN,
  RUNNER_TOKEN_PREFIX,
} from "./constants.js";

const secretWith = (prefix: string) => `${prefix}${randomBytes(RUNNER_TOKEN_BYTES).toString("base64url")}`;
/** What a runner reports with; the control plane keeps only its hash. */
export const newToken = () => secretWith(RUNNER_TOKEN_PREFIX);
/** What a join code that works once carries; the control plane keeps only its hash. */
export const newEnrolment = () => secretWith(ENROLMENT_PREFIX);

const url = z.url({ protocol: HTTPS_PROTOCOL_PATTERN });
// The control plane's public key: the runner accepts its certificate by it, with no CA file.
const pin = z.string().regex(PUBLIC_KEY_PIN_PATTERN);
// In this order, so that a code written again with nothing changed reads the same.
const joinDetailsSchema = z.object({ url, token: z.string().regex(RUNNER_TOKEN_PATTERN), pin });
const enrolmentDetailsSchema = z.object({ url, enrolment: z.string().regex(ENROLMENT_PATTERN), pin });

/**
 * Where a runner reports, the token it reports with, and how it knows the control plane: the code this machine's
 * runner finds in the join volume, and one given out before codes worked once.
 */
export type JoinDetails = z.infer<typeof joinDetailsSchema>;
/** A join code that works once, within the hour: where its runner trades it for the token it made, and the key. */
export type EnrolmentDetails = z.infer<typeof enrolmentDetailsSchema>;

export const encodeJoinCode = (details: JoinDetails | EnrolmentDetails) =>
  `${JOIN_CODE_PREFIX}${Buffer.from(JSON.stringify(details)).toString(JOIN_CODE_ENCODING)}`;

function decoded<Details>(code: string, schema: z.ZodType<Details>): Details | null {
  if (!code.startsWith(JOIN_CODE_PREFIX)) {
    return null;
  }
  try {
    const encoded = Buffer.from(code.slice(JOIN_CODE_PREFIX.length), JOIN_CODE_ENCODING).toString();
    const parsed = schema.safeParse(JSON.parse(encoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The details in a join code that carries its runner's token, or null when it is not one. */
export const decodeJoinCode = (code: string) => decoded(code, joinDetailsSchema);

/** The details in a join code that works once, or null when it is not one. */
export const decodeEnrolment = (code: string) => decoded(code, enrolmentDetailsSchema);
