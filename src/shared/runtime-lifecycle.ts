/** Owns admitted scheduled invocations until their returned promises settle. */
export class RuntimeLifecycle {
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;

  get stopping() {
    return this.closing;
  }

  run(work: () => unknown): Promise<void> {
    if (this.closing) return Promise.resolve();
    const task = Promise.resolve()
      .then(work)
      .then(() => undefined);
    this.active.add(task);
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    );
    return task;
  }

  stop() {
    this.closing = true;
  }

  async settled() {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }
}
