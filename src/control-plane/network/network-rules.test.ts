import { describe, expect, it } from "vitest";
import { INTERNET_STATE, NETWORK_LIMITS } from "../../shared/network.js";
import { addedSince, flowInLine, internetStateOf, isDown, isFairTest, isUnusual, usualOf } from "./network-rules.js";

const DAY = 24 * 60 * 60 * 1000;
const UP = { wan: "WAN", up: true };
const DOWN = { wan: "WAN", up: false };
const SECOND_UP = { wan: "WAN2", up: true };

describe("network rules", () => {
  it("counts only what was added, through a counter restart", () => {
    expect(addedSince(undefined, 500)).toBe(0);
    expect(addedSince(100, 500)).toBe(400);
    expect(addedSince(500, 100)).toBe(0);
  });

  it.each([
    [true, [UP], true, INTERNET_STATE.up],
    [true, [DOWN], false, INTERNET_STATE.lineDown],
    [true, [UP], false, INTERNET_STATE.nothingGetsOut],
    [true, [DOWN, SECOND_UP], true, INTERNET_STATE.onSecondLine],
    [false, [], false, INTERNET_STATE.routerDown],
    [false, [], true, INTERNET_STATE.dashboardOnly],
  ])("router answers %s, lines %j, own check %s: %s", (answers, lines, works, state) => {
    expect(internetStateOf(answers, lines, works)).toBe(state);
  });

  it("does not hold the dashboard's own trouble against the internet", () => {
    expect(isDown(INTERNET_STATE.dashboardOnly)).toBe(false);
    expect(isDown(INTERNET_STATE.onSecondLine)).toBe(false);
    expect(isDown(INTERNET_STATE.lineDown)).toBe(true);
  });

  it("knows nothing is usual while it is still learning, then takes the median", () => {
    const at = 100 * DAY;
    expect(usualOf([1, 2, 3], at - DAY, at)).toBeNull();
    const old = at - (NETWORK_LIMITS.learningDays + 1) * DAY;
    expect(usualOf([], old, at)).toBeNull();
    expect(usualOf([9, undefined, 1, 5], old, at)).toBe(5);
  });

  it("calls use unusual only when well above usual and enough to matter", () => {
    const large = NETWORK_LIMITS.unusualBytes + 1;
    expect(isUnusual(large, null)).toBe(false);
    expect(isUnusual(large, large)).toBe(false);
    expect(isUnusual(large, 1)).toBe(true);
    expect(isUnusual(NETWORK_LIMITS.unusualBytes - 1, 1)).toBe(false);
  });

  it("does not count a test on a busy line against the provider", () => {
    expect(isFairTest(500, 1000)).toBe(false);
    expect(isFairTest(5, 1000)).toBe(true);
    expect(isFairTest(null, 1000)).toBe(true);
    expect(isFairTest(500, null)).toBe(true);
  });

  it("reads who talked to whom from both forms of log line", () => {
    expect(flowInLine("[LAN_IN-D-2000] IN=br0 SRC=192.0.2.1 DST=192.0.2.2 PROTO=TCP DPT=22")).toEqual({
      source: "192.0.2.1",
      destination: "192.0.2.2",
      port: 22,
      blocked: true,
    });
    expect(flowInLine("CEF:0|Ubiquiti|UniFi|1|1|x|3|src=192.0.2.1 dst=192.0.2.2 dpt=443 act=allow")).toEqual({
      source: "192.0.2.1",
      destination: "192.0.2.2",
      port: 443,
      blocked: false,
    });
    expect(flowInLine("a client disconnected")).toBeNull();
  });
});
