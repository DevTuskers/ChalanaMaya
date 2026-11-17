/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  preview: { port: 5184, strictPort: true },
  test: {
    // one project per runtime; the server project joins in phase 1b
    projects: [
      {
        extends: true,
        test: { name: "app", include: ["src/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
