import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Before each test file: names tests make up are answered on this machine, never asked of the network's DNS.
const MADE_UP_NAMES = "test/support/made-up-names.ts";

export default defineConfig({
  test: {
    globalSetup: ["test/support/temporary-root.ts"],
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          setupFiles: [MADE_UP_NAMES],
          // Sign-ins hash with Argon2id and backups are encrypted: a test that takes a second and a half on its own
          // took seven and a half while every file ran at once.
          testTimeout: 20_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["web/**/*.test.{ts,tsx}"],
          setupFiles: [MADE_UP_NAMES, "web/test-setup.ts"],
        },
      },
    ],
  },
});
