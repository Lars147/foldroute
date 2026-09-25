import { test, expect } from "@playwright/test";

test("mobile search uses visual viewport and returns to the unchanged adjustment draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: [{ name: "Testziel", lat: 48.15, lon: 11.6 }],
    }),
  );
  await page.goto("/");
  await page.locator("#destination").fill("Test");
  await expect(page.locator(".search-focus-back")).toBeVisible();
  await page.evaluate(() => {
    // Model the visual area left above an on-screen keyboard without changing layout width.
    document.documentElement.style.setProperty("--visual-height", "380px");
    document.documentElement.style.setProperty("--visual-top", "35px");
  });
  await expect(
    page.locator("#destination-options .place-select"),
  ).toBeVisible();
  const field = await page.locator("#destination").boundingBox();
  const results = await page.locator("#destination-options").boundingBox();
  expect(field!.y).toBe(95);
  expect(results!.y + results!.height).toBeLessThanOrEqual(415);
  await page.screenshot({ path: "/tmp/foldroute-search-focus.png" });
  await page.locator(".search-focus-back").click();
  await expect(page.locator("#destination")).toHaveValue("Test");
  await expect(page.locator("#search-adjust")).toBeVisible();
  await page.locator("#search-adjust").click();
  await page.locator("#origin").fill("Test");
  await page.locator("#origin-options .place-select").click();
  await expect(page.locator(".search-focus-back")).toHaveCount(0);
  await expect(page.locator("#origin")).toHaveValue("Testziel");
  await expect(page.locator("#use-context")).toBeVisible();
  await page.locator("#adjust-destination").fill("Draft");
  await page.locator("#adjust-destination").press("Escape");
  await expect(page.locator("dialog[open]")).toBeVisible();
  await expect(page.locator("#adjust-destination")).toHaveValue("Draft");
});
