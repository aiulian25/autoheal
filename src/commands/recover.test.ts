import { describe, expect, it } from "vitest";
import { runRecover } from "./recover.js";
import { EXIT_FAILURE, EXIT_SUCCESS } from "../shared/constants.js";
import type { ShutdownRecord } from "../runner/shutdown-journal.js";

const record = (change: Partial<ShutdownRecord> = {}): ShutdownRecord => ({
  version: 1,
  id: "24225df3-1f68-403a-9821-634f47efbe17",
  operation: "job:bb98afa4-fd27-4a98-9b19-efd85b976154:install",
  target: "adult-media-manager",
  step: 10,
  phase: "remove",
  reference: "autoheal-terminal-c6af53f0",
  at: Date.UTC(2026, 10, 3, 18, 20),
  ...change,
});

/** A journal holding what the runner will not step over, which clearing lets go of. */
function journalWith(blocking: ShutdownRecord[]) {
  const state = { blocking, cleared: 0 };
  return {
    state,
    journal: {
      blocking: async () => state.blocking,
      clearBlocking: async () => {
        state.cleared += 1;
        const gone = state.blocking;
        state.blocking = [];
        return gone;
      },
    },
  };
}
const said = () => {
  const lines: string[] = [];
  return { lines, output: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } };
};

describe("the way past a runner that will not start", () => {
  it("says what holds it back, in words rather than a dump, and changes nothing", async () => {
    const { journal, state } = journalWith([
      record(),
      record({
        id: "05d9e759-d637-44d0-8ef2-b288eb3d2cb4",
        operation: "job:29efb614:remove_images",
        target: "",
        step: 1,
      }),
    ]);
    const { lines, output } = said();

    expect(await runRecover([], output, journal)).toBe(EXIT_SUCCESS);

    expect(lines[0]).toContain("install on adult-media-manager (step 10, 2026-11-03 18:20)");
    expect(lines[1]).toContain("remove_images (step 1,");
    expect(lines.join("\n")).not.toContain('"version"');
    expect(state.cleared).toBe(0);
    expect(state.blocking).toHaveLength(2);
  });

  it("tells the person how to let the runner start, without doing it for them", async () => {
    const { journal } = journalWith([record()]);
    const { lines, output } = said();

    await runRecover([], output, journal);

    expect(lines.at(-1)).toContain("--clear");
    expect(lines.at(-1)).toContain("Nothing is undone or retried");
  });

  it("clears only when asked, and says how many it let go of", async () => {
    const { journal, state } = journalWith([record(), record({ id: "f51ec05d-0afd-41f0-a4ab-2b022ad47015", step: 1 })]);
    const { lines, output } = said();

    expect(await runRecover(["--clear"], output, journal)).toBe(EXIT_SUCCESS);

    expect(state.cleared).toBe(1);
    expect(state.blocking).toEqual([]);
    expect(lines.at(-1)).toContain("2 unfinished operations cleared");
  });

  it("says plainly when nothing holds it back", async () => {
    const { journal } = journalWith([]);
    const { lines, output } = said();

    expect(await runRecover(["--clear"], output, journal)).toBe(EXIT_SUCCESS);

    expect(lines).toEqual(["Nothing is unfinished here: the runner is not held back by its journal."]);
  });

  it("reports a journal it cannot read rather than pretending it is clear", async () => {
    const journal = {
      blocking: async () => {
        throw new Error("Cannot connect to the Docker daemon");
      },
      clearBlocking: async () => [],
    };
    const { lines, output } = said();

    expect(await runRecover([], output, journal)).toBe(EXIT_FAILURE);
    expect(lines[0]).toContain("Cannot connect to the Docker daemon");
  });
});
