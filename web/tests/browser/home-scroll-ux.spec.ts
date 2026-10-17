import { test, expect, type Page } from "@playwright/test";

async function populateHome(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const { PlaceBook } = await import("/src/places.ts");
    const { OfflineStore } = await import("/src/offline.ts");
    const { exampleRecording } = await import("/src/example-data.ts");
    const book = new PlaceBook();
    await book.change(
      {
        name: "Bergstraße 1",
        detail: "München",
        latitude: 48.13,
        longitude: 11.6,
      },
      "favorite",
    );
    await book.change(
      {
        name: "Letztes Ziel",
        detail: "München",
        latitude: 48.14,
        longitude: 11.6,
      },
      "use",
    );
    await new OfflineStore().save(
      {
        version: 3,
        savedAt: Date.now() / 1000,
        journey: exampleRecording.journey,
        request: exampleRecording.request,
        settings: exampleRecording.settings,
      },
      "home-cancel-test",
    );
  });
  await page.reload();
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    2,
  );
  await expect(page.locator("#open-saved")).toBeVisible();
}

for (const width of [390, 1280])
  test(`home list returns after cancelling adjustments by button, Escape and browser back at ${width}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let plans = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v6/plan")) plans++;
    });
    await populateHome(page);
    const list = page.locator("#destination-options");
    const summary = await page.locator("#saved-description").textContent();
    for (const close of ["button", "escape", "back"]) {
      if (close === "back")
        // Keep the preceding entry on the home screen to exercise popstate cleanup.
        await page.evaluate(() =>
          history.pushState(history.state, "", location.href),
        );
      await page.locator("#search-adjust").click();
      await expect(list).toBeHidden();
      if (close === "button") await page.locator("#cancel-adjust").click();
      else if (close === "escape") await page.keyboard.press("Escape");
      else await page.goBack();
      await expect(page.locator("#adjust-dialog")).not.toBeVisible();
      await expect(list).toBeVisible();
      await expect(list).toContainText("Favoriten");
      await expect(list).toContainText("Zuletzt verwendet");
      await expect(list.locator(".place-select strong")).toHaveText([
        "Bergstraße 1",
        "Letztes Ziel",
      ]);
      await expect(page.locator("#search-empty")).toBeHidden();
      await expect(page.locator("#saved-description")).toHaveText(summary!);
      await expect(page.locator("#open-saved")).toBeVisible();
      await expect(page.locator("#search-adjust")).toBeFocused();
      await expect(page.locator("#destination")).not.toBeFocused();
      await expect(page.locator(".search-focus-back")).toHaveCount(0);
      if (close === "button") await context.setOffline(true);
    }
    expect(plans).toBe(0);
  });

test("home cancellation preserves the query and discards adjustment drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await populateHome(page);
  await page.locator("#destination").fill("Berg");
  await page.locator(".search-focus-back").click();
  const context = await page.locator("#search-context").textContent();
  await page.locator("#search-adjust").click();
  await page.locator("#adjust-destination").fill("Verworfener Entwurf");
  await page.keyboard.press("Escape");
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#destination")).toHaveValue("Berg");
  await expect(page.locator("#destination-options")).toBeVisible();
  await expect(
    page.locator("#destination-options .place-select strong"),
  ).toHaveText(["Bergstraße 1"]);
  await expect(page.locator("#search-context")).toHaveText(context!);
  await expect(page.locator("#search-adjust")).toBeFocused();
  await page.locator("#search-adjust").click();
  await expect(page.locator("#adjust-destination")).toHaveValue("");
  await page.locator("#cancel-adjust").click();
});

test("home greeting remains visible after cancelling without saved places", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const close of ["button", "escape"]) {
    await page.locator("#search-adjust").click();
    if (close === "button") await page.locator("#cancel-adjust").click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("#adjust-dialog")).not.toBeVisible();
    await expect(page.locator("#search-empty")).toBeVisible();
    await expect(page.locator("#destination-options")).toBeHidden();
    await expect(page.locator("#search-adjust")).toBeFocused();
  }
});

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
      content: `:root { font-size: ${fontSize}px; --tabs: calc(max(64px, 4rem) + ${safeArea}px); }
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
