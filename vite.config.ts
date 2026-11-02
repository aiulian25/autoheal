import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const DEVELOPMENT_CONTROL_PLANE = "https://localhost:8443";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // Everything ships as files: the CSP allows no inline script, style or data: script.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: { "/api": { target: DEVELOPMENT_CONTROL_PLANE, secure: false } },
  },
});
