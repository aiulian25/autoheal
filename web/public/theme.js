// Applies the theme chosen on the account page before the page paints; without a choice, the device decides.
// The key and the values are THEME_STORAGE_KEY and THEMES in src/constants.ts (a test keeps them equal).
try {
  const theme = window.localStorage.getItem("autoheal-theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // Storage can be off (a private window): the device's setting applies.
}
