import {
  COMMAND_MESSAGES,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  SHUTDOWN_SIGNALS,
  SHUTDOWN_DEADLINE_MILLISECONDS,
} from "./constants.js";
import { describeError } from "./errors.js";
import { log } from "./log.js";

/** Daemon entrypoints exit with this result, including on a stuck cleanup. Repeated signals never reenter it. */
export function untilShutdown(
  stop: () => Promise<void>,
  deadlineMilliseconds = SHUTDOWN_DEADLINE_MILLISECONDS,
): Promise<number> {
  return new Promise((resolve) => {
    let started = false;
    const finish = (code: number) => {
      for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, handle);
      clearTimeout(timer);
      resolve(code);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = (signal: NodeJS.Signals) => {
      if (started) return;
      started = true;
      log(COMMAND_MESSAGES.stopping(signal));
      timer = setTimeout(() => {
        log("Shutdown deadline exceeded; unfinished operations require recovery before further writes.");
        finish(EXIT_FAILURE);
      }, deadlineMilliseconds);
      void Promise.resolve()
        .then(stop)
        .then(
          () => finish(EXIT_SUCCESS),
          (error: unknown) => {
            log(`Shutdown failed: ${describeError(error)}`);
            finish(EXIT_FAILURE);
          },
        );
    };
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, handle);
  });
}
