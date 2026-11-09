import { STALE_BUILD } from "./constants.js";

type ReloadMemory = Pick<Storage, "getItem" | "setItem">;

const lastReload = (memory: () => ReloadMemory) => {
  try {
    return Number(memory().getItem(STALE_BUILD.storageKey) ?? 0);
  } catch {
    return 0;
  }
};

const noted = (memory: () => ReloadMemory, at: number) => {
  try {
    memory().setItem(STALE_BUILD.storageKey, String(at));
    return true;
  } catch {
    return false;
  }
};

/**
 * Pages load when first opened, by the names each build gives its files. A tab opened before an update asks for the
 * old build's, which are gone, and loads the new build in their place. Only once a minute, and only where this tab can
 * note that it did: a page missing from the new build too then shows as the error it is, not as a page reloading
 * itself.
 */
export function reloadIntoNewBuild(
  target: Pick<EventTarget, "addEventListener">,
  memory: () => ReloadMemory,
  reload: () => void,
  now: () => number = Date.now,
) {
  target.addEventListener(STALE_BUILD.event, (event) => {
    const at = now();
    const recently = at - lastReload(memory) < STALE_BUILD.reloadAtMostEveryMilliseconds;
    if (recently || !noted(memory, at)) {
      return;
    }
    event.preventDefault();
    reload();
  });
}
