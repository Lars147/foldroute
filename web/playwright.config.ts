import { defineConfig } from "@playwright/test";
const port = Number(process.env.FOLDROUTE_TEST_PORT ?? 4173);
const ci = !!process.env.CI;
export default defineConfig({
  testDir: "tests/browser",
  forbidOnly: ci,
  globalTimeout: ci ? 30 * 60 * 1000 : undefined,
  retries: ci ? 1 : 0,
  workers: ci ? 1 : 2,
  reporter: ci ? [["line"], ["html", { open: "never" }]] : undefined,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: ci ? "on-first-retry" : "off",
    timezoneId: "Europe/Berlin",
  },
  webServer: [
    {
      command: `npm run dev -- --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
    },
    {
      command: `python3 -m http.server ${port + 1} --bind 127.0.0.1 --directory ..`,
      url: `http://127.0.0.1:${port + 1}/docs/plan/`,
      reuseExistingServer: false,
    },
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      testMatch: [
        "**/planner.spec.ts",
        "**/*ux*.spec.ts",
        "**/ux-planning.spec.ts",
      ],
      use: { browserName: "webkit" },
    },
  ],
});
