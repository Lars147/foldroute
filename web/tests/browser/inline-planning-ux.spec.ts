import { test, expect, type Page } from "@playwright/test";
import {
  addStop,
  expectMotionSettled,
  openRecordedRouteEditor,
} from "./assertions";

const places = [
  {
    name: "Daglfing",
    detail: "81929, München, DE",
    latitude: 48.15,
    longitude: 11.64,
  },
  {
    name: "Bergstraße 1",
    detail: "München, DE",
    latitude: 48.14,
    longitude: 11.6,
  },
  {
    name: "sweet spot kaffee",
    detail: "München, DE",
    latitude: 48.13,
    longitude: 11.57,
  },
];
async function home(page: Page) {
  await page.goto("/");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await page.evaluate(async (places) => {
    const path = "/src/places.ts";
    const { PlaceBook } = await import(path);
    const book = new PlaceBook();
    for (const [i, place] of places.entries())
      await book.change(place, i < 2 ? "favorite" : "use");
  }, places);
  await page.reload();
  await expect(page.locator("#destination-options")).toContainText("Favoriten");
}
async function select(page: Page, id: string, name: string) {
  await page.locator(`#${id}`).click();
  await page
    .locator(`#${id}-options`)
    .getByRole("button", { name: new RegExp(`^Ort auswählen: ${name},`) })
    .click();
}
for (const width of [390, 1280])
  for (const colorScheme of ["light", "dark"] as const)
    test(`inline planning retains fields and only calculates on submit at ${width} in ${colorScheme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      const requests: URL[] = [];
      await page.route("**/api/v6/plan?*", (route) => {
        requests.push(new URL(route.request().url()));
        return route.fulfill({ json: { direct: [], itineraries: [] } });
      });
      await home(page);
      const toggle = page.locator("#search-adjust");
      const toggleBounds = await toggle.boundingBox();
      await toggle.click();
      await expect(page.locator("#route-editor")).toBeVisible();
      expect(await toggle.boundingBox()).toEqual(toggleBounds);
      await expect(page.locator("#search-adjust")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(page.locator("#destination-options")).toBeHidden();
      await expect(page.locator("#origin-options")).toBeHidden();
      await expect(page.locator("#cancel-adjust")).toBeHidden();
      await expect(page.locator("#calculate")).toHaveText("Route berechnen");
      await select(page, "destination", "Daglfing");
      await expect(page.locator("#search-view")).toBeVisible();
      await select(page, "origin", "Bergstraße 1");
      await toggle.click();
      expect(await toggle.boundingBox()).toEqual(toggleBounds);
      await expect(page.locator("#search-context")).toContainText(
        "Bergstraße 1",
      );
      await toggle.click();
      expect(await toggle.boundingBox()).toEqual(toggleBounds);
      await expect(page.locator("#origin")).toHaveValue("Bergstraße 1");
      await expect(page.locator("#destination")).toHaveValue("Daglfing");
      await page.locator("#time-trigger").click();
      await page.locator("#time-cancel").click();
      await expect(page.locator("#time-trigger")).toBeFocused();
      await expect(page.locator("#time-dialog")).toBeHidden();
      await page.screenshot({ path: info.outputPath("expanded-home.png") });
      expect(requests).toHaveLength(0);
      await page.locator("#calculate").click();
      await expect(page.locator("#map-view")).toBeVisible();
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      expect(requests[0].searchParams.get("fromPlace")).toBe(
        "48.140000,11.600000",
      );
    });

for (const width of [390, 1280])
  test(`editing an existing route supports collapse, cancel and browser history at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await home(page);
    await openRecordedRouteEditor(page);
    const originalTarget = await page.locator("#destination").inputValue();
    await select(page, "destination", "Bergstraße 1");
    await page.locator("#search-adjust").click();
    await expect(page.locator("#calculate")).toHaveText("Route neu berechnen");
    await expect(page.locator("#calculate")).toBeVisible();
    await expect(page.locator("#cancel-adjust")).toBeVisible();
    await page.locator("#cancel-adjust").click();
    await expect(page.locator("#map-view")).toBeVisible();
    await expect(page.locator("#adjust-route")).toBeFocused();
    await page.locator("#adjust-route").click();
    await expect(page.locator("#destination")).toHaveValue(originalTarget);
    await page.goBack();
    await expect(page.locator("#map-view")).toBeVisible();
    await page.goForward();
    await expect(page.locator("#route-editor")).toBeVisible();
    await expect(page.locator("#destination")).toHaveValue(originalTarget);
  });

test("hidden invalid stops expand again and prevent routing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await home(page);
  let plans = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/v6/plan")) plans++;
  });
  await page.locator("#search-adjust").click();
  await addStop(page);
  await page.locator("#via-0").fill("Nicht ausgewählt");
  await page.locator("#search-adjust").click();
  await page
    .locator("#destination-options")
    .getByRole("button", { name: /^Ort auswählen: Daglfing,/ })
    .click();
  await expect(page.locator("#route-editor")).toBeVisible();
  await expect(page.locator("#via-0")).toBeFocused();
  await expect(page.locator("#adjust-status")).not.toBeEmpty();
  expect(plans).toBe(0);
});

test("desktop favorites remain usable while switching fields", async ({
  page,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await home(page);
  await openRecordedRouteEditor(page);
  await page.locator("#origin").click();
  await page.locator("#destination").click();
  await expect(page.locator("#origin-options")).toBeHidden();
  await page
    .locator("#destination")
    .press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(
    page.locator("#destination-options button").first(),
  ).toBeFocused();
  const star = page
    .locator("#destination-options")
    .getByRole("button", { name: "sweet spot kaffee: Favorit", exact: true });
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#destination-options")).toBeVisible();
  await page.locator("#search-heading").click();
  await expect(page.locator("#destination-options")).toBeHidden();
});

for (const width of [320, 390, 1280])
  test(`expanded fields clear navigation at ${width} with large text`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await home(page);
    await page.addStyleTag({ content: "html { font-size: 24px }" });
    await page.locator("#search-adjust").click();
    for (let i = 0; i < 3; i++) {
      await addStop(page);
      await page.locator(`#via-${i}`).press("Escape");
    }
    await page.locator("#time-trigger").scrollIntoViewIfNeeded();
    await expect(page.locator("#time-trigger")).toBeInViewport({ ratio: 0.99 });
    await expect(page.locator("#calculate")).toBeInViewport({ ratio: 1 });
    const action = (await page.locator("#calculate").boundingBox())!;
    const tabs = (await page.locator(".app-tabs").boundingBox())!;
    expect(action.y + action.height).toBeLessThanOrEqual(tabs.y);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("expanded-large-text.png") });
  });

test("offline alternatives stay usable without changing the existing route", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await home(page);
  await openRecordedRouteEditor(page);
  await context.setOffline(true);
  await select(page, "destination", "Bergstraße 1");
  await page.locator("#calculate").click();
  await expect(page.locator("#adjust-status")).toContainText(
    "Internetverbindung",
  );
  await expect(page.locator("#calculate")).toHaveText("Route neu berechnen");
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(page.locator("#result-context")).toContainText("Fröttmaning");
});

test("switching fields aborts stale search results and preserves validation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await home(page);
  await page.locator("#search-adjust").click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/geocode?*", async (route) => {
    await gate;
    await route.fulfill({
      json: [{ name: "Verspäteter Ort", lat: 48.2, lon: 11.6 }],
    });
  });
  const request = page.waitForRequest("**/api/v1/geocode?*");
  await page.locator("#origin").fill("Langsame Suche");
  await request;
  await page.locator("#destination").click();
  release();
  await expect(page.locator("#origin-options")).toBeHidden();
  await page.locator("#calculate").click();
  await expect(page.locator("#place-status")).toContainText("Bitte Ziel");
  await page.locator("#time-trigger").click();
  await page.locator("#time-cancel").click();
  await expect(page.locator("#place-status")).toContainText("Bitte Ziel");
  await page.locator("#origin").click();
  await expect(page.locator("#origin-options")).not.toContainText(
    "Verspäteter Ort",
  );
});

test("recalculation replaces the editor entry and Back restores the previous route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await home(page);
  await openRecordedRouteEditor(page);
  await select(page, "destination", "Bergstraße 1");
  await page.locator("#search-adjust").click();
  await page.locator("#search-adjust").click();
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({ json: { direct: [], itineraries: [] } }),
  );
  await page.locator("#calculate").click();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(page.locator("#route-destination")).toHaveText("Bergstraße 1");
  await page.goBack();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(page.locator("#route-destination")).toHaveText("Fröttmaning");
  await page.goForward();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(page.locator("#route-destination")).toHaveText("Bergstraße 1");
});

for (const width of [320, 390, 1280])
  test(`route card exposes field roles and keeps actions in their rows at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await home(page);
    await page.locator("#search-adjust").click();
    await expect(
      page.getByRole("combobox", { name: "Start", exact: true }),
    ).toHaveValue("Aktueller Standort");
    await expect(
      page.getByRole("combobox", { name: "Ziel", exact: true }),
    ).toHaveAttribute("placeholder", "Ziel wählen");
    await expect(page.locator('label[for="origin"]')).toHaveClass("sr-only");
    await expect(page.locator('label[for="destination"]')).toHaveClass(
      "sr-only",
    );
    await expect(
      page.locator("#route-editor-destination #destination"),
    ).toHaveCount(1);
    await expectMotionSettled(page.locator("#route-editor"));
    const origin = (await page.locator("#origin").boundingBox())!;
    const target = (await page.locator("#destination").boundingBox())!;
    const more = (await page.locator("#planner-more").boundingBox())!;
    const swap = (await page.locator("#swap").boundingBox())!;
    expect(origin.y).toBeLessThan(target.y);
    expect(origin.x).toBeCloseTo(target.x, 1);
    expect(origin.width).toBeCloseTo(target.width, 1);
    expect(more.y + more.height / 2).toBeCloseTo(
      origin.y + origin.height / 2,
      0,
    );
    expect(swap.y + swap.height / 2).toBeCloseTo(
      target.y + target.height / 2,
      0,
    );
    await expect(page.locator("#add-stop")).toBeHidden();
    await page.screenshot({ path: info.outputPath("route-card.png") });
  });

for (const width of [390, 1280])
  test(`route actions dismiss without cancelling the draft and support the stop limit at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await home(page);
    await page.locator("#search-adjust").click();
    const menu = page.locator("#planner-actions");
    const more = page.locator("#planner-more");
    await more.click();
    await expect(menu).toBeVisible();
    await expect(page.locator("#add-stop")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await expect(page.locator("#search-adjust")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await more.click();
    await page.locator("#search-heading").click();
    await expect(menu).toBeHidden();
    for (let i = 0; i < 3; i++) {
      await addStop(page);
      await expect(page.locator(`#via-${i}`)).toBeFocused();
      await expect(menu).toBeHidden();
      await page.locator(`#via-${i}`).press("Escape");
    }
    await more.click();
    await expect(page.locator("#add-stop")).toBeDisabled();
    await expect(page.locator("#planner-stop-limit")).toBeVisible();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath("route-menu-limit.png") });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Zwischenziel 1 entfernen", exact: true })
      .click();
    await expect(more).toBeFocused();
    await more.click();
    await expect(page.locator("#add-stop")).toBeEnabled();
    await page.locator("#search-adjust").click();
    await expect(menu).toBeHidden();
    await expect(page.locator("#route-editor")).toBeHidden();
  });

test("connection follows the markers when suggestions open after the destination", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await home(page);
  await page.locator("#search-adjust").click();
  const expectConnection = async () => {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const start = document
            .getElementById("origin-location")!
            .getBoundingClientRect();
          const end = document
            .querySelector(".destination-marker")!
            .getBoundingClientRect();
          const line = document
            .querySelector(".route-connection")!
            .getBoundingClientRect();
          return Math.max(
            Math.abs(line.top - start.top - start.height / 2),
            Math.abs(line.bottom - end.top - end.height / 2),
          );
        }),
      )
      .toBeLessThan(1);
  };
  await expectConnection();
  await page.locator("#destination").click();
  await expect(page.locator("#destination-options")).toBeVisible();
  await expectConnection();
  await page.locator("#origin").click();
  await expect(page.locator("#origin-options")).toBeVisible();
  await expectConnection();
});

for (const width of [390, 1280])
  test(`pointer activation clears keyboard rings and preserves input focus at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await home(page);
    const toggle = page.locator("#search-adjust");
    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS("outline-style", "none");

    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveCSS("outline-style", "solid");
    await expect(toggle).toHaveCSS("outline-width", "2px");
    await expect(toggle).toHaveCSS("outline-offset", "-2px");

    // Clicking an already keyboard-focused control must clear the retained ring.
    await toggle.click();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS("outline-style", "none");
    await page.screenshot({ path: info.outputPath("pointer-focus.png") });

    const origin = page.locator("#origin");
    await origin.click();
    await expect(origin).toBeFocused();
    await expect(origin).toHaveCSS("outline-style", "solid");
    await expect(origin).toHaveCSS("outline-width", "2px");
    await origin.press("Escape");

    await page.locator("#planner-more").click();
    await expect(page.locator("#add-stop")).toBeFocused();
    await expect(page.locator("#add-stop")).toHaveCSS("outline-style", "none");
    await page.keyboard.press("Escape");
    await expect(page.locator("#planner-more")).toBeFocused();
    await expect(page.locator("#planner-more")).toHaveCSS(
      "outline-style",
      "solid",
    );

    await page.locator("#time-trigger").click();
    await page.locator("#time-cancel").click();
    await expect(page.locator("#time-trigger")).toBeFocused();
    await expect(page.locator("#time-trigger")).toHaveCSS(
      "outline-style",
      "none",
    );
    await page.locator("#time-trigger").press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.locator("#time-trigger")).toBeFocused();
    await expect(page.locator("#time-trigger")).toHaveCSS(
      "outline-style",
      "solid",
    );
  });

test.describe("touch focus feedback", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("touch activation clears a previously visible keyboard ring", async ({
    page,
  }) => {
    await home(page);
    const toggle = page.locator("#search-adjust");
    await toggle.tap();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS("outline-style", "none");
    await toggle.press("Enter");
    await expect(toggle).toHaveCSS("outline-style", "solid");
    await toggle.tap();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS("outline-style", "none");
  });
});
