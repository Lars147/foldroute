import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const fixture = JSON.parse(
  await readFile(new URL("../tests/fixtures/swift-parity.json", import.meta.url), "utf8"),
);
const planner = new URL(process.argv[2] ?? "http://127.0.0.1:4173/");
planner.search = new URLSearchParams({
  v: "3",
  from: "48.132,11.5756",
  fromName: "Start",
  to: "48.175,11.6",
  toName: "Ziel",
  timing: "now",
}).toString();

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    timezoneId: "Europe/Berlin",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  await page.route("https://tile.openstreetmap.org/**", route => route.abort());
  await page.route("**/api/v6/plan?*", route => route.fulfill({
    headers: { "Access-Control-Allow-Origin": "*" },
    json: new URL(route.request().url()).searchParams.get("directModes") === "BIKE"
      ? fixture.direct : fixture.multimodal,
  }));
  await page.goto(planner.href);
  await expect(page.locator(".route-choice").first()).toBeVisible();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#status")).toBeEmpty();
  await page.locator(".route-choice").filter({ hasText: "U6" }).first().click();
  await page.evaluate(() => document.fonts.ready);
  const output = new URL("../../docs/assets/webplaner-vorschau.png", import.meta.url);
  await page.screenshot({ path: output.pathname, animations: "disabled" });
  console.log(`Screenshot saved to ${output.pathname}`);
} finally {
  await browser.close();
}
