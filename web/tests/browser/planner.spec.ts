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
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("180");
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

// Planning links carry the request, independently of the selected result.
test("planning URL reloads fixed endpoints without location access and keeps now dynamic", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const link = page.url();
  const params = new URL(link).searchParams;
  expect(params.get("from")).toBe("48.132000,11.575600");
  expect(params.get("fromName")).toBe("Startpunkt");
  expect(params.has("time")).toBe(false);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition() {
          throw new Error("Shared link must not locate");
        },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await page.clock.setFixedTime(new Date("2026-09-04T08:05:00Z"));
  const direct = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#refresh-route").click();
  expect(new URL((await direct).url()).searchParams.get("time")).toBe(
    "2026-09-04T08:05:00Z",
  );
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  expect(page.url()).toBe(link);
  expect(errors).toEqual([]);
});

test("link options and edits remain temporary, including Back from settings", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const link = new URL(page.url());
  link.searchParams.set("maxCyclingMinutes", "17");
  await page.goto(link.href);
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await page.locator("#tab-settings").click();
  await expect(page.locator("#settings-summary")).toContainText(
    "nur für diese Planung",
  );
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("17");
  await page.locator("#foldingDuration").fill("4");
  let calculations = 0;
  page.on("request", (r) => {
    if (r.url().includes("directModes=BIKE")) calculations++;
  });
  await page.goBack();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  expect(calculations).toBe(1);
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("240");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toMatchObject({ maxCyclingMinutes: 60, foldingDuration: 180 });
  await page.locator("#close-route").click();
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("60");
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
});

test("Back and Forward restore distinct submitted plans without result history entries", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const first = page.url();
  const length = await page.evaluate(() => history.length);
  await page.locator(".route-choice").last().click();
  expect(page.url()).toBe(first);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.locator("#adjust-route").click();
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({
      headers: cors,
      json: [{ name: "Weiteres Ziel", lat: 48.176, lon: 11.6 }],
    }),
  );
  await choose(page, "adjust-destination", "Weiteres Ziel");
  await page
    .locator("#route-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  const second = page.url();
  expect(new URL(second).searchParams.get("toName")).toBe("Weiteres Ziel");
  await page.goBack();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  expect(page.url()).toBe(first);
  await page.goForward();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  expect(page.url()).toBe(second);
});

test("expired and invalid links never start API searches or change personal settings", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const url = new URL(page.url());
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  url.searchParams.set("timing", "depart");
  url.searchParams.set("time", "2026-09-03T08:00:00Z");
  await page.goto(url.href);
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await expect(page.locator("#adjust-status")).toContainText("Vergangenheit");
  expect(requests).toBe(0);
  url.searchParams.set("v", "999");
  await page.goto(url.href);
  await expect(page.locator("#place-status")).toContainText("ungültig");
  expect(requests).toBe(0);
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
});

test("copy planning link provides a selectable fallback when clipboard is denied", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          Promise.reject(new DOMException("Denied", "NotAllowedError")),
      },
    }),
  );
  await plan(page);
  await page.locator("#copy-plan").click();
  await expect(page.locator("#plan-link-value")).toBeVisible();
  await expect(page.locator("#plan-link-value")).toHaveValue(page.url());
  expect(
    await page
      .locator("#plan-link-value")
      .evaluate(
        (input: HTMLInputElement) =>
          input.selectionEnd! - input.selectionStart!,
      ),
  ).toBe(page.url().length);
});

test("abandoned location lookup cannot publish placeholder coordinates or rewrite the URL", async ({
  page,
}) => {
  await setup(page, false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(success: (result: unknown) => void) {
          (window as unknown as { finishLocation: () => void }).finishLocation =
            () => success({ coords: { latitude: 48.132, longitude: 11.5756 } });
        },
      },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText(
    "Standort wird ermittelt",
  );
  expect(new URL(page.url()).searchParams.has("from")).toBe(false);
  await page.locator("#close-route").click();
  await page.evaluate(() =>
    (window as unknown as { finishLocation: () => void }).finishLocation(),
  );
  await expect(page.locator("#search-view")).toBeVisible();
  expect(new URL(page.url()).searchParams.has("v")).toBe(false);
});

test("copy succeeds and planning details fit a narrow mobile viewport", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedLink = text;
        },
      },
    }),
  );
  await plan(page);
  await page.locator("#panel-size").click();
  await page.locator("#copy-plan").click();
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await expect(page.locator("html")).toHaveAttribute(
    "data-copied-link",
    page.url(),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  await page.screenshot({ path: "test-results/planning-link-mobile.png" });
});

for (const mode of ["depart", "arrive"] as const)
  test(`fixed ${mode} link preserves the chosen UTC instant and local form time`, async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    const link = new URL(page.url());
    link.searchParams.set("timing", mode);
    link.searchParams.set("time", "2026-09-04T09:00:00Z");
    const query = page.waitForRequest((r) =>
      r.url().includes("directModes=BIKE"),
    );
    await page.goto(link.href);
    const params = new URL((await query).url()).searchParams;
    expect(params.get("time")).toBe("2026-09-04T09:00:00Z");
    expect(params.get("arriveBy")).toBe(String(mode === "arrive"));
    await expect(page.locator("#cancel")).toBeHidden();
    await page.locator("#adjust-route").click();
    await expect(page.locator("#timing")).toHaveValue(mode);
    await expect(page.locator("#when")).toHaveValue("2026-09-04T11:00");
  });

test("three regular routes keep their places and comparison is an optional fourth", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#tab-settings").click();
  await expect(page.locator("#showCyclingComparison")).toBeChecked();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  const transit = structuredClone(fixture.multimodal);
  transit.itineraries = [0, 1, 2].map((i) => {
    const route = structuredClone(fixture.multimodal.itineraries[0]);
    route.id = `transit-${i}`;
    for (const leg of route.legs)
      if (leg.mode === "SUBWAY") leg.routeShortName = `U${i + 1}`;
    return route;
  });
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : transit,
    }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveCount(4);
  await expect(page.locator(".route-choice").last()).toContainText("Vergleich");
  await page.locator(".route-choice").last().click();
  await page.locator("#panel-size").click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect
    .poll(
      async () =>
        (await page.locator("#journey-panel").boundingBox())?.height ?? 0,
    )
    .toBeGreaterThan(550);
  await page.screenshot({ path: "test-results/fourth-comparison-mobile.png" });
  await page.locator("#tab-settings").click();
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveCount(3);
  await expect(page.locator("#cycling-comparison")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("showCyclingComparison")).toBe(
    "false",
  );
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
          .showCyclingComparison,
    ),
  ).toBe(false);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveCount(3);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#showCyclingComparison")).not.toBeChecked();
});

test("hidden comparison arriving first does not finish the search before transit", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v6/plan?*", async (r) => {
    const direct =
      new URL(r.request().url()).searchParams.get("directModes") === "BIKE";
    if (!direct) await gate;
    await r.fulfill({
      headers: cors,
      json: direct ? fixture.direct : fixture.multimodal,
    });
  });
  const response = page.waitForResponse((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await choose(page, "destination", "Ziel");
  await response;
  await expect(page.locator("#cancel")).toBeVisible();
  await expect(page.locator(".route-choice")).toHaveCount(0);
  release();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator("#cycling-comparison")).toBeHidden();
});

test("only hidden comparisons produce an empty-result message", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#showCyclingComparison").uncheck();
  await page.locator("#save-settings").click();
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : { itineraries: [], direct: [] },
    }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText("Keine passende Route");
  await expect(page.locator(".route-choice")).toHaveCount(0);
});
