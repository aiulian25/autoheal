import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/support/temporary-root.ts"],
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
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
        },
      },
    ],
  },
});
