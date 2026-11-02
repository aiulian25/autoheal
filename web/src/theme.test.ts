import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, THEMES } from "./constants.js";
import { chooseTheme, chosenTheme } from "./theme.js";

// What index.html runs before the first paint: it must read what the account page writes.
const themeScript = readFileSync("web/public/theme.js", "utf8");
const runThemeScript = () => new Function(themeScript)();

describe("the theme", () => {
  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("follows the device until one is chosen", () => {
    expect(chosenTheme()).toBe(THEMES.device);
    runThemeScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("shows a chosen look at once, and theme.js applies it again on the next visit", () => {
    chooseTheme(THEMES.dark);
    expect(document.documentElement.dataset.theme).toBe(THEMES.dark);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(THEMES.dark);

    delete document.documentElement.dataset.theme;
    runThemeScript();
    expect(document.documentElement.dataset.theme).toBe(THEMES.dark);
    expect(chosenTheme()).toBe(THEMES.dark);
  });

  it("goes back to the device's own look, for this page and the next visit", () => {
    chooseTheme(THEMES.light);
    chooseTheme(THEMES.device);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    runThemeScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ignores anything else stored under its key", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(chosenTheme()).toBe(THEMES.device);
    runThemeScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
