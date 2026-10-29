import { expect, type Page } from "@playwright/test";
import type { RoutingSettings } from "../../src/model";

export async function waitForAppReady(page: Page) {
  // Dynamic entry modules and local restoration finish after the document load.
  // Use the test's startup budget and surface a real startup failure immediately.
  await page.waitForFunction(() => {
    if (document.body.hasAttribute("data-startup-error"))
      throw new Error("FoldRoute failed to start");
    return document.getElementById("app-startup")?.hidden === true;
  });
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
}

// Dispose the seed after the first document: reloads must read changes made by
// the app, including deleted preferences, rather than reinstalling defaults.
export async function openApp(page: Page, settings: RoutingSettings) {
  const seed = await page.addInitScript((value) => {
    localStorage.setItem("foldroute.routing.v3", JSON.stringify(value));
  }, settings);
  await page.goto("/");
  await seed.dispose();
  await waitForAppReady(page);
}

// Initialize IndexedDB on the app origin without starting the application twice.
export async function openStorageSeed(page: Page) {
  await page.route("**/__test-storage", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test storage</title>",
    }),
  );
  await page.goto("/__test-storage");
}
