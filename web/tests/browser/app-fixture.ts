import { expect, type Page } from "@playwright/test";
import type { RoutingSettings } from "../../src/model";

// Dispose the seed after the first document: reloads must read changes made by
// the app, including deleted preferences, rather than reinstalling defaults.
export async function openApp(page: Page, settings: RoutingSettings) {
  const seed = await page.addInitScript((value) => {
    localStorage.setItem("foldroute.routing.v3", JSON.stringify(value));
  }, settings);
  await page.goto("/");
  await seed.dispose();
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
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
