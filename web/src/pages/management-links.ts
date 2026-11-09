import { apiPath } from "../../../src/shared/api.js";
import { PATHS } from "../constants.js";

export const runbookLink = (runbookId: string) => apiPath(PATHS.runbook, { runbookId });

export const replayLink = (replayId: string) => apiPath(PATHS.replay, { replayId });
