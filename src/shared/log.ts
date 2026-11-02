import { LOG_PREFIX } from "./constants.js";

export const log = (message: string) => console.log(`${LOG_PREFIX} ${message}`);
