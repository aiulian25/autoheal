import { z } from "zod";
import { ERROR_TEXT_LIMIT, HOST_HELPER_OUTCOMES } from "../shared/constants.js";

/** The one line the helper prints, which the runner reads from its output. */
export const helperReportSchema = z.object({
  outcome: z.enum(HOST_HELPER_OUTCOMES),
  reason: z.string().max(ERROR_TEXT_LIMIT).optional(),
});

export type HelperReport = z.infer<typeof helperReportSchema>;
