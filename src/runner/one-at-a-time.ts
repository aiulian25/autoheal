/** Asked while it runs, it runs once more after it: what changed meanwhile is never left for the next tick. */
export function coalesced(work: () => Promise<void>): () => Promise<void> {
  let running = false;
  let askedAgain = false;
  const run = async (): Promise<void> => {
    if (running) {
      askedAgain = true;
      return;
    }
    running = true;
    try {
      await work();
    } finally {
      running = false;
    }
    if (!askedAgain) return;
    askedAgain = false;
    await run();
  };
  return run;
}

/** Asked while it runs, it is skipped: a sample due again in a few seconds never overlaps the one still being read. */
export function skippedWhileRunning(work: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await work();
    } finally {
      running = false;
    }
  };
}
