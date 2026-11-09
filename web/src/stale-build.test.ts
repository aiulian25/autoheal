import { describe, expect, it, vi } from "vitest";
import { STALE_BUILD } from "./constants.js";
import { reloadIntoNewBuild } from "./stale-build.js";

const failedLoad = () => new Event(STALE_BUILD.event, { cancelable: true });

describe("a tab opened before an update", () => {
  it("loads the new build when a page's file is gone, once a minute at most", () => {
    const target = new EventTarget();
    const stored = new Map<string, string>();
    const memory = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    const reload = vi.fn();
    let now = 1_000_000;
    reloadIntoNewBuild(
      target,
      () => memory,
      reload,
      () => now,
    );

    const first = failedLoad();
    target.dispatchEvent(first);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);

    // Missing from the new build too: the error shows, the tab does not reload itself again and again.
    now += STALE_BUILD.reloadAtMostEveryMilliseconds - 1;
    const again = failedLoad();
    target.dispatchEvent(again);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(again.defaultPrevented).toBe(false);

    now += 1;
    target.dispatchEvent(failedLoad());
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("shows the error where it cannot note that it reloaded, so it can never loop", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    reloadIntoNewBuild(
      target,
      () => {
        throw new DOMException("Storage is off", "SecurityError");
      },
      reload,
    );
    const event = failedLoad();
    target.dispatchEvent(event);
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
