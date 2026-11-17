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
    // the built ChalanaMaya server (app, API, security layers) with a fresh data folder
    command:
      "npm run build && node -e \"require('fs').rmSync('test-results/e2e-data',{recursive:true,force:true})\" && node dist-server/main.js",
    env: { PORT: "5184", DATA_DIR: "test-results/e2e-data", RATE_LIMITS: "off" },
    url: "http://localhost:5184",
    reuseExistingServer: false,
    timeout: 180000,
  },
});
