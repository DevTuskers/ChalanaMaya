/**
 * Server bundle: `vite build --ssr -c vite.server.config.ts` writes
 * dist-server/main.js (and the stdio bridge from phase 4). Dependencies stay
 * external and load from node_modules.
 */
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node20",
    sourcemap: true,
    rollupOptions: {
      input: { main: "server/main.ts", "db-smoke": "server/db/smokeCli.ts" },
      output: { format: "es", entryFileNames: "[name].js" },
    },
  },
});
