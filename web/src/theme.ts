import { THEME_STORAGE_KEY, THEMES, type Theme } from "./constants.js";

const isPinned = (value: string | null): value is Exclude<Theme, typeof THEMES.device> =>
  value === THEMES.light || value === THEMES.dark;

/** The look pinned in this browser, or the device's own when none is (or storage is off). */
export function chosenTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPinned(stored) ? stored : THEMES.device;
  } catch {
    return THEMES.device;
  }
}

/** Shows the chosen look at once, and keeps it for theme.js to apply on the next visit. */
export function chooseTheme(theme: Theme) {
  const root = document.documentElement;
  const pinned = isPinned(theme);
  if (pinned) {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
  try {
    if (pinned) {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } else {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    }
  } catch {
    // Storage can be off (a private window): the look then holds until the page reloads.
  }
}
