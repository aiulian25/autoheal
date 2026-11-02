/**
 * Runners waiting to hear of a shell to open or a file to reach: each waits until there is one for its host,
 * or a while, so a person's request reaches it at once instead of at its next poll.
 */
export class WaitingRunners {
  private readonly waiting = new Map<string, Set<() => void>>();

  wait(hostId: string, milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiting.get(hostId) ?? new Set();
      this.waiting.set(hostId, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      waiters.add(done);
    });
  }

  wakeAll() {
    for (const hostId of this.waiting.keys()) this.wake(hostId);
  }

  wake(hostId: string) {
    for (const done of [...(this.waiting.get(hostId) ?? [])]) {
      done();
    }
  }
}
