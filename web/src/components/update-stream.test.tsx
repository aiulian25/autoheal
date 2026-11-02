import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateProgress } from "../../../src/shared/protocol.js";
import { UpdateStream, phaseWords } from "./update-stream.js";

const pulling = (overrides: Partial<UpdateProgress> = {}): UpdateProgress => ({
  phase: "pulling",
  layers: [
    { id: "4f4fb700ef54", state: "downloading", current: 50_000_000, total: 100_000_000 },
    { id: "1a2b3c4d5e6f", state: "waiting", current: 0, total: null },
  ],
  downloaded: 50_000_000,
  total: 100_000_000,
  bytesPerSecond: 10_000_000,
  log: [],
  ...overrides,
});

const facts = () =>
  within(screen.getByRole("region", { name: "How the update of jellyfin goes" }).querySelector("header")!)
    .getAllByText(/./)
    .map((element) => element.textContent);

describe("an update under its row", () => {
  afterEach(cleanup);

  it("says how far the pull is only once Docker said every layer's size, so the share never jumps back", () => {
    const sizesUnknown = pulling();
    expect(phaseWords(sizesUnknown)).toBe("pulling the new image");
    render(<UpdateStream name="jellyfin" image="jellyfin/jellyfin:10.11" progress={sizesUnknown} />);
    expect(facts()).toEqual([
      "pulling the new image",
      "jellyfin/jellyfin:10.11",
      "10 MB/s",
      "50 MB downloaded",
      "0 of 2 layers",
    ]);
  });

  it("tells the share and the time left once no layer waits, a small one done without a size left out", () => {
    const sized = pulling({
      layers: [
        { id: "4f4fb700ef54", state: "downloading", current: 50_000_000, total: 100_000_000 },
        { id: "1a2b3c4d5e6f", state: "downloaded", current: 0, total: null },
      ],
    });
    expect(phaseWords(sized)).toBe("pulling 50%");
    render(<UpdateStream name="jellyfin" image="jellyfin/jellyfin:10.11" progress={sized} />);
    expect(facts()).toEqual([
      "pulling the new image",
      "jellyfin/jellyfin:10.11",
      "10 MB/s",
      "50 MB of 100 MB",
      "5 seconds left",
      "0 of 2 layers",
    ]);
  });

  it("leaves out a speed while Docker sends nothing, and after the pull says what it brought", () => {
    const stalled = pulling({ bytesPerSecond: 0 });
    render(<UpdateStream name="jellyfin" image="jellyfin/jellyfin:10.11" progress={stalled} />);
    expect(facts()).not.toContain("0 B/s");
    cleanup();

    const stopping = pulling({
      phase: "stopping",
      layers: [
        { id: "4f4fb700ef54", state: "done", current: 100_000_000, total: 100_000_000 },
        { id: "1a2b3c4d5e6f", state: "done", current: 0, total: null },
      ],
      downloaded: 100_000_000,
    });
    expect(phaseWords(stopping)).toBe("stopping the old container");
    render(<UpdateStream name="jellyfin" image="jellyfin/jellyfin:10.11" progress={stopping} />);
    expect(facts()).toEqual([
      "stopping the old container",
      "jellyfin/jellyfin:10.11",
      "100 MB of 100 MB",
      "2 of 2 layers",
    ]);
  });

  it("turns red while the old container is put back", () => {
    render(<UpdateStream name="jellyfin" image="jellyfin/jellyfin:10.11" progress={pulling({ phase: "undoing" })} />);
    const region = screen.getByRole("region", { name: "How the update of jellyfin goes" });
    expect(region.className).toBe("update-stream undoing");
    expect(within(region).getByRole("status").textContent).toBe("putting the old one back");
  });
});
