import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5184",
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: "npm run build && npx vite preview --port 5184 --strictPort",
    url: "http://localhost:5184",
    reuseExistingServer: false,
    timeout: 180000,
  },
});
