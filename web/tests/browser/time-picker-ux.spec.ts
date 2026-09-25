import { test, expect } from "@playwright/test";

for (const width of [390, 1100])
  test(`calendar edits are isolated and keyboard accessible at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
    await page.goto("/");
    await page.locator("#search-adjust").click();
    await page.locator("#time-trigger").click();
    await expect(page.locator("#time-editor")).toBeVisible();
    await expect(page.locator("#route-form")).toBeHidden();
    await expect(page.locator("#time-clock")).toHaveValue("14:00");
    await expect(page.locator('[data-date="2026-09-21"]')).toBeDisabled();
    await page.locator('[data-date="2026-09-22"]').press("ArrowRight");
    await expect(page.locator('[data-date="2026-09-23"]')).toBeFocused();
    await page.locator('[data-date="2026-09-23"]').press("Enter");
    await page.locator("#time-arrive").click();
    await page.locator("#time-clock").fill("1830");
    await page.locator("#time-apply").click();
    await expect(page.locator("#time-summary")).toHaveText("Morgen, an 18:30");
    await expect(page.locator("#time-trigger")).toBeFocused();
    await page.locator("#time-trigger").click();
    await page.locator("#time-next").click();
    await expect(page.locator("#time-month")).toHaveText("Oktober 2026");
    await page.locator("#time-now").click();
    await page.locator("#time-cancel").press("Escape");
    await expect(page.locator("#adjust-dialog")).toBeVisible();
    await expect(page.locator("#time-summary")).toHaveText("Morgen, an 18:30");
    await page.locator("#time-trigger").click();
    await page.locator("#time-now").click();
    await page.screenshot({ path: info.outputPath("calendar.png") });
    await page.locator("#time-apply").click();
    await expect(page.locator("#timing")).toHaveValue("now");
    await expect(page.locator("#time-summary")).toHaveText("Jetzt");
  });

test("time validation, five minute midnight rollover and short keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").fill("13:59");
  await expect(page.locator("#time-apply")).toBeDisabled();
  await page.locator("#time-clock").fill("25:00");
  await expect(page.locator("#time-apply")).toBeDisabled();
  await page.locator("#time-clock").fill("23:58");
  await page.locator("#time-plus").click();
  await expect(page.locator("#time-clock")).toHaveValue("00:03");
  await expect(
    page.locator('[data-date="2026-09-23"]').locator(".."),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#time-apply")).toBeInViewport();
  await page.locator("#time-apply").click();
  await expect(page.locator("#when")).toHaveValue("2026-09-23T00:03");
});

test("now preview advances while fixed times expire and DST gaps are rejected", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-03-28T11:59:00Z") });
  await page.clock.pauseAt(new Date("2026-03-28T12:00:00Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await expect(page.locator("#time-clock")).toHaveValue("13:00");
  await page.clock.fastForward(60000);
  await expect(page.locator("#time-clock")).toHaveValue("13:01");
  await page.locator("#time-clock").fill("13:02");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.clock.fastForward(120000);
  await expect(page.locator("#time-apply")).toBeDisabled();
  await page.locator('[data-date="2026-03-29"]').click();
  await page.locator("#time-clock").fill("02:30");
  await expect(page.locator("#time-apply")).toBeDisabled();
  await page.locator("#time-clock").fill("03:30");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.locator("#time-cancel").click();
  await expect(page.locator("#timing")).toHaveValue("now");
});

test("now keeps current minute across midnight without rounding or lead", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-22T21:59:45Z") });
  await page.clock.pauseAt(new Date("2026-09-22T21:59:50Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await expect(page.locator("#time-clock")).toHaveValue("23:59");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.clock.fastForward(60000);
  await expect(page.locator("#time-clock")).toHaveValue("00:00");
  await page.locator("#time-apply").click();
  await expect(page.locator("#when")).toHaveValue("2026-09-23T00:00");
  await expect(page.locator("#timing")).toHaveValue("now");
  await expect(page.locator("#time-summary")).toHaveText("Jetzt");
});
