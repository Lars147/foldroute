import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 2,
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    timezoneId: "Europe/Berlin",
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    },
    {
      command: "python3 -m http.server 4174 --bind 127.0.0.1 --directory ..",
      url: "http://127.0.0.1:4174/docs/plan/",
      reuseExistingServer: false,
    },
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      testMatch: "**/planner.spec.ts",
      use: { browserName: "webkit" },
    },
  ],
});
