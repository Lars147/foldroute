import { test, expect, type Page } from "@playwright/test";
import { defaults } from "../../src/model";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After",
};
const places = [
  { name: "Start", lat: 48.132, lon: 11.5756 },
  { name: "Ziel", lat: 48.175, lon: 11.6 },
];
async function setup(page: Page, geolocation = true) {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  if (geolocation) {
    await page.context().grantPermissions(["geolocation"]);
    await page
      .context()
      .setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  }
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({ headers: cors, json: places }),
  );
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  await page.goto("/");
  await page.evaluate(
    (value) =>
      localStorage.setItem("foldroute.routing.v3", JSON.stringify(value)),
    { ...defaults, maxCyclingMinutes: 60 },
  );
  await page.reload();
}
async function choose(page: Page, id: string, name: string) {
  await page.locator("#" + id).fill(name);
  await page
    .locator("#" + id + "-options")
    .locator(".place-select")
    .filter({ hasText: name })
    .click();
}
async function plan(page: Page) {
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
}
// The mocked GPS position equals the route origin, so its existing marker
// provides a rendered screen coordinate without exposing the map to tests.
async function locationCenterError(page: Page) {
  return page.evaluate(() => {
    const map = document.getElementById("map")!.getBoundingClientRect(),
      panel = document.getElementById("journey-panel")!.getBoundingClientRect(),
      marker = document
        .querySelector('#map path[fill="#171a1c"]')!
        .getBoundingClientRect();
    const x =
        innerWidth >= 900
          ? (panel.right + map.right) / 2
          : (map.left + map.right) / 2,
      y =
        innerWidth >= 900
          ? (map.top + map.bottom) / 2
          : (map.top + panel.top) / 2;
    return Math.hypot(
      marker.x + marker.width / 2 - x,
      marker.y + marker.height / 2 - y,
    );
  });
}
for (const [width, height] of [
  [320, 986],
  [390, 986],
  [844, 500],
  [1479, 986],
])
  test(`location stays centered in visible map ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await setup(page);
    await plan(page);
    await page.evaluate(() => {
      document.documentElement.dataset.locationCalls = "0";
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition: (success: (value: unknown) => void) => {
            const root = document.documentElement;
            root.dataset.locationCalls = String(
              Number(root.dataset.locationCalls) + 1,
            );
            success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    });
    await page.locator("#map-location").click({ position: { x: 24, y: 4 } });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    for (const size of ["expanded", "collapsed", "normal"]) {
      await page.locator("#panel-size").click();
      await expect(page.locator("#journey-panel")).toHaveAttribute(
        "data-size",
        size,
      );
      await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
      // Check after the CSS transition too, not only at its first frame.
      await page.waitForTimeout(300);
      await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    // A very short landscape viewport can leave no usable map at all.
    // Keep the focus for when the map becomes visible again.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
    await expect(page.locator("html")).toHaveAttribute(
      "data-location-calls",
      "1",
    );
  });

test("manual map gestures release location focus; button restores it and route change resets it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 986 });
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : fixture.multimodal,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveCount(2);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  const map = await page.locator("#map").boundingBox();
  await page.mouse.move(map!.x + 100, map!.y + 150);
  await page.mouse.down();
  await page.mouse.move(map!.x + 180, map!.y + 180, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(30);
  await page.locator("#panel-size").click();
  await page.waitForTimeout(300);
  // Route fitting may move the marker again during the panel transition;
  // only continued location centering (within 2px) would be a regression.
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(5);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator("#panel-size").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator(".leaflet-control-zoom-in").click();
  await page.waitForTimeout(300);
  await page.locator("#panel-size").click();
  await page.waitForTimeout(300);
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(30);
  await page.locator("#map-location").click();
  await expect.poll(() => locationCenterError(page)).toBeLessThan(2);
  await page.locator(".route-choice").last().click();
  await expect.poll(() => locationCenterError(page)).toBeGreaterThan(30);
});

for (const width of [320, 390, 768, 1479])
  test(`responsive app flow ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 986 });
    await setup(page);
    await plan(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "normal",
    );
    await page.locator("#panel-size").click();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "expanded",
    );
    await expect(page.locator("#journey-detail")).toContainText("Rad");
    if (width < 900)
      await expect
        .poll(async () =>
          page
            .locator("#journey-panel")
            .evaluate(
              (e) =>
                e.clientHeight /
                document.getElementById("map-view")!.clientHeight,
            ),
        )
        .toBeGreaterThan(0.85);
    await page.screenshot({
      path: `test-results/app-${width}.png`,
      fullPage: true,
    });
    await page.locator("#panel-size").click();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "collapsed",
    );
    await expect(page.locator("#adjust-route")).toBeInViewport();
  });
test("destination selection calculates automatically, never on opening or typing", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  expect(requests).toBe(0);
  await page.locator("#destination").fill("Ziel");
  await expect(page.locator("#destination-options")).toBeVisible();
  expect(requests).toBe(0);
  await page.locator("#destination").press("ArrowDown");
  await page.locator("#destination").press("ArrowDown");
  await page.locator("#destination").press("Enter");
  await expect(page.locator("#route-duration")).toContainText("32 min");
  expect(requests).toBeGreaterThan(0);
});
test("location denial keeps destination and allows a manual start", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) =>
          fail({ code: 1 }),
      },
    });
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expect(page.locator("#route-duration")).toContainText("32 min");
});
test("adjustments are drafts and cancellation preserves results", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#origin").fill("Other");
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
});
test("settings persist immediately and replan once on leaving", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  let requests = 0,
    directRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) {
      requests++;
      if (new URL(r.url()).searchParams.get("directModes") === "BIKE")
        directRequests++;
    }
  });
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#maxWalkingMinutes").fill("3");
  const cycling = page.getByLabel("Maximale Radzeit je Etappe", {
    exact: false,
  });
  await expect(cycling).toHaveCount(1);
  await expect(cycling).toHaveAttribute("min", "1");
  await expect(cycling).toHaveAttribute("max", "60");
  await cycling.fill("17");
  await expect(page.locator(".route-choice")).toHaveCount(0);
  expect(requests).toBe(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toMatchObject({
    foldingDuration: 240,
    maxWalkingMinutes: 3,
    maxCyclingMinutes: 17,
  });
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  expect(directRequests).toBe(1);
  await page.reload();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("17");
});
test("throttling stops further requests; manual retry observes the pause", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  await page.route("**/api/v6/plan?*", (r) => {
    requests++;
    return r.fulfill({
      status: 429,
      headers: { ...cors, "Retry-After": "60" },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText("Zu viele Anfragen");
  const before = requests;
  await page.locator("#adjust-route").click();
  await page.locator("#calculate").click();
  await expect(page.locator("#status")).toContainText("Pause");
  expect(requests).toBe(before);
});
test("cancel retains progressive results and ignores delayed responses", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: fixture.direct });
    else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#cancel").click();
  await expect(page.locator("#status")).toContainText("abgebrochen");
  await page.waitForTimeout(1700);
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await expect(page.locator("#status")).toContainText("abgebrochen");
});
test("better alternatives replace automatic selection", async ({ page }) => {
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: direct });
    else {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("1 h 1 min");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveText([
    "1 · 53 min",
    "Vergleich · 1 h 1 min",
  ]);
  await expect(page.locator(".route-choice[aria-pressed=true]")).toHaveText(
    "1 · 53 min",
  );
  await expect(page.locator("#route-duration")).toContainText("53 min");
  await page.locator("#panel-summary").press("ArrowRight");
  await expect(page.locator("#route-duration")).toContainText("1 h 1 min");
});
test("failed refresh preserves selected journey", async ({ page }) => {
  await setup(page);
  await plan(page);
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 503, headers: cors }),
  );
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText("nicht verfügbar");
  await expect(page.locator("#route-duration")).toContainText("32 min");
});
test("dark appearance, large text and reduced motion remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await setup(page);
  await plan(page);
  await page.locator("#panel-size").click();
  await page.addStyleTag({ content: ":root {font-size: 24px !important;}" });
  await expect(page.locator("#adjust-route")).toBeVisible();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await page.locator("#cancel-adjust").click();
  await page.screenshot({
    path: "test-results/app-dark-large.png",
    fullPage: true,
  });
});

test("adjustment actions remain reachable in a short keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await setup(page);
  await page.locator("#search-adjust").click();
  await page.locator("#origin").focus();
  await expect(page.locator("#calculate")).toBeInViewport({ ratio: 1 });
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").scrollIntoViewIfNeeded();
  await expect(page.locator("#when")).toBeInViewport();
  await expect(page.locator("#use-context")).toBeInViewport({ ratio: 1 });
});

test("focused dialog fields stay inside the scroll area when the keyboard opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#search-adjust").focus();
  await page.locator("#search-adjust").press("Enter");
  await page.locator("#adjust-destination").fill("Zi");
  await page
    .locator("#adjust-destination")
    .evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));

  // Unlike resizing the page, an iOS keyboard shrinks the visual viewport
  // while leaving the layout viewport intact.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", {
      configurable: true,
      value: 365,
    });
    Object.defineProperty(window.visualViewport!, "offsetTop", {
      configurable: true,
      value: 40,
    });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  });
  const expectFieldInside = async (id: string, withLabel = true) => {
    await expect
      .poll(() =>
        page.evaluate(
          ({ id, withLabel }) => {
            const field = document.getElementById(id) as HTMLInputElement;
            const bounds = document
              .querySelector(".dialog-body")!
              .getBoundingClientRect();
            const input = field.getBoundingClientRect();
            const label = field.labels![0].getBoundingClientRect();
            return (
              Math.min(input.top, withLabel ? label.top : input.top) >=
                bounds.top - 1 && input.bottom <= bounds.bottom + 1
            );
          },
          { id, withLabel },
        ),
      )
      .toBe(true);
    await expect(page.locator(`#${id}`)).toBeFocused();
  };
  await expectFieldInside("adjust-destination");
  await expect(page.locator("#adjust-destination")).toHaveValue("Zi");
  expect(
    await page
      .locator("#adjust-destination")
      .evaluate((input: HTMLInputElement) => input.selectionStart),
  ).toBe(1);

  await page.locator("#origin").focus();
  await expectFieldInside("origin");
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").focus();
  await expectFieldInside("when");
  await choose(page, "adjust-destination", "Ziel");
  await expectFieldInside("adjust-destination");
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");

  await page.addStyleTag({ content: ":root { font-size: 24px; }" });
  await page.evaluate(() =>
    window.visualViewport!.dispatchEvent(new Event("resize")),
  );
  await expectFieldInside("adjust-destination", false);
  const actionsVisible = await page.evaluate(() => {
    const actions = document
      .querySelector(".dialog-actions")!
      .getBoundingClientRect();
    const viewport = window.visualViewport!;
    return (
      actions.top >= viewport.offsetTop &&
      actions.bottom <= viewport.offsetTop + viewport.height
    );
  });
  expect(actionsVisible).toBe(true);
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#search-adjust")).toBeFocused();
});

for (const code of [0, 1, 2, 3]) {
  test(`location button requests access immediately: ${code}`, async ({
    page,
  }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (
            success: (p: unknown) => void,
            fail: (e: unknown) => void,
          ) => {
            if (code)
              fail({
                code,
                message:
                  "Origin does not have permission to use Geolocation service",
              });
            else success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    }, code);
    await setup(page, false);
    await page.locator("#search-adjust").click();
    await page.locator("#origin-location").click();
    await expect(page.locator("#adjust-status")).toContainText(
      [
        "Standort verfügbar",
        "Standortzugriff nicht erlaubt",
        "Standort konnte nicht ermittelt werden",
        "Standortabfrage dauert zu lange",
      ][code],
    );
    if (code) {
      await expect(page.locator("#adjust-status")).toContainText(
        `Diagnose: Standortfehler ${code} – Origin does not have permission to use Geolocation service`,
      );
    }
    if (code) await expect(page.locator("#adjust-location-help")).toBeVisible();
    else await expect(page.locator("#adjust-location-help")).toBeHidden();
    await expect(page.locator("#origin-location")).toBeEnabled();
    await expect(page.locator("#adjust-dialog")).toBeVisible();
  });
}

test("cancelled location request does not overwrite manual start feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) => {
          window.addEventListener("fail-location", () => fail({ code: 1 }), {
            once: true,
          });
        },
      },
    });
  });
  await setup(page, false);
  await page.locator("#search-adjust").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#origin-location")).toBeDisabled();
  await choose(page, "origin", "Start");
  await page.evaluate(() => window.dispatchEvent(new Event("fail-location")));
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(page.locator("#adjust-status")).toHaveText("");
  await expect(page.locator("#origin-location")).toBeEnabled();
});

test("map location help persists and clears on retry; manual origin clears dialog help", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (
          success: (value: unknown) => void,
          fail: (error: unknown) => void,
        ) => {
          calls++;
          if (calls === 2)
            success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          else fail({ code: 1, message: "User denied Geolocation" });
        },
      },
    });
  });
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location-error")).toBeVisible();
  await expect(page.locator("#map-location-error a")).toHaveAttribute(
    "href",
    "hilfe.html#standort",
  );
  await page.waitForTimeout(6200);
  await expect(page.locator("#map-location-error")).toBeVisible();
  await page.locator("#map-location").click();
  await expect(page.locator("#map-location-error")).toBeHidden();
  await page.locator("#adjust-route").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#adjust-location-help")).toBeVisible();
  await choose(page, "origin", "Start");
  await expect(page.locator("#adjust-location-help")).toBeHidden();
  await page.locator("#calculate").click();
  await expect(page.locator("#adjust-dialog")).toBeHidden();
  await expect(page.locator("#status")).toContainText("Verbindungen gefunden");
});

test("help opens direct topics and fits narrow screens with enlarged text", async ({
  page,
}) => {
  await page.goto("/hilfe.html#standort-freigabe");
  await expect(page.locator("#standort-freigabe")).toHaveAttribute("open", "");
  await expect(page.locator("#standort-freigabe summary")).toBeInViewport();
  await page.locator("#standort-freigabe summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#standort-freigabe")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.addStyleTag({ content: "html { font-size: 24px; }" });
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 1660]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
});

test("favorites and recent places share all searches and remain available offline", async ({
  page,
  context,
}) => {
  await setup(page);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#destination").fill("Ziel");
  await page
    .getByRole("button", { name: "Ziel: Favorit", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Ziel: Favorit", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(requests).toBe(0);
  await page.locator("#destination").fill("");
  await expect(page.locator("#destination-options")).toContainText("Favoriten");
  await page.locator("#search-adjust").click();
  await page.locator("#origin").fill("");
  await expect(page.locator("#origin-options")).toContainText("Favoriten");
  await choose(page, "origin", "Start");
  await page.locator("#adjust-destination").fill("");
  await expect(page.locator("#adjust-destination-options")).toContainText(
    "Zuletzt verwendet",
  );
  await expect(
    page.locator("#adjust-destination-options .place-select"),
  ).toHaveCount(3);
  await page.locator("#cancel-adjust").click();
  await page.reload();
  await expect(page.locator("#destination-options")).toContainText("Favoriten");
  await expect(page.locator("#destination-options")).toContainText(
    "Zuletzt verwendet",
  );
  await context.setOffline(true);
  await page.locator("#destination").fill("Zi");
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    1,
  );
  await expect(page.locator("#destination-options")).toContainText("Ziel");
  await page.screenshot({
    path: "test-results/favorites-offline.png",
    fullPage: true,
  });
});

test("two-character search requests twelve results; prefill keeps cursor and makes no request", async ({
  page,
}) => {
  await setup(page);
  const searches: URL[] = [];
  await page.route("**/api/v1/geocode?*", (r) => {
    searches.push(new URL(r.request().url()));
    return r.fulfill({
      headers: cors,
      json: Array.from({ length: 15 }, (_, i) => ({
        name: `Ziel ${i}`,
        lat: 48.175 + i / 10000,
        lon: 11.6,
      })),
    });
  });
  await page.locator("#destination").fill("Zi");
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    12,
  );
  expect(searches[0].searchParams.get("numResults")).toBe("12");
  expect(searches[0].searchParams.get("place")).toBe("48.1372,11.5756");
  await page
    .getByRole("button", {
      name: "Ziel 0 ins Suchfeld übernehmen",
      exact: true,
    })
    .click();
  await expect(page.locator("#destination")).toHaveValue("Ziel 0 ");
  await expect(page.locator("#destination")).toBeFocused();
  expect(
    await page
      .locator("#destination")
      .evaluate((e: HTMLInputElement) => e.selectionStart),
  ).toBe(7);
  expect(searches).toHaveLength(1);
  await page.locator("#destination").press("Enter");
  await expect.poll(() => searches.length).toBe(2);
});

test("settings errors keep old offline snapshot but never restore invalidated options", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await expect(page.locator("#storage-message")).toContainText("gespeichert");
  const original = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("foldroute-offline", 2);
      r.onsuccess = () => resolve(r.result);
    });
    const value = await new Promise<any>((resolve) => {
      const r = db.transaction("state").objectStore("state").get("last");
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return value;
  });
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 500, headers: cors }),
  );
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4.5");
  await page.goBack();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await page.locator("#close-route").click();
  await page.locator("#open-saved").click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4.5");
  expect(original.settings.foldingDuration).toBe(180);
});

test("clearing local data requires confirmation and removes all app records", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#destination").fill("Ziel");
  await page
    .getByRole("button", { name: "Ziel: Favorit", exact: true })
    .click();
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#clear-data").click();
  await page.locator("#cancel-delete-data").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await page.locator("#clear-data").click();
  await page.locator("#confirm-delete-data").click();
  await expect(page.locator("#search-view")).toBeVisible();
  await expect(page.locator("#open-saved")).toBeHidden();
  await page.reload();
  await expect(page.locator("#destination-options .place-select")).toHaveCount(
    1,
  );
  await expect(page.locator("#open-saved")).toBeHidden();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
  expect(
    await page.evaluate(() => [
      localStorage.getItem("foldroute.routing.v1"),
      localStorage.getItem("foldroute.routing.v3"),
    ]),
  ).toEqual([null, null]);
});

test("late-departure notice appears only after search completes and opens settings", async ({
  page,
}) => {
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].startTime = direct.direct[0].legs[0].startTime =
    "2026-09-04T09:00:00Z";
  direct.direct[0].endTime = direct.direct[0].legs[0].endTime =
    "2026-09-04T09:32:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : { itineraries: [], direct: [] },
    }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator("#late-departure")).toContainText("1 h nach");
  await page.locator("#late-settings").click();
  await expect(page.locator("#settings-view")).toBeVisible();
});

test("an expired fixed departure requires adjustment and sends no new plan requests", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").fill("2026-09-04T10:00");
  await page.locator("#calculate").click();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await page.clock.setFixedTime(new Date("2026-09-04T08:01:00Z"));
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#tab-route").click();
  await expect(page.locator("#status")).toContainText("zukünftigen Zeitpunkt");
  await expect(page.locator(".route-choice")).toHaveCount(0);
  expect(requests).toBe(0);
});

test("long direct rides are labeled comparisons and suitable transit is preferred", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  const direct = structuredClone(fixture.direct);
  direct.direct[0].endTime = direct.direct[0].legs[0].endTime =
    "2026-09-04T08:46:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : fixture.multimodal,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice[aria-pressed=true]")).toHaveText(
    "1 · 53 min",
  );
  await page.getByRole("button", { name: /Fahrradvergleich: 46 Min/ }).click();
  await expect(page.locator("#cycling-comparison")).toHaveText(
    "46 Min. Radfahrt · 16 Min. über deinem Radlimit",
  );
  await page.locator("#panel-size").click();
  await page.locator("#panel-size").click();
  await expect(page.locator("#option-title")).toContainText(
    "16 Min. über deinem Radlimit",
  );
  await expect(page.locator("#option-title")).toBeInViewport();
});

test("transit renders before a pending comparison and an explicit comparison stays selected", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (r) => {
    const direct =
      new URL(r.request().url()).searchParams.get("directModes") === "BIKE";
    if (direct) await pending;
    await r.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("53 min");
  await expect(page.locator("#status")).toContainText("Weitere Verbindungen");
  release();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await page.getByRole("button", { name: /Fahrradvergleich:/ }).click();
  await expect(page.locator("#option-title")).toContainText("Fahrradvergleich");
});
