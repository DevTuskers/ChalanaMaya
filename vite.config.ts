/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  preview: { port: 5184, strictPort: true },
  test: {
    // one project per runtime
    projects: [
      {
        extends: true,
        test: { name: "app", include: ["src/**/*.test.ts"], environment: "node" },
      },
      {
        // forks: better-sqlite3 is a native module
        test: {
          name: "server",
          include: ["server/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 30_000,
        },
      },
      {
        // The Worker + Durable Object layer, over the real-SQLite test shims
        // (worker/test/*). `cloudflare:workers` is aliased to a tiny stub.
        extends: true,
        test: {
          name: "worker",
          include: ["worker/**/*.test.ts"],
          environment: "node",
          pool: "forks",
          testTimeout: 30_000,
        },
        resolve: {
          alias: {
            "cloudflare:workers": path.resolve(__dirname, "worker/test/cloudflare-workers.stub.ts"),
          },
        },
      },
    ],
  },
});
