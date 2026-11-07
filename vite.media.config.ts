import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/** Private offline renderer: no application environment, catalog or browser credentials. */
export default defineConfig({
  plugins: [react()],
  envDir: false,
  publicDir: false,
  define: { "import.meta.env.VITE_MAPTILER_KEY": "undefined" },
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
  build: {
    outDir: "dist/media-render",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: "media-render.html" },
    chunkSizeWarningLimit: 1700,
  },
});
