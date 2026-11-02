/** Time that passes only when waited for: a wait returns at once, and the clock moves on by as much. */
export function instantTime(start = 0) {
  let now = start;
  return {
    wait: async (milliseconds: number) => {
      now += milliseconds;
    },
    clock: () => now,
  };
}
