import { expect, test, type Page } from "@playwright/test";
import { modes } from "../../src/model";
import { setup, choose, cors, fixture } from "./planner-fixture";
import { expectPlanningComplete, showMap } from "./assertions";

async function clock(page: Page) {
  await page.clock.install({ time: new Date("2026-09-04T08:00:00Z") });
}

test("place search429 appears immediately, counts down and never retries automatically", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await clock(page);
  let count = 0;
  await page.route("**/api/v1/geocode?*", (route) => {
    count++;
    return route.fulfill({ status: 429, headers: cors });
  });
  await page.locator("#destination").fill("Berlin");
  await expect(page.locator("#place-status")).toContainText(
    "Anfragelimit erreicht · 5 s",
  );
  await expect(page.locator("#place-status .retry-countdown")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.clock.runFor(2100);
  await expect(page.locator("#place-status")).toContainText(
    /Anfragelimit erreicht · [23] s/,
  );
  await page.clock.runFor(3000);
  await expect(page.locator("#place-status")).toHaveText(
    "Anfragelimit erreicht",
  );
  expect(count).toBe(1);
  await page.locator("#destination").fill("");
  await expect(page.locator("#place-status .retry-countdown")).toHaveCount(0);
});

test("first routing429 retries through real transport without flashing an error", async ({
  page,
}) => {
  await setup(page, true, {
    excludedTransitModes: Object.keys(modes) as (keyof typeof modes)[],
  });
  await clock(page);
  let count = 0;
  await page.route("**/api/v6/plan?*", (route) => {
    count++;
    return route.fulfill(
      count === 1
        ? { status: 429, headers: cors }
        : { json: fixture.direct, headers: cors },
    );
  });
  await choose(page, "destination", "Ziel");
  await expect.poll(() => count).toBe(1);
  await expect(page.locator("#search-preview-title")).toHaveText(
    "Verbindungen werden gesucht …",
  );
  await expect(page.locator("#search-preview")).not.toContainText(
    "Anfragelimit",
  );
  await page.clock.runFor(5100);
  await expectPlanningComplete(page);
  expect(count).toBe(2);
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator("#issues")).toBeEmpty();
});

test("terminal429 keeps parallel success usable with compact accessible countdown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true, { maxBikeTransfers: 0 });
  await clock(page);
  await page.addStyleTag({ content: "html { font-size: 22px; }" });
  let count = 0;
  await page.route("**/api/v6/plan?*", (route) => {
    count++;
    const direct =
      new URL(route.request().url()).searchParams.get("directModes") === "BIKE";
    return route.fulfill(
      direct
        ? { json: fixture.direct, headers: cors }
        : { status: 429, headers: { ...cors, "Retry-After": "30" } },
    );
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-search-status",
    "partial",
  );
  await expect(page.locator(".route-choice")).toHaveCount(1);
  const message = page.locator("#toast .planning-toast-message");
  await expect(message).toContainText("Anfragelimit erreicht ·");
  await expect(message.locator(".retry-countdown")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await expect(page.locator("#recover-planning")).toBeDisabled();
  await showMap(page);
  await expect(message).toContainText("Anfragelimit erreicht ·");
  const box = await page.locator("#toast").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const terminalRequests = count;
  await page.screenshot({
    path: test.info().outputPath("rate-limit-mobile.png"),
  });
  await page.clock.runFor(30100);
  await expect(message).toHaveText("Anfragelimit erreicht");
  await expect(page.locator("#recover-planning")).toBeEnabled();
  expect(count).toBe(terminalRequests);
});

test("failed refresh keeps countdown with the previous selected route", async ({
  page,
}) => {
  await setup(page, true, {
    excludedTransitModes: Object.keys(modes) as (keyof typeof modes)[],
  });
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await clock(page);
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({ status: 429, headers: { ...cors, "Retry-After": "30" } }),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText(
    "Anfragelimit erreicht ·",
  );
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator("#recover-planning")).toBeDisabled();
  await page.clock.runFor(30100);
  await expect(page.locator("#status")).toHaveText("Anfragelimit erreicht");
  await expect(page.locator("#recover-planning")).toBeEnabled();
});

test("X cancels pending429 retries", async ({ page }) => {
  await setup(page, true, {
    excludedTransitModes: Object.keys(modes) as (keyof typeof modes)[],
  });
  await clock(page);
  let count = 0;
  await page.route("**/api/v6/plan?*", (route) => {
    count++;
    return route.fulfill({ status: 429, headers: cors });
  });
  await choose(page, "destination", "Ziel");
  await expect.poll(() => count).toBe(1);
  await page.locator("#close-route").click();
  await expect(page.locator("#map-view")).toBeHidden();
  await page.clock.runFor(10000);
  expect(count).toBe(1);
  await expect(page.locator("#map-view")).toBeHidden();
});
