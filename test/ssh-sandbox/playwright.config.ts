import { defineConfig } from "@playwright/test";
import base from "../../playwright.config.js";

// The browser project for the SSH sandbox. Run it through run.sh, which gives it the sandbox's engine: this machine's
// own must never take it.
if (process.env.SSH_SANDBOX !== "1") {
  throw new Error("Run the SSH sandbox through test/ssh-sandbox/run.sh: it needs the sandbox's own Docker engine.");
}

export default defineConfig({
  ...base,
  testDir: ".",
  globalSetup: "../e2e/global-setup.ts",
  outputDir: "../../test-results/ssh-sandbox",
  projects: [{ name: "ssh-sandbox", use: { browserName: "chromium" } }],
});
