import {
  addStop,
  expectMotionSettled,
  openRecordedRouteEditor,
} from "./assertions";
import { test, expect } from "./test";

const cafes = [
  {
    name: "sweet spot kaffee",
    type: "PLACE",
    lat: 48.1357968,
    lon: 11.5776163,
    zip: "80331",
    country: "DE",
    areas: [
      { name: "München", unique: true, adminLevel: 6 },
      { name: "Altstadt-Lehel", unique: false, adminLevel: 9 },
    ],
  },
  {
    name: "sweet spot kaffee",
    type: "PLACE",
    lat: 48.129031,
    lon: 11.5755194,
    zip: "80469",
    country: "DE",
    areas: [
      { name: "München", unique: true, adminLevel: 6 },
      { name: "Ludwigsvorstadt-Isarvorstadt", unique: false, adminLevel: 9 },
    ],
  },
];
const cors = { "Access-Control-Allow-Origin": "*" };

for (const width of [320, 1280])
  for (const code of [1, 2, 3])
    test(`location failures stay compact and link to help at ${width}px: ${code}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: code === 1 ? "dark" : "light" });
      await page.addInitScript((code) => {
        Object.defineProperty(navigator, "geolocation", {
          configurable: true,
          value: {
            getCurrentPosition(
              _success: PositionCallback,
              fail: PositionErrorCallback,
            ) {
              fail({
                code,
                message: "Technical browser diagnostic",
              } as GeolocationPositionError);
            },
          },
        });
      }, code);
      await page.route("**/api/v1/geocode?*", (route) =>
        route.fulfill({
          headers: cors,
          json: [{ name: "Manueller Start", lat: 48.15, lon: 11.6 }],
        }),
      );
      await page.goto("/");
      await page.locator("#search-adjust").click();
      const input = page.locator("#origin");
      const current = page.locator("#origin-options").getByRole("button", {
        name: "Ort auswählen: Aktueller Standort",
        exact: true,
      });
      await input.click();
      await current.click();
      const status = page.locator("#adjust-status");
      const expected = [
        "",
        "Standortzugriff nicht erlaubt.",
        "Standort nicht verfügbar.",
        "Standortabfrage dauert zu lange.",
      ][code];
      await expect(status).toHaveText(`${expected} Hilfe zum Standort`);
      const help = status.getByRole("link", { name: "Hilfe zum Standort" });
      await expect(help).toBeVisible();
      await expect(help).toHaveAttribute("href", "hilfe.html#standort");
      const helpBounds = (await help.boundingBox())!;
      expect(helpBounds.x).toBeGreaterThanOrEqual(0);
      expect(helpBounds.x + helpBounds.width).toBeLessThanOrEqual(width);
      await help.focus();
      await expect(help).toBeFocused();
      await page.screenshot({ path: info.outputPath("location-help.png") });
      await input.fill("Manueller Start");
      await page
        .locator("#origin-options")
        .getByRole("button", { name: /^Ort auswählen: Manueller Start/ })
        .click();
      await expect(input).toHaveValue("Manueller Start");
      await expect(help).toBeHidden();
      await input.click();
      await current.click();
      await expect(help).toBeVisible();
      await help.click();
      await expect(page).toHaveURL(/hilfe\.html#standort$/);
      await expect(page.locator("#standort-heading")).toBeInViewport();
    });

for (const width of [320, 390, 1280])
  test(`districts distinguish equal place names and wrap without hiding controls at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/v1/geocode?*", (route) =>
      route.fulfill({ headers: cors, json: cafes }),
    );
    await page.goto("/");
    if (width === 320)
      await page.addStyleTag({ content: "html { font-size: 24px; }" });
    await page.locator("#destination").fill("sweet");
    const results = page.locator("#destination-options .place-select");
    await expect(results).toHaveCount(2);
    await expect(results.locator("strong")).toHaveText([
      "sweet spot kaffee",
      "sweet spot kaffee",
    ]);
    await expect(results.locator("small")).toHaveText([
      "80331, München, Altstadt-Lehel, DE",
      "80469, München, Ludwigsvorstadt-Isarvorstadt, DE",
    ]);
    for (const row of await page
      .locator("#destination-options li")
      .filter({ has: page.locator(".place-select") })
      .all()) {
      expect(
        await row.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      for (const action of [".place-favorite", ".place-prefill"]) {
        const button = row.locator(action);
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        const bounds = (await button.boundingBox())!;
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
    }
    await page.screenshot({ path: info.outputPath("district-results.png") });
  });

test("district details are shared by origin, destination and stop searches", async ({
  page,
}) => {
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({ headers: cors, json: cafes }),
  );
  await page.goto("/");
  await openRecordedRouteEditor(page);
  for (const id of ["origin", "destination", "via-0"]) {
    if (id === "via-0") await addStop(page);
    await page.locator(`#${id}`).fill("sweet");
    const results = page.locator(`#${id}-options .place-select`);
    await expect(results).toHaveCount(2);
    await expect(results.last()).toHaveAccessibleName(
      /Ludwigsvorstadt-Isarvorstadt/,
    );
    await results.last().click();
    await expect(page.locator(`#${id}`)).toHaveValue("sweet spot kaffee");
  }
});

test("fresh district details enrich a favorite without moving focus or writing until selection, then remain offline", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  let searches = 0;
  await page.route("**/api/v1/geocode?*", async (route) => {
    searches++;
    await pending;
    await route.fulfill({ headers: cors, json: cafes });
  });
  await page.goto("/");
  const legacy = {
    name: cafes[0].name,
    detail: "80331, München, DE",
    latitude: cafes[0].lat,
    longitude: cafes[0].lon,
  };
  await page.evaluate(async (place) => {
    const path = "/src/places.ts";
    const { PlaceBook } = await import(path);
    await new PlaceBook().change(place, "favorite");
  }, legacy);
  await page.reload();
  const storedFavorite = () =>
    page.evaluate(async () => {
      const path = "/src/places.ts";
      const { PlaceBook } = await import(path);
      const book = new PlaceBook();
      await book.load();
      return book.favorites[0]?.place;
    });
  const query = page.waitForRequest("**/api/v1/geocode?*");
  await page.locator("#destination").fill("sweet");
  await query;
  const favorite = page.locator("#destination-options .place-select").first();
  await expect(favorite.locator("small")).toHaveText(legacy.detail);
  await favorite.focus();
  release();
  await expect(favorite.locator("small")).toHaveText(
    "80331, München, Altstadt-Lehel, DE",
  );
  await expect(favorite).toBeFocused();
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    2,
  );
  expect(await storedFavorite()).toEqual(legacy);
  await page.locator(".search-focus-back").click();
  await page.locator("#search-adjust").click();
  await page.locator("#origin").fill("sweet");
  const enriched = page
    .locator("#origin-options .place-select")
    .filter({ hasText: "Altstadt-Lehel" });
  await expect(enriched).toBeVisible();
  await enriched.click();
  await expect
    .poll(storedFavorite)
    .toEqual({ ...legacy, detail: "80331, München, Altstadt-Lehel, DE" });
  await page.locator("#search-adjust").click();
  await page.reload();
  await expect(page.locator("#destination")).toBeVisible();
  await context.setOffline(true);
  const count = searches;
  await page.locator("#destination").fill("Altstadt");
  const offline = page.locator("#destination-options .place-select");
  await expect(offline).toHaveCount(1);
  await expect(offline.locator("small")).toHaveText(
    "80331, München, Altstadt-Lehel, DE",
  );
  await expect(
    page.locator("#destination-options .place-favorite"),
  ).toHaveAttribute("aria-pressed", "true");
  expect(searches).toBe(count);
  await page.screenshot({
    path: info.outputPath("district-favorite-offline.png"),
  });
});

for (const width of [320, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`mobile dialog search fills the viewport at ${width}px in ${colorScheme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      await page.route("**/api/v1/geocode?*", (route) =>
        route.fulfill({
          headers: cors,
          json: [{ name: "Testziel", lat: 48.15, lon: 11.6 }],
        }),
      );
      await page.goto("/");
      await openRecordedRouteEditor(page);
      const dialog = page.locator(".route-editor-places");
      for (const id of ["origin", "destination", "via-0"]) {
        if (id === "via-0") await addStop(page);
        const input = page.locator(`#${id}`);
        await input.fill("Test");
        await expect(
          page.locator(`#${id}-options .place-select`).last(),
        ).toBeVisible();
        await expect(input).toBeFocused();
        await expect(input).toHaveCSS("outline-style", "solid");
        await expectMotionSettled(page.locator(`#${id}-options`));
        const bounds = (await input.boundingBox())!;
        expect(bounds.x).toBe(12);
        expect(bounds.y).toBe(60);
        expect(bounds.width).toBe(width - 24);
        const results = (await page.locator(`#${id}-options`).boundingBox())!;
        expect(results.y).toBe(150);
        expect(results.y + results.height).toBeLessThanOrEqual(844);
        await expect(page.locator(".search-focus-back")).toBeVisible();
        await page.screenshot({ path: info.outputPath(`search-${id}.png`) });
        await page.locator(".search-focus-back").click();
        await expect(input).toHaveValue("Test");
        await expect(dialog).toHaveCSS("border-radius", "16px");
        await expect(page.locator("#calculate")).toBeVisible();
      }
    });
  }
}

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
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 380,
    });
    Object.defineProperty(window.visualViewport, "offsetTop", {
      configurable: true,
      value: 35,
    });
    window.visualViewport!.dispatchEvent(new Event("resize"));
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
  await expect(page.locator("#search-adjust")).toBeVisible();
  await page.locator("#origin").fill("Draft");
  await page.locator("#origin").press("Escape");
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#origin")).toHaveValue("Draft");
});
