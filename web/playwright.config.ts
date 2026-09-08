import { defineConfig } from "@playwright/test";
const port = Number(process.env.FOLDROUTE_TEST_PORT ?? 4173);
export default defineConfig({
  testDir: "tests/browser",
  workers: 2,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
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
      testMatch: "**/planner.spec.ts",
      use: { browserName: "webkit" },
    },
  ],
});
