import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@urban/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@urban/models": fileURLToPath(
        new URL("./packages/models/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // Data preparation and generated report/browser artifacts must not reload
    // another user's active draft or interrupt an ongoing local workflow.
    watch: {
      ignored: [
        "**/public/data/**",
        "**/.local/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/dist/**",
      ],
    },
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/.local/**",
        "**/apps/api/**",
      ],
    },
    proxy: { "/api": "http://127.0.0.1:3001" },
  },
  build: { outDir: "dist/web", chunkSizeWarningLimit: 1700 },
});
