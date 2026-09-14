import { test, expect, type Locator } from "@playwright/test";
import { readRouteURL } from "../../src/route-url";

const planner =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;
const landing = new URL("../", planner).href;

async function documentBox(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      x: box.x + window.scrollX,
      y: box.y + window.scrollY,
      width: box.width,
      height: box.height,
    };
  });
}

test("mobile journey details follow their trigger and retain selection on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(landing);
  await expect(page.locator(".guidance:visible")).toHaveCount(1);
  const trigger = page.getByRole("button", { name: "Falten & einsteigen" });
  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const details = page.getByRole("region", { name: "Falten & einsteigen" });
  await expect(details).toBeVisible();
  await expect(page.locator(".guidance:visible")).toHaveCount(1);
  await expect(trigger).toBeFocused();
  const buttonBox = await documentBox(trigger);
  const detailBox = await documentBox(details);
  expect(detailBox.y - buttonBox.y - buttonBox.height).toBeGreaterThanOrEqual(0);
  expect(detailBox.y - buttonBox.y - buttonBox.height).toBeLessThanOrEqual(12);
  const following = await documentBox(page.getByRole("button", { name: "Mit der Bahn weiter" }));
  expect(following.y).toBeGreaterThanOrEqual(detailBox.y + detailBox.height);
  await page.locator("#reise").screenshot({ path: test.info().outputPath("journey-mobile.png") });

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const desktopButton = await documentBox(trigger);
  const desktopDetails = await documentBox(details);
  expect(desktopDetails.x).toBeGreaterThan(desktopButton.x + desktopButton.width);
  await page.locator("#reise").screenshot({ path: test.info().outputPath("journey-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details).toBeVisible();
  await trigger.press("Space");
  await expect(page.locator(".guidance:visible")).toHaveCount(1);
});

test("mobile comparison changes routes in a fixed map viewport and desktop shows both", async ({ page }) => {
  for (const width of [320, 390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(landing);
    await expect(page.locator("#comparison-foldroute")).toBeVisible();
    await expect(page.locator("#comparison-classic")).toBeHidden();
    const before = await documentBox(page.locator("#comparison-foldroute .comparison-map"));
    await page.getByRole("button", { name: "Ohne Radetappe", exact: true }).click();
    await expect(page.locator("#comparison-foldroute")).toBeHidden();
    const after = await documentBox(page.locator("#comparison-classic .comparison-map"));
    for (const dimension of ["x", "y", "width", "height"] as const)
      expect(Math.abs(before[dimension] - after[dimension])).toBeLessThanOrEqual(1);
    const note = await documentBox(page.locator(".comparison-note"));
    expect(note.y + note.height).toBeLessThan(after.y);
    await page.getByRole("button", { name: "Mit Faltrad", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#comparison-foldroute")).toBeVisible();
    await page.locator("#idee").screenshot({ path: test.info().outputPath(`comparison-${width}.png`) });
  }
  await page.locator("#idee").screenshot({ path: test.info().outputPath("comparison-mobile.png") });
  await page.setViewportSize({ width: 761, height: 900 });
  await expect(page.locator(".comparison-option:visible")).toHaveCount(2);
  await expect(page.locator(".comparison-controls")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#comparison-foldroute")).toBeVisible();
});

test("landing remains readable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(landing);
  await expect(page.locator(".guidance:visible")).toHaveCount(4);
  await expect(page.locator(".comparison-option:visible")).toHaveCount(2);
  await expect(page.locator(".comparison-controls")).toBeHidden();
  await expect(page.getByRole("link", { name: "Route online planen", exact: true })).toBeVisible();
  await context.close();
});

test("landing provides complete setup links and a valid public example with departure now", async ({ page }) => {
  await page.goto(landing);
  await expect(page.getByRole("link", { name: "Prototyp selbst bauen", exact: true })).toHaveAttribute(
    "href", "https://github.com/Lars147/foldroute/blob/main/ios/README.md",
  );
  await page.getByText("Wie kann ich den iPhone-Prototyp selbst bauen?", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Quellcode als ZIP", exact: true })).toHaveAttribute(
    "href", "https://github.com/Lars147/foldroute/archive/refs/heads/main.zip",
  );
  await expect(page.getByRole("link", { name: "So installierst du ihn.", exact: true })).toHaveAttribute(
    "href", "plan/hilfe.html#installation",
  );
  const href = await page.locator("#example-route").getAttribute("href");
  const url = new URL(href!, landing);
  expect(url.pathname).toBe(new URL(planner).pathname);
  const parsed = readRouteURL(url);
  expect(parsed.kind).toBe("plan");
  if (parsed.kind !== "plan") throw new Error("Example route must parse");
  expect(parsed.plan.request).toMatchObject({
    timing: "now",
    origin: { latitude: 48.150097, longitude: 11.461955 },
    destination: { latitude: 48.128056, longitude: 11.603646 },
  });
});

test("landing supports narrow screens with doubled text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(landing);
  await page.evaluate(() => {
    const text = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,p,button,a,summary,dt,dd,small,strong,span")]
      .filter((element) => !element.closest("svg"))
      .map((element) => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
    for (const { element, size } of text) element.style.fontSize = `${size * 2}px`;
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Mit der Bahn weiter" }).click();
  await expect(page.getByRole("region", { name: "Mit der Bahn weiter" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.locator("#reise").screenshot({ path: test.info().outputPath("journey-large-text.png") });
  const before = await documentBox(page.locator("#comparison-foldroute .comparison-map"));
  await page.getByRole("button", { name: "Ohne Radetappe", exact: true }).click();
  const after = await documentBox(page.locator("#comparison-classic .comparison-map"));
  expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(1);
  await page.locator("#idee").screenshot({ path: test.info().outputPath("comparison-large-text.png") });
});
