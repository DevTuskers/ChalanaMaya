/**
 * Server bundle: `vite build --ssr -c vite.server.config.ts` writes
 * dist-server/main.js (and the stdio bridge from phase 4). Dependencies stay
 * external and load from node_modules.
 */
import { chmodSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  plugins: [
    {
      // `chalanamaya-mcp` (package.json "bin") runs the bridge directly
      name: "stdio-executable",
      writeBundle(options) {
        chmodSync(path.join(options.dir ?? "dist-server", "stdio.js"), 0o755);
      },
    },
  ],
  build: {
    ssr: true,
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node20",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: "server/main.ts",
        stdio: "server/stdio.ts",
        "db-smoke": "server/db/smokeCli.ts",
      },
      output: { format: "es", entryFileNames: "[name].js" },
    },
  },
});
