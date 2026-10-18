import { test, expect, type Page } from "@playwright/test";
import {
  expectMotionSettled,
  expectSelectedJourneySaved,
  openCachedJourney,
} from "./assertions";
import { setup, plan } from "./planner-fixture";

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

for (const width of [390, 1280]) {
  test(`closing fresh and saved routes restores home and its suggestions at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await setup(page);
    await populateHome(page);
    await page.clock.setFixedTime(new Date("2026-09-04T08:00:01Z"));
    let plans = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v6/plan")) plans++;
    });
    const input = page.locator("#destination");
    const list = page.locator("#destination-options");
    for (const source of ["fresh", "saved"]) {
      if (source === "fresh") {
        await plan(page);
        await expectSelectedJourneySaved(page);
      } else await openCachedJourney(page, page.locator("#open-saved"));
      const beforeClose = plans;
      const summary = await page.locator("#saved-description").textContent();
      await page.locator("#close-route").click();
      await expect(page.locator("#search-view")).toBeVisible();
      await expect(page.locator("#map-view")).toBeHidden();
      await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
      await expect(input).toHaveValue("");
      await expect(list).toBeVisible();
      await expect(list).toContainText("Favoriten");
      await expect(list).toContainText("Zuletzt verwendet");
      await expect(
        page.locator(width < 900 ? "#search-heading" : "#destination"),
      ).toBeFocused();
      await expectMotionSettled(page.locator(".search-content"));
      await page.screenshot({
        path: test.info().outputPath(`home-after-${source}-route.png`),
      });
      for (const close of width < 900
        ? ["back", "input-escape", "list-escape"]
        : ["input-escape", "list-escape"]) {
        await input.click();
        if (close === "back") await page.locator(".search-focus-back").click();
        else if (close === "list-escape") {
          const option = list.locator(".place-select").first();
          await option.focus();
          await option.press("Escape");
        } else await input.press("Escape");
        await expect(list).toBeVisible();
        await expect(list).toContainText("Favoriten");
        await expect(list).toContainText("Zuletzt verwendet");
        await expect(list.locator(".place-select strong")).toHaveText([
          "Bergstraße 1",
          "Ziel",
          "Letztes Ziel",
        ]);
        await expect(page.locator("#search-empty")).toBeHidden();
        await expect(page.locator("#open-saved")).toBeVisible();
        await expect(page.locator("#saved-description")).toHaveText(summary!);
        await expect(page.locator(".search-focus-back")).toHaveCount(0);
        await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
        await expect(
          page.locator(width < 900 ? "#search-heading" : "#destination"),
        ).toBeFocused();
      }
      expect(plans).toBe(beforeClose);

      await openCachedJourney(page, page.locator("#open-saved"));
      await page.goBack();
      await expect(page.locator("#search-view")).toBeVisible();
      await expect(list).toBeVisible();
      await expect(list).toContainText("Favoriten");
      await expect(list).toContainText("Zuletzt verwendet");
      await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
      expect(plans).toBe(beforeClose);
    }
  });

  test(`dismissing home search preserves its query and ignores late results at ${width}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await populateHome(page);
    await page.evaluate(async () => {
      const { ApiClient } = await import("/src/transitous.ts");
      ApiClient.prototype.searchPlaces = function (_query, signal) {
        (window as any).searchSignal = signal;
        return ((window as any).searchRun = new Promise((resolve) => {
          (window as any).releaseSearch = () =>
            resolve([
              {
                name: "Berg verspätet",
                detail: "München",
                latitude: 48.15,
                longitude: 11.6,
              },
            ]);
        }));
      };
    });
    const input = page.locator("#destination");
    const list = page.locator("#destination-options");
    await input.fill("Berg");
    await expect(page.locator("#place-status")).toHaveText(
      "Orte werden gesucht …",
    );
    if (width < 900) await page.locator(".search-focus-back").click();
    else await input.press("Escape");
    await page.evaluate(async () => {
      if (!(window as any).searchSignal.aborted)
        throw new Error("Dismissed search was not aborted");
      (window as any).releaseSearch();
      await (window as any).searchRun;
    });
    await expect(input).toHaveValue("Berg");
    await expect(list).toBeVisible();
    await expect(list.locator(".place-select strong")).toHaveText([
      "Bergstraße 1",
    ]);
    await expect(page.locator("#place-status")).toBeEmpty();
    await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);

    await context.setOffline(true);
    await input.fill("");
    if (width < 900) await page.locator(".search-focus-back").click();
    else await input.press("Escape");
    await expect(list).toBeVisible();
    await expect(list.locator(".place-select strong")).toHaveText([
      "Bergstraße 1",
      "Letztes Ziel",
    ]);
    await expect(page.locator("#open-saved")).toBeVisible();
    await expect(page.locator("#place-status")).toBeEmpty();
    await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
  });
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
    await expect(page.locator("#main")).not.toHaveAttribute("inert");
    if (width >= 900) await expect(page.locator("#destination")).toBeFocused();
    else await expect(page.locator("#destination")).not.toBeFocused();
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
      if (close === "button") await page.locator("#search-adjust").click();
      else if (close === "escape") await page.keyboard.press("Escape");
      else await page.goBack();
      await expect(page.locator("#route-editor")).not.toBeVisible();
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

test("collapsing home preserves the query and adjustment draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await populateHome(page);
  await page.locator("#destination").fill("Berg");
  await page.locator(".search-focus-back").click();
  await page.locator("#search-adjust").click();
  await page.locator("#origin").fill("Verworfener Entwurf");
  await page.keyboard.press("Escape");
  await expect(page.locator("#route-editor")).toBeVisible();
  await page.locator("#search-adjust").click();
  await expect(page.locator("#destination")).toHaveValue("Berg");
  await expect(page.locator("#destination-options")).toBeVisible();
  await expect(
    page.locator("#destination-options .place-select strong"),
  ).toHaveText(["Bergstraße 1"]);
  await expect(page.locator("#search-context")).toContainText("Start wählen");
  await expect(page.locator("#search-adjust")).toBeFocused();
  await page.locator("#search-adjust").click();
  await expect(page.locator("#origin")).toHaveValue("Verworfener Entwurf");
  await page.locator("#search-adjust").click();
});

test("home greeting remains visible after cancelling adjustments and searches without saved places", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const close of ["button", "escape"]) {
    await page.locator("#search-adjust").click();
    if (close === "button") await page.locator("#search-adjust").click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("#route-editor")).not.toBeVisible();
    await expect(page.locator("#search-empty")).toBeVisible();
    await expect(page.locator("#destination-options")).toBeHidden();
    await expect(page.locator("#search-adjust")).toBeFocused();
  }
  for (const close of ["back", "escape"]) {
    await page.locator("#destination").click();
    if (close === "back") await page.locator(".search-focus-back").click();
    else await page.locator("#destination").press("Escape");
    await expect(page.locator("#search-empty")).toBeVisible();
    await expect(page.locator("#destination-options")).toBeHidden();
    await expect(page.locator("#search-heading")).toBeFocused();
    await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
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
      content: `:root { font-size: ${fontSize}px; --safe-bottom: ${safeArea}px; }`,
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
