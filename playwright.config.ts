import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A fresh database per run keeps acceptance tests away from the user's data.
const databaseUrl = `file:${join(tmpdir(), `windscope-browser-${process.pid}-${Date.now()}.db`)}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4317",
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "edge-desktop",
      testIgnore: [/cross-engine\.spec\.ts/, /mobile-engine\.spec\.ts/],
      use: {
        ...devices["Desktop Edge"],
        channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined),
        viewport: { width: 1440, height: 1080 }
      }
    },
    {
      name: "firefox-desktop",
      testMatch: /cross-engine\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] }
    },
    {
      name: "webkit-desktop",
      testMatch: /cross-engine\.spec\.ts/,
      use: { ...devices["Desktop Safari"] }
    },
    {
      name: "edge-mobile",
      testMatch: /mobile-engine\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined)
      }
    },
    {
      name: "webkit-mobile",
      testMatch: /mobile-engine\.spec\.ts/,
      use: { ...devices["iPhone 15"] }
    }
  ],
  webServer: [
    {
      command: "npm run db:setup && npm run dev:api",
      url: "http://127.0.0.1:4311/api/health",
      env: { API_PORT: "4311", DATABASE_URL: databaseUrl },
      reuseExistingServer: false
    },
    {
      command: "npm run dev:web -- --port 4317",
      url: "http://127.0.0.1:4317",
      env: { API_PORT: "4311" },
      reuseExistingServer: false
    }
  ]
});
