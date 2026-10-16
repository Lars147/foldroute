import { test, expect } from "@playwright/test";

const layouts = [
  { width: 320, height: 568, fontSize: 16, safeArea: 0 },
  { width: 320, height: 568, fontSize: 24, safeArea: 0 },
  { width: 390, height: 844, fontSize: 16, safeArea: 0 },
  { width: 390, height: 844, fontSize: 16, safeArea: 34 },
  { width: 430, height: 932, fontSize: 32, safeArea: 0 },
  { width: 844, height: 390, fontSize: 16, safeArea: 0 },
  { width: 1280, height: 900, fontSize: 16, safeArea: 0 },
];

for (const { width, height, fontSize, safeArea } of layouts) {
  test(`home list clears the tabs with pinned controls at ${width}x${height}, ${fontSize}px text and ${safeArea}px safe area`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await page.evaluate(async () => {
      const path = "/src/places.ts";
      const { PlaceBook } = await import(path);
      const book = new PlaceBook();
      for (let index = 0; index < 15; index++) {
        await book.change(
          {
            name:
              index < 10
                ? `Favorit ${String(index + 1).padStart(2, "0")} – Daglfinger Straße`
                : `San Shine Camp ${index - 9}`,
            detail: "81929, München, Bogenhausen, DE",
            latitude: 48.13 + index * 0.002,
            longitude: 11.6,
          },
          index < 10 ? "favorite" : "use",
        );
      }
    });
    await page.reload();
    await page.addStyleTag({
      content: `html { font-size: ${fontSize}px; --tabs: ${64 + safeArea}px; }
        .app-tabs { padding-bottom: ${safeArea}px; }`,
    });
    const rows = page
      .locator("#destination-options li[role=row]")
      .filter({ has: page.locator(".place-select") });
    await expect(rows).toHaveCount(15);
    const field = page.locator(".search-box");
    const context = page.locator("#search-adjust");
    const tabs = page.locator(".app-tabs");
    const before = await Promise.all(
      [field, context, tabs].map((element) => element.boundingBox()),
    );
    const content = page.locator(".search-content");
    expect(
      await content.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    const bounds = (await content.boundingBox())!;
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await page.mouse.wheel(0, 10000);
    await expect
      .poll(() =>
        content.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);

    const last = rows.last();
    const rowBounds = (await last.boundingBox())!;
    expect(rowBounds.y).toBeGreaterThanOrEqual(bounds.y);
    expect(rowBounds.y + rowBounds.height).toBeLessThanOrEqual(
      before[2]!.y - 12,
    );
    expect(
      await Promise.all(
        [field, context, tabs].map((element) => element.boundingBox()),
      ),
    ).toEqual(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator("#destination-options")
        .evaluate((element) => element.scrollHeight <= element.clientHeight),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("home-list-bottom.png") });

    const name = (await last.locator("strong").textContent())!;
    await last.locator(".place-favorite").click();
    await expect(
      page
        .locator("#destination-options li[role=row]")
        .filter({ has: page.getByRole("button", { name: new RegExp(name) }) })
        .locator(".place-favorite"),
    ).toHaveAttribute("aria-pressed", "true");
  });
}

test("empty home content remains reachable on a short screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  const field = (await page.locator(".search-box").boundingBox())!;
  const context = (await page.locator("#search-adjust").boundingBox())!;
  const content = page.locator(".search-content");
  await content.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const text = (await page.locator("#search-empty p").boundingBox())!;
  const tabs = (await page.locator(".app-tabs").boundingBox())!;
  expect(text.y + text.height).toBeLessThanOrEqual(tabs.y - 12);
  expect(await page.locator(".search-box").boundingBox()).toEqual(field);
  expect(await page.locator("#search-adjust").boundingBox()).toEqual(context);
});
