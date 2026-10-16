import { test, expect, type Page } from "@playwright/test";
import { defaults } from "../../src/model";

const examplePath = "?example=bike-transfer";
const production =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;

test.use({ serviceWorkers: "block" });

test("slow entrypoints keep controls unavailable until they are ready", async ({
  page,
}) => {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  for (const entry of ["main", "example"]) {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/src/${entry}.ts`, async (route) => {
      await ready;
      await route.continue();
    });
    await page.goto(entry === "main" ? "/" : `/${examplePath}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("#main")).toHaveAttribute("inert", "");
    await expect(page.locator("#destination")).toBeHidden();
    await expect(page.locator(".app-tabs")).toBeHidden();
    release();
    await expect(page.locator("#main")).not.toHaveAttribute("inert");
    if (entry === "main")
      await expect(page.locator("#destination")).toBeVisible();
    else await expectExample(page);
    await page.unroute(`**/src/${entry}.ts`);
  }
});

async function prepare(page: Page) {
  const requests: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().startsWith("https://api.transitous.org/"))
      requests.push(request.url());
  });
  await page.route("https://api.transitous.org/**", (route) => route.abort());
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  const preferences = {
    ...defaults,
    maxBikeTransfers: 0,
    foldingDuration: 240,
  };
  await page.addInitScript((preferences) => {
    const effects = { location: 0, storage: 0, database: 0 };
    (window as any).exampleEffects = effects;
    localStorage.setItem("foldroute.routing.v3", JSON.stringify(preferences));
    localStorage.setItem("foldroute.routing.v1", "untouched-legacy-value");
    for (const key of ["setItem", "removeItem", "clear"] as const) {
      const original = Storage.prototype[key];
      (Storage.prototype as any)[key] = function (...args: any[]) {
        effects.storage++;
        return (original as Function).apply(this, args);
      };
    }
    const originalOpen = indexedDB.open;
    indexedDB.open = function (...args: Parameters<IDBFactory["open"]>) {
      effects.database++;
      return originalOpen.apply(this, args);
    };
    for (const key of ["getCurrentPosition", "watchPosition"] as const)
      Object.defineProperty(navigator.geolocation, key, {
        value: () => {
          effects.location++;
          throw new Error("The fixed example must not request a location");
        },
      });
  }, preferences);
  return { requests, errors, preferences };
}

async function expectExample(page: Page) {
  await expect(page).toHaveTitle("FoldRoute · Beispielroute");
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator(".route-choice")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".route-choice .route-choice-arrival")).toHaveText(
    "57 min gesamt",
  );
  await expect(page.locator(".route-choice")).toContainText("S8");
  await expect(page.locator(".route-choice")).toContainText("U6");
  await expect(page.locator(".route-choice")).toContainText("19 min");
  await expect(page.locator("#route-request-meta")).toHaveText("Beispielroute");
  await expect(
    page.getByRole("link", { name: "Eigene Route planen", exact: true }),
  ).toBeVisible();
  for (const id of [
    "navigation-start",
    "route-more",
    "adjust-route",
    "refresh-route",
    "map-location",
    "saved-notice",
    "stale-notice",
    "late-departure",
    "result-freshness",
    "navigation-resume-dialog",
  ])
    await expect(page.locator(`#${id}`)).toBeHidden();
  await expect(page.locator(".app-tabs")).toBeHidden();
  expect(await page.locator("#journey-panel").innerText()).not.toMatch(
    /\b\d{1,2}:\d{2}\b|Früheste Ankunft|Abfahrt jetzt|Vergangenheit|Echtzeitdaten/,
  );
  const labels = await page
    .locator("#journey-panel [aria-label]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label")).join(" "),
    );
  expect(labels).not.toMatch(/\b\d{1,2}:\d{2}\b/);
}

async function expectNoEffects(
  page: Page,
  result: Awaited<ReturnType<typeof prepare>>,
) {
  expect(await page.evaluate(() => (window as any).exampleEffects)).toEqual({
    location: 0,
    storage: 0,
    database: 0,
  });
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toEqual(result.preferences);
  expect(
    await page.evaluate(() => localStorage.getItem("foldroute.routing.v1")),
  ).toBe("untouched-legacy-value");
  expect(result.requests).toEqual([]);
  expect(result.errors).toEqual([]);
}

test("fixed example stays identical before and years after its recorded schedule", async ({
  page,
}) => {
  const result = await prepare(page);
  for (const time of ["2026-10-16T08:00:00Z", "2032-02-15T23:50:00Z"]) {
    await page.clock.setFixedTime(new Date(time));
    await page.goto(`/${examplePath}`);
    await expectExample(page);
    await page.reload();
    await expectExample(page);
    await expectNoEffects(page, result);
  }
});

test("example retains the usual map, details and browser navigation on small screens", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const result = await prepare(page);
  await page.goto(`/${examplePath}`);
  await expectExample(page);
  await page
    .getByRole("button", { name: "Details zur Beispielroute", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "57 min gesamt", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#journey-detail")).toContainText(
    "Rad bis Freimann",
  );
  await expect(page.locator("#journey-detail")).toContainText("Entfalten");
  await expect(page.locator("#journey-detail")).toContainText("Falten");
  expect(await page.locator("#journey-detail").innerText()).not.toMatch(
    /\b\d{1,2}:\d{2}\b/,
  );
  await page
    .getByRole("button", { name: "Karte anzeigen", exact: true })
    .click();
  await expect(page.locator("#map")).toBeVisible();
  await expect(
    page.locator("#map svg path.leaflet-interactive"),
  ).not.toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Eigene Route planen", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Gesamte Route anzeigen", exact: true })
    .click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#choices")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.reload();
  await expect(page.locator("#panel-details")).toBeVisible();
  await context.setOffline(true);
  await page
    .getByRole("button", { name: "Karte anzeigen", exact: true })
    .click();
  await expect(page.locator("#map-error")).toContainText("Offline");
  await expect(
    page.locator("#map svg path.leaflet-interactive"),
  ).not.toHaveCount(0);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.locator("#journey-detail")).toContainText(
    "Rad bis Freimann",
  );
  await expectNoEffects(page, result);
});

test("example fits mobile and desktop in light and dark themes", async ({
  page,
}) => {
  const result = await prepare(page);
  await page.goto(`/${examplePath}`);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 760, 900, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expectExample(page);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width);
      const own = page.getByRole("link", {
        name: "Eigene Route planen",
        exact: true,
      });
      expect((await own.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(own).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() =>
          page.locator(".example-route-request").evaluate((element) => {
            const header = element.getBoundingClientRect();
            const origin = element
              .querySelector(".example-origin")!
              .getBoundingClientRect();
            const destination = element
              .querySelector(".example-destination")!
              .getBoundingClientRect();
            return (
              destination.top >= origin.bottom &&
              origin.right <= header.right &&
              destination.right <= header.right
            );
          }),
        )
        .toBe(true);
      if (width >= 900) {
        await expect(page.locator("#map")).toBeVisible();
        await expect(page.locator("#panel-details")).toBeVisible();
      }
      await page.screenshot({
        path: test.info().outputPath(`example-${colorScheme}-${width}.png`),
      });
    }
  }
  await expectNoEffects(page, result);
});

test("own-route action exits the example into the ordinary unfilled planner", async ({
  page,
}) => {
  const result = await prepare(page);
  await page.goto(`/${examplePath}`);
  await expectExample(page);
  await expectNoEffects(page, result);
  const own = page.getByRole("link", {
    name: "Eigene Route planen",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await own.focus();
  await expect(own).toHaveCSS("outline-style", "solid");
  await own.press("Enter");
  await expect(page).toHaveURL(new URL("/", page.url()).href);
  await expect(
    page.getByRole("heading", { name: "Wohin geht’s?", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#destination")).toHaveValue("");
  await expect(page.locator(".app-tabs")).toBeVisible();
  await page.goBack();
  await expectExample(page);
});

test("fixed example also loads from the built static subpath", async ({
  page,
}) => {
  const result = await prepare(page);
  await page.goto(new URL(examplePath, production).href);
  await expectExample(page);
  await expect(
    page.locator("#map svg path.leaflet-interactive"),
  ).not.toHaveCount(0);
  await expectNoEffects(page, result);
});
