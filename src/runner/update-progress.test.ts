import { describe, expect, it } from "vitest";
import type { UpdateProgress } from "../shared/protocol.js";
import { UpdateReport } from "./update-progress.js";

// A report on a clock the test moves, keeping what it sent.
function reportOn() {
  let now = 0;
  const sent: UpdateProgress[] = [];
  const report = new UpdateReport(
    (progress) => sent.push(progress),
    () => now,
  );
  return { report, sent, at: (milliseconds: number) => (now = milliseconds) };
}

describe("UpdateReport", () => {
  it("sends a new step at once, and a pull's lines at most every half second", () => {
    const { report, sent, at } = reportOn();
    report.enter("pulling");
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 10, total: 100 } });
    at(499);
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 20, total: 100 } });
    expect(sent).toHaveLength(1);

    at(500);
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 30, total: 100 } });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.layers).toEqual([{ id: "a1", state: "downloading", current: 30, total: 100 }]);

    report.enter("stopping");
    expect(sent.at(-1)!.phase).toBe("stopping");
  });

  it("counts what came down and how much there is, leaving out the layers the host already had", () => {
    const { report, sent, at } = reportOn();
    report.pulled({ id: "here", status: "Already exists" });
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 40, total: 100 } });
    report.pulled({ id: "b2", status: "Downloading", progressDetail: { current: 50, total: 300 } });
    report.pulled({ id: "c3", status: "Waiting" });
    at(1_000);
    report.pulled({ id: "a1", status: "Download complete" });
    const last = sent.at(-1)!;
    expect(last.layers.map((layer) => layer.state)).toEqual(["present", "downloaded", "downloading", "waiting"]);
    expect(last.downloaded).toBe(150);
    expect(last.total).toBe(400);
  });

  it("keeps a layer's size from its download through the lines after it that leave it out", () => {
    const { report, sent, at } = reportOn();
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 40, total: 100 } });
    at(500);
    report.pulled({ id: "a1", status: "Extracting", progressDetail: { current: 10 } });
    at(1_000);
    report.pulled({ id: "a1", status: "Pull complete" });
    expect(sent[1]!.layers[0]).toEqual({ id: "a1", state: "extracting", current: 10, total: 100 });
    expect(sent[2]!.layers[0]).toEqual({ id: "a1", state: "done", current: 100, total: 100 });
    expect(sent[2]!.downloaded).toBe(100);
  });

  it("counts every layer in place once the pull returned, though Docker's last line for one said only downloaded", () => {
    const { report, sent } = reportOn();
    report.enter("pulling");
    report.pulled({ id: "here", status: "Already exists" });
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 40, total: 100 } });
    report.pulled({ id: "a1", status: "Pull complete" });
    report.pulled({ id: "c0", status: "Download complete" });
    report.enter("stopping");
    expect(sent.at(-1)!.layers).toEqual([
      { id: "here", state: "present", current: 0, total: null },
      { id: "a1", state: "done", current: 100, total: 100 },
      { id: "c0", state: "done", current: 0, total: null },
    ]);
  });

  it("measures the speed over the last few seconds, once there are two readings", () => {
    const { report, sent, at } = reportOn();
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 0, total: 10_000 } });
    expect(sent[0]!.bytesPerSecond).toBeNull();
    at(1_000);
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 2_000, total: 10_000 } });
    expect(sent[1]!.bytesPerSecond).toBe(2_000);
    at(5_000);
    report.pulled({ id: "a1", status: "Downloading", progressDetail: { current: 4_000, total: 10_000 } });
    // The reading from 4 s ago is past the window: what remains are the last few seconds alone.
    expect(sent[2]!.bytesPerSecond).toBeNull();
  });

  it("keeps Docker's latest line for each layer, the newest last, and only the last few", () => {
    const { report, sent } = reportOn();
    for (let index = 0; index < 15; index += 1) {
      report.pulled({ id: `l${index}`, status: "Waiting" });
    }
    report.pulled({ id: "l0", status: "Downloading", progress: "[=>   ] 1MB/9MB" });
    report.enter("pulling");
    const log = sent.at(-1)!.log;
    expect(log).toHaveLength(12);
    expect(log.at(-1)).toBe("l0: Downloading [=>   ] 1MB/9MB");
    expect(log[0]).toBe("l4: Waiting");
  });
});
