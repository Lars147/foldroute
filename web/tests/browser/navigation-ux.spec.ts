import { test, expect } from "@playwright/test";
import { distance } from "../../src/geometry";
import { openCachedJourney, expectMotionSettled } from "./assertions";
import { mockRasterBasemap } from "./basemap";
import {
  now,
  e,
  route,
  setup,
  guidanceRoute,
  complete,
  expectMobileCredit,
  expectNavigationBasemap,
  savedActive,
  startSelected,
} from "./navigation-fixture";

test("double click keeps navigation zoom unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await page.clock.runFor(1000);
  const map = page.locator("#navigation-map");
  const zoom = await map.getAttribute("data-zoom");
  await map.dblclick({ position: { x: 180, y: 200 } });
  await page.clock.runFor(1000);
  await expect(map).toHaveAttribute("data-zoom", zoom!);
});

for (const width of [390, 1280]) {
  test(`next actual turn stays visible across short straight steps at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, false, false, {}, guidanceRoute());
    await page.locator("#route-more").click();
    await page.locator("#navigation-start").click();
    const instruction = page.locator("#navigation-instruction");
    const meters = page.locator("#navigation-distance");
    await expect(instruction).toHaveText("Links abbiegen auf Am Isarufer");
    await expect(page.locator("#navigation-arrow")).toHaveText("↰");
    await expect(meters).toHaveText("805 m");
    for (const longitude of [
      11.00005, 11.0001, 11.001, 11.0054, 11.0098, 11.0106,
    ]) {
      await page.clock.runFor(20000);
      await page.evaluate(
        (longitude) => (window as any).navProbe.push(48, longitude),
        longitude,
      );
      await expect(instruction).toHaveText("Links abbiegen auf Am Isarufer");
      const expected =
        Math.round(
          distance(
            { latitude: 48, longitude },
            { latitude: 48, longitude: 11.0108 },
          ) / 5,
        ) * 5;
      await expect(meters).toHaveText(`${expected} m`);
    }
    const spoken = await page.evaluate(
      () => (window as any).navProbe.spoken as string[],
    );
    expect(
      spoken.filter((text) => text.includes("Links abbiegen")),
    ).toHaveLength(2);
    expect(spoken.some((text) => text.includes("Geradeaus"))).toBe(false);
    await page.screenshot({ path: info.outputPath("next-turn-countdown.png") });
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.0108));
    await expect(instruction).toHaveText("Rechts abbiegen auf Zum Bahnhof");
    await expect(page.locator("#navigation-arrow")).toHaveText("↱");
    await expect(meters).toHaveText("220 m");
  });

  test(`two inferred turns in one source step have separate announcements and survive GPS loss and resume at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, false, false, {}, guidanceRoute(true));
    await page.locator("#route-more").click();
    await page.locator("#navigation-start").click();
    const instruction = page.locator("#navigation-instruction");
    const meters = page.locator("#navigation-distance");
    await expect(instruction).toHaveText("Links abbiegen");
    await expect(meters).toHaveText("60 m");
    await page.clock.runFor(5000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.0008));
    await expect(instruction).toHaveText("Rechts abbiegen");
    await expect(meters).toHaveText("65 m");
    let spoken = await page.evaluate(
      () => (window as any).navProbe.spoken as string[],
    );
    expect(
      spoken.filter((text) => text.includes("Links abbiegen")),
    ).toHaveLength(1);
    expect(
      spoken.filter((text) => text.includes("Rechts abbiegen")),
    ).toHaveLength(1);
    await page.evaluate(() => (window as any).navProbe.fail(2));
    await expect(meters).toBeEmpty();
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).navProbe.push(48.0003, 11.0008));
    await expect(meters).toHaveText("35 m");
    await page.evaluate(() => (window as any).navProbe.hide(true));
    await page.reload();
    await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
    await page.evaluate(() => (window as any).navProbe.push(48.0003, 11.0008));
    await page.locator("#navigation-resume").click();
    await expect(instruction).toHaveText("Rechts abbiegen");
    await expect(meters).toHaveText("35 m");
    await page.clock.runFor(1000);
    await page.evaluate(() => (window as any).navProbe.push(48.0006, 11.0008));
    await expect(instruction).toHaveText("Nach Ziel");
    await expect(meters).toHaveText("165 m");
    await page.clock.runFor(10000);
    await page.evaluate(() => (window as any).navProbe.push(48.0006, 11.003));
    await expect(instruction).toHaveText("Ziel erreicht");
    spoken = await page.evaluate(
      () => (window as any).navProbe.spoken as string[],
    );
    expect(spoken).toContain("Ziel erreicht");
    expect(spoken.some((text) => /In .*Metern Ziel erreicht/.test(text))).toBe(
      false,
    );
  });
}

test("System appearance changes navigation panels without resetting progress", async ({
  page,
}, info) => {
  const mapStyles: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://tiles.openfreemap.org/styles/"))
      mapStyles.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await setup(page);
  await expect.poll(() => mapStyles.length).toBeGreaterThan(0);
  expect(mapStyles.every((url) => url.endsWith("/positron"))).toBe(true);
  const initialStyles = [...mapStyles];
  const instruction = await page.locator("#navigation-instruction").innerText();
  const phase = await page.locator(".navigation-phase.current").innerText();
  await expect(page.locator(".navigation-panel")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
  await page.screenshot({ path: info.outputPath("navigation-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator(".navigation-panel")).toHaveCSS(
    "background-color",
    "rgb(23, 26, 28)",
  );
  await expect(page.locator("#navigation-map")).toHaveCSS(
    "background-color",
    "rgb(238, 240, 235)",
  );
  expect(mapStyles).toEqual(initialStyles);
  await expect(page.locator("#navigation-instruction")).toHaveText(instruction);
  await expect(page.locator(".navigation-phase.current")).toHaveText(phase);
  await page.screenshot({ path: info.outputPath("navigation-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("#navigation-instruction")).toHaveText(instruction);
  await expect(page.locator(".navigation-panel")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
});

test("navigation keeps a basemap that finishes loading after going offline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await mockRasterBasemap(page);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "https://tiles.openfreemap.org/styles/liberty",
    async (route) => {
      await ready;
      await route.fallback();
    },
  );
  const requested = page.waitForRequest(
    "https://tiles.openfreemap.org/styles/liberty",
  );
  await page.evaluate(async () => {
    const { mapStyle } = await import("/src/map-style.ts");
    mapStyle.set("liberty");
  });
  await requested;
  // Keep fixture responses reachable to simulate a style finishing from an in-flight request.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  release();
  await page.clock.runFor(1000);
  await expectNavigationBasemap(page);
  await expect(page.locator("#navigation-network-status")).toContainText(
    "Offline",
  );
});

test("map style selection keeps manual navigation camera and progress", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await page.route("https://tiles.openfreemap.org/styles/**", (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#eef0eb" },
          },
        ],
      },
    }),
  );
  await page.locator("#navigation-map").press("ArrowRight");
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "false",
  );
  await page.clock.runFor(1000);
  const camera = await page.locator("#navigation-map").evaluate((element) => ({
    center: element.dataset.center,
    zoom: element.dataset.zoom,
    bearing: element.dataset.bearing,
  }));
  const instruction = await page.locator("#navigation-instruction").innerText();
  await page
    .getByRole("button", { name: "Kartenstil wählen", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Karte anpassen",
    exact: true,
  });
  await expect(panel).toHaveCSS("left", "0px");
  await expect(panel).toHaveCSS("bottom", "0px");
  await expect(panel).toHaveCSS("width", "390px");
  for (const [name, value] of [
    ["Straßenkarte", "liberty"],
    ["Dunkel", "dark"],
    ["Positron", "positron"],
  ]) {
    await panel.getByRole("radio", { name, exact: true }).check();
    await expect(panel).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-map-style", value);
    await expect(page.locator("#navigation-map")).toHaveAttribute(
      "data-following",
      "false",
    );
    expect(
      await page.locator("#navigation-map").evaluate((element) => ({
        center: element.dataset.center,
        zoom: element.dataset.zoom,
        bearing: element.dataset.bearing,
      })),
    ).toEqual(camera);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
  }
  await panel
    .getByRole("button", { name: "Kartenstile schließen", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await page
    .getByRole("button", { name: "Standort folgen", exact: true })
    .click();
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "true",
  );
});

for (const [width, height] of [
  [320, 568],
  [390, 844],
  [430, 932],
  [844, 390],
])
  test(`compact mobile navigation keeps the map accessible at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await setup(page, true);
    await expect(page.locator("#navigation-details")).toBeHidden();
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await expect(page.locator("#navigation-alert")).toBeHidden();
    await expect(page.locator(".navigation-panel")).toHaveCSS("bottom", "12px");
    await expectMobileCredit(page);
    const bounds = await page.evaluate(() => {
      const top = document
        .getElementById("navigation-top")!
        .getBoundingClientRect();
      const panel = document
        .getElementById("navigation-panel")!
        .getBoundingClientRect();
      const end = document
        .getElementById("navigation-end")!
        .getBoundingClientRect();
      return {
        top: top.bottom,
        bottom: panel.top,
        panelHeight: panel.height,
        endWidth: end.width,
        endHeight: end.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    // Departure and platform stay visible alongside the arrival time.
    expect(bounds.panelHeight).toBeLessThanOrEqual(180);
    expect(bounds.endWidth).toBeGreaterThanOrEqual(44);
    expect(bounds.endHeight).toBeGreaterThanOrEqual(44);
    expect(bounds.overflow).toBe(false);
    if (width === 390)
      expect(bounds.bottom - bounds.top).toBeGreaterThanOrEqual(height * 0.6);
    await page.screenshot({
      path: test.info().outputPath(`compact-${width}.png`),
    });
    await page.locator("#navigation-details-toggle").press("Enter");
    await expect(page.locator("#navigation-details")).toBeVisible();
    await expect(page.locator("#navigation-complete")).toBeVisible();
    await expectMobileCredit(page);
    await page.locator("#navigation-details-toggle").press("Escape");
    await expect(page.locator("#navigation-details")).toBeHidden();
    // Measure the pointer path after the deliberate sheet transition settles.
    await expect
      .poll(() =>
        page
          .locator("#navigation-panel")
          .evaluate((panel) => panel.getAnimations().length),
      )
      .toBe(0);
    const grip = await page.locator("#navigation-details-toggle").boundingBox();
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + 15);
    await page.mouse.down();
    await page.mouse.move(grip!.x + grip!.width / 2, grip!.y - 40, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(page.locator("#navigation-details")).toBeVisible();
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-details")).toBeHidden();
    await page.evaluate(() => (window as any).navProbe.push(48, 11, 90, 500));
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "GPS ungenau",
    );
    await expect(page.locator("#navigation-alert")).toBeHidden();
    await expectMobileCredit(page);
    await page.screenshot({
      path: test.info().outputPath("gps-status-credits.png"),
    });
    await expect(page.locator("#navigation-details")).toBeHidden();
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-location-status")).toBeVisible();
    await expectMobileCredit(page);
    await page.screenshot({
      path: test.info().outputPath("expanded-credits.png"),
    });
  });

test("following camera uses final panel geometry during the sheet animation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await setup(page, true);
  const panel = page.locator("#navigation-panel");
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-following", "true");
  await expectMotionSettled(panel);
  const collapsedCenter = await map.getAttribute("data-center");
  const started = await page
    .locator("#navigation-details-toggle")
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      const panel = document.getElementById("navigation-panel")!;
      const animations = panel.getAnimations();
      for (const animation of animations) animation.pause();
      return {
        count: animations.length,
        gap: Math.abs(
          panel.getBoundingClientRect().top -
            (panel.parentElement!.getBoundingClientRect().top +
              panel.offsetTop),
        ),
      };
    });
  expect(started.count).toBeGreaterThan(0);
  expect(started.gap).toBeGreaterThan(20);
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const screen = element.parentElement!;
        const map = document.getElementById("navigation-map")!;
        const finalTop =
          screen.getBoundingClientRect().top +
          element.offsetTop -
          map.getBoundingClientRect().top;
        return Math.abs(
          parseFloat(screen.style.getPropertyValue("--navigation-panel-top")) -
            finalTop,
        );
      }),
    )
    .toBeLessThan(1);
  await expect(map).not.toHaveAttribute("data-center", collapsedCenter!);
  const expandedCenter = await map.getAttribute("data-center");
  await panel.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
  });
  await expectMotionSettled(panel);
  await expect(map).toHaveAttribute("data-center", expandedCenter!);
  await expect(map).toHaveAttribute("data-following", "true");
});

test("mobile details resize without recentering a manually moved map and keep stop actions visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true);
  await page.locator("#navigation-map").press("ArrowRight");
  await page.clock.runFor(400);
  const center = await page
    .locator("#navigation-map")
    .getAttribute("data-center");
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-details")).toBeVisible();
  await page.clock.runFor(400);
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-center",
    center!,
  );
  await expectMobileCredit(page);
  for (let index = 0; index < 5; index++) await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Zwischenziel erreicht",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(page.locator("#navigation-complete")).toBeVisible();
  await expect(page.locator("#navigation-complete")).toHaveText("Weiterfahren");
  await page.locator("#navigation-complete").click();
  await expect(page.locator("#navigation-instruction")).not.toHaveText(
    "Zwischenziel erreicht",
  );
});

test("navigation credits move between mobile panel and desktop bottom right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const links = page.locator(".navigation-credit a");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute(
    "href",
    "https://openmaptiles.org/",
  );
  await expect(links.nth(1)).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright",
  );
  await expect(page.locator(".navigation-credit")).toHaveText(
    "© OpenMapTiles · © OpenStreetMap",
  );
  await page.locator("#navigation-details-toggle").click();
  await expectMobileCredit(page);
  await page.locator("#navigation-details-toggle").click();
  await expectMobileCredit(page);
  await page.locator("#navigation-map").press("ArrowRight");
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "false",
  );
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#navigation-details")).toBeVisible();
  const credit = page.locator(".navigation-credit");
  await expect(credit).toHaveCSS("bottom", "5px");
  await expect(credit).toHaveCSS("right", "12px");
  await expect(credit).toHaveCSS("transform", "none");
  await expect(credit).toBeInViewport();
  for (const link of await links.all()) await link.click({ trial: true });
  await expect(page.locator(".navigation-panel")).toHaveCSS("bottom", "28px");
  await page.screenshot({
    path: test.info().outputPath("desktop-credits.png"),
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expectMobileCredit(page);
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "false",
  );
});

test("mobile guidance wraps long names and large text without losing controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await setup(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    document.getElementById("navigation-instruction")!.textContent =
      "Links abbiegen auf Bürgermeister-Friedrich-Wilhelm-Straße";
  });
  await expect(page.locator("#navigation-end")).toBeInViewport();
  await expect(page.locator("#navigation-center")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("large-text.png") });
  await page.locator("#navigation-end").click();
  await expect(page.locator("#navigation-confirm")).toBeVisible();
});
for (const width of [390, 1280])
  test(`rotating navigation, speech, user camera and finish at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await expect(page.locator(".app-tabs")).toBeHidden();
    await expect(page.locator("#navigation-map canvas")).toBeVisible();
    await expect(page.locator("#navigation-map")).toHaveAttribute(
      "data-bearing",
      "90",
    );
    await expect.poll(() => savedActive(page)).toBe(true);
    await page.locator("#navigation-audio").click();
    await expect(page.locator("#navigation-audio")).toHaveAttribute(
      "aria-label",
      "Ton einschalten",
    );
    await expect(page.locator("#navigation-audio")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator("#navigation-audio svg")).toBeVisible();
    const map = page.locator("#navigation-map");
    await expect(map).toHaveAttribute("data-zoom", "17");
    await map.press("-");
    await page.clock.runFor(400);
    await expect(map).toHaveAttribute("data-zoom", "16");
    await expect(map).toHaveAttribute("data-following", "false");
    await expect(page.locator("#navigation-center")).toHaveAttribute(
      "title",
      "Standort folgen",
    );
    await page.locator("#navigation-center").click();
    await expect(map).toHaveAttribute("data-following", "true");
    await expect(page.locator("#navigation-center")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(map).toHaveAttribute("data-zoom", "17");
    await page.screenshot({ path: test.info().outputPath("navigation.png") });
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-no").click();
    await expect(page.locator("#navigation-view")).toBeVisible();
    await complete(page);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Ziel erreicht",
    );
    await expect.poll(() => savedActive(page)).toBe(false);
    await expect(page.locator("#navigation-finish-heading")).toBeVisible();
    await page
      .getByRole("button", { name: "Fahrt abschließen", exact: true })
      .click();
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#search-view")).toBeVisible();
    expect(errors).toEqual([]);
  });
test("mobile touch drag moves the unfocused map and following restores its center", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const map = page.locator("#navigation-map");
  await page.locator("#navigation-end").focus();
  const initial = await map.getAttribute("data-center");
  expect(initial).toBeTruthy();
  await expect(map).toHaveCSS("touch-action", "none");
  await page.evaluate(() => {
    const target = document.elementFromPoint(100, 220)!;
    if (!target.closest("#navigation-map")) throw new Error("Map is covered");
    for (const [type, x, y] of [
      ["pointerdown", 100, 220],
      ["pointermove", 120, 225],
      ["pointermove", 180, 250],
      ["pointerup", 180, 250],
    ] as const) {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
        }),
      );
    }
  });
  await page.clock.runFor(400);
  await expect(map).toHaveAttribute("data-following", "false");
  await expect(map).not.toHaveAttribute("data-center", initial!);
  const moved = await map.getAttribute("data-center");
  await page.evaluate(() => (window as any).navProbe.push(48, 11));
  await expect(map).toHaveAttribute("data-center", moved!);
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-center", initial!);
  await expect(map).toHaveAttribute("data-zoom", "17");
});
for (const problem of ["departed", "cancelled"] as const)
  test(`a ${problem} selection stays visible until a new search is explicitly requested`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await setup(page, true, false, {
      timing: "arrive",
      time: route(true).arrival,
    });
    if (problem === "departed") await page.clock.runFor(310000);
    else
      await page.route("**/api/v6/trip?*", (r) =>
        r.fulfill({
          json: {
            legs: [
              {
                from: {
                  stopId: "A",
                  scheduledDeparture: new Date(
                    (now + 300) * 1000,
                  ).toISOString(),
                },
                to: {
                  stopId: "D",
                  scheduledArrival: new Date((now + 600) * 1000).toISOString(),
                },
                cancelled: true,
              },
            ],
          },
        }),
      );
    const searched: URL[] = [];
    await page.route("**/api/v6/plan?*", async (request) => {
      searched.push(new URL(request.request().url()));
      await request.fulfill({ json: { direct: [], itineraries: [] } });
    });
    await startSelected(page);
    await expect(page.locator("#navigation-start-notice")).toContainText(
      problem === "departed" ? "liegt zurück" : "fällt aus",
    );
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#navigation-search-now")).toBeVisible();
    expect(searched).toHaveLength(0);
    expect(await savedActive(page)).toBe(false);
    await expect(page.locator("#navigation-view-connection")).toHaveCount(0);
    await expect(page.locator("#panel-details")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`connection-${problem}.png`),
    });
    await page.context().setOffline(true);
    await expect(page.locator("#navigation-search-now")).toBeDisabled();
    await expect(page.locator("#navigation-start-notice")).toContainText(
      "Internet",
    );
    await page.context().setOffline(false);
    await page.locator("#navigation-search-now").click();
    await expect.poll(() => searched.length).toBeGreaterThan(0);
    expect(
      searched.every((url) => url.searchParams.get("arriveBy") === "false"),
    ).toBe(true);
    expect(
      searched[0].searchParams.get("fromPlace")!.split(",").map(Number),
    ).toEqual([48, 11]);
    expect(
      searched[0].searchParams.get("toPlace")!.split(",").map(Number),
    ).toEqual([e.latitude, e.longitude]);
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "list",
    );
  });

test("editing during a delayed start check prevents late navigation activation", async ({
  page,
}) => {
  await setup(page, true, false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/v6/trip?*", async (r) => {
    requested = true;
    await gate;
    await r.fulfill({ json: { legs: [] } });
  });
  await startSelected(page);
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator("#navigation-start-notice")).toContainText(
    "Fahrtdaten werden geprüft",
  );
  await expect(page.locator("#navigation-view")).toBeHidden();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#route-editor")).toBeVisible();
  release();
  await page.clock.runFor(2000);
  await expect(page.locator("#navigation-view")).toBeHidden();
  expect(await savedActive(page)).toBe(false);
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#panel-details")).toBeVisible();
});

for (const width of [320, 390, 1280])
  for (const colorScheme of ["light", "dark"] as const)
    test(`arrival summary stays compact and freezes time at ${width}px in ${colorScheme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await setup(page);
      let searches = 0;
      await page.route("**/api/v6/plan?*", async (request) => {
        searches++;
        await request.fulfill({ json: { direct: [], itineraries: [] } });
      });
      await page.evaluate(async () => {
        const { supportProviders } = await import("/src/project-support.ts");
        for (const provider of supportProviders) provider.url = undefined;
      });
      await page.clock.runFor(90000);
      await complete(page);
      const panel = page.getByRole("article", { name: "Fahrtzusammenfassung" });
      await expect(panel).toBeVisible();
      await expect(page.locator("#navigation-finish-heading")).toBeFocused();
      await expect(page.locator("#navigation-finish-time")).toHaveText("2 min");
      await expect(page.locator("#navigation-finish-origin")).toHaveText(
        "Start",
      );
      await expect(page.locator("#navigation-finish-destination")).toHaveText(
        "Bahnhof",
      );
      await expect(page.locator("#navigation-finish-count")).toHaveText("1");
      await expect(page.locator("#navigation-finish-storage")).toBeEmpty();
      await expect(page.locator("#navigation-support")).toBeHidden();
      await expect(page.locator("#navigation-top")).toBeHidden();
      await expect(page.locator("#navigation-details-toggle")).toBeHidden();
      await expect
        .poll(() => page.evaluate(() => (window as any).navProbe.active))
        .toBe(0);
      await expect.poll(() => savedActive(page)).toBe(false);
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      if (width > 900) expect(bounds.x).toBeLessThan(40);
      await page.screenshot({ path: info.outputPath("arrival-summary.png") });
      await page.clock.runFor(120000);
      await expect(page.locator("#navigation-finish-time")).toHaveText("2 min");
      await expect(page.locator("#navigation-finish-count")).toHaveText("1");
      await page.locator("#navigation-finish-close").click();
      await expect(page.locator("#navigation-view")).toBeHidden();
      await expect(page.locator("#search-view")).toBeVisible();
      await expect(page.locator("#map-view")).toBeHidden();
      await expect(page.locator("#route-editor")).toBeHidden();
      await expect(page.locator("#destination")).toHaveValue("");
      await expect(page.locator("#search-heading")).toBeFocused();
      expect(new URL(page.url()).searchParams.has("from")).toBe(false);
      expect(await page.evaluate(() => history.state.navigation)).not.toBe(
        true,
      );
      expect(searches).toBe(0);
      if (width >= 390 && colorScheme === "light") {
        await page.screenshot({
          path: info.outputPath("home-after-finish.png"),
        });
        await page.reload();
        await expect(page.locator("#search-view")).toBeVisible();
        await expect(page.locator("#navigation-resume-dialog")).toBeHidden();
        await expect(page.locator("#destination")).toHaveValue("");
        expect(
          await page.evaluate(async () => {
            const { NavigationStore } =
              await import("/src/navigation-store.ts");
            return (await new NavigationStore().readStatistics()).statistics
              .completedIds.length;
          }),
        ).toBe(1);
        expect(searches).toBe(0);
      }
    });

test("arrival summary includes configured support providers and counts repeated routes", async ({
  page,
  browserName,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.evaluate(async () => {
    const { supportProviders } = await import("/src/project-support.ts");
    supportProviders[0].url = "https://ko-fi.com/foldroute-test";
    supportProviders[1].url = "https://github.com/sponsors/foldroute-test";
  });
  await complete(page);
  const support = page.getByRole("navigation", {
    name: "FoldRoute unterstützen",
  });
  await expect(support.getByRole("link")).toHaveCount(2);
  const koFi = support.getByRole("link", {
    name: "Halte FoldRoute am Rollen 💛 (über Ko-fi)",
  });
  await expect(koFi).toHaveAttribute(
    "href",
    "https://ko-fi.com/foldroute-test",
  );
  await expect(koFi).toContainText("Halte FoldRoute am Rollen 💛");
  await expect(
    support.getByRole("link", { name: "Über GitHub Sponsors unterstützen" }),
  ).toHaveAttribute("target", "_blank");
  await expect(
    support.getByRole("link", { name: "Über GitHub Sponsors unterstützen" }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const link of await support.getByRole("link").all()) {
      const bounds = (await link.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await link.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    await page.screenshot({
      path: info.outputPath(`arrival-support-${width}.png`),
    });
  }
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await page.keyboard.press(tab);
  await expect(koFi).toBeFocused();
  await page.keyboard.press(tab);
  await expect(
    support.getByRole("link", { name: "Über GitHub Sponsors unterstützen" }),
  ).toBeFocused();
  await page.keyboard.press(tab);
  await expect(page.locator("#navigation-finish-close")).toBeFocused();
  await expect(page.locator("#navigation-finish-count")).toHaveText("1");
  await page.locator("#navigation-finish-close").click();
  await expect(page.locator("#search-heading")).toBeFocused();
  await openCachedJourney(page, page.locator("#open-saved"));
  await startSelected(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await expect(page.locator("#navigation-finish")).toBeHidden();
  await complete(page);
  await expect(page.locator("#navigation-finish-count")).toHaveText("2");
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 667, height: 375 },
])
  test(`arrival summary supports 200% text, long names and a single provider at ${viewport.width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    const journey = route();
    journey.origin = {
      ...journey.origin,
      name: "Flughafen München Besucherzentrum",
    };
    journey.destination = {
      ...journey.destination,
      name: "Garching-Forschungszentrum, Haupteingang",
    };
    await setup(page, false, true, {}, journey);
    await page.evaluate(async () => {
      document.documentElement.style.fontSize = "32px";
      const { supportProviders } = await import("/src/project-support.ts");
      for (const provider of supportProviders) provider.url = undefined;
      supportProviders[1].url = "https://github.com/sponsors/foldroute-test";
    });
    await complete(page);
    await expect(page.locator("#navigation-finish-count")).toHaveText("1");
    await expect(page.locator("#navigation-support a")).toHaveCount(1);
    await expect(page.locator("#navigation-finish-close")).toBeInViewport();
    const panel = page.locator("#navigation-panel");
    expect(
      await panel.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const content = page.locator(".navigation-finish-content");
    expect(
      await content.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await content.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    await page.locator("#navigation-support a").focus();
    await expect(page.locator("#navigation-support a")).toBeInViewport();
    await expect(page.locator("#navigation-finish-close")).toBeInViewport();
    await page.screenshot({ path: info.outputPath("arrival-large-text.png") });
    await page.locator("#navigation-finish-close").click();
    await expect(page.locator("#navigation-view")).toBeHidden();
  });

test("arrival summary stays usable after statistics storage fails", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    NavigationStore.prototype.completeTrip = async () => {
      throw new Error("Storage unavailable");
    };
  });
  await complete(page);
  await expect(page.locator("#navigation-finish-storage")).toHaveText(
    "Gesamtstatistik konnte nicht gespeichert werden.",
  );
  await expect(page.locator("#navigation-finish-totals")).toBeHidden();
  await page.locator("#navigation-finish-close").click();
  await expect(page.locator("#search-heading")).toBeFocused();
  await expect.poll(() => savedActive(page)).toBe(false);
});

test("arrival summary obeys storage opt-out and early stops do not count", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  expect(
    await page.evaluate(async () => {
      const { NavigationStore } = await import("/src/navigation-store.ts");
      return (await new NavigationStore().readStatistics()).statistics
        .completedIds.length;
    }),
  ).toBe(0);
  await page.locator("#tab-settings").click();
  await expect(page.locator("#delete-navigation")).toBeDisabled();
  await expect(page.locator("#statistics-enabled").locator("..")).toContainText(
    "Fahrtstatistik",
  );
  await page.locator("#statistics-enabled").uncheck();
  await page.locator("#tab-route").click();
  await startSelected(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await expect(page.locator("#navigation-complete")).toBeVisible();
  await complete(page);
  await expect(page.locator("#navigation-finish-storage")).toHaveText(
    "Gesamtstatistik ist ausgeschaltet.",
  );
  await expect(page.locator("#navigation-finish-totals")).toBeHidden();
  await expect(page.locator("#navigation-finish-distance")).not.toBeEmpty();
});

test("arrival summary statistics are atomic across concurrent writers", async ({
  page,
}) => {
  await page.goto("/");
  const statistics = await page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    const store = new NavigationStore();
    const { epoch } = await store.readStatistics();
    const summary = {
      id: "one",
      originName: "A",
      destinationName: "B",
      arrivedAt: 1000,
      distanceMeters: 500,
      elapsedSeconds: 60,
      sinceResume: false,
      storageEpoch: epoch,
    };
    await Promise.all([
      new NavigationStore().completeTrip(summary),
      new NavigationStore().completeTrip(summary),
      new NavigationStore().completeTrip({ ...summary, id: "two" }),
    ]);
    return (await store.readStatistics()).statistics;
  });
  expect(statistics.completedIds).toHaveLength(2);
  expect(statistics.distanceMeters).toBe(1000);
  expect(statistics.elapsedSeconds).toBe(120);
});

for (const deletion of ["statistics", "all"] as const)
  test(`arrival summary statistics resist late writes after deleting ${deletion}`, async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async (deletion) => {
      const { NavigationStore } = await import("/src/navigation-store.ts");
      const { OfflineStore } = await import("/src/offline.ts");
      const { localDatabase } = await import("/src/storage.ts");
      const store = new NavigationStore();
      const { epoch } = await store.readStatistics();
      const summary = {
        id: "old",
        originName: "A",
        destinationName: "B",
        arrivedAt: 1000,
        distanceMeters: 500,
        elapsedSeconds: 60,
        sinceResume: false,
        storageEpoch: epoch,
      };
      await store.completeTrip(summary);
      const history = new OfflineStore();
      if (deletion === "statistics") await store.clearStatistics();
      if (deletion === "all") await localDatabase.clearAll();
      await new NavigationStore().completeTrip(summary);
      const afterDeletion = await store.readStatistics();
      await store.completeTrip({
        ...summary,
        id: "new",
        storageEpoch: afterDeletion.epoch,
      });
      return {
        afterDeletion,
        fresh: (await store.readStatistics()).statistics,
      };
    }, deletion);
    expect(result.afterDeletion.statistics.completedIds).toHaveLength(0);
    expect(result.afterDeletion.epoch).toBeGreaterThan(0);
    expect(result.fresh.completedIds).toEqual(["new"]);
  });

test("arrival summary stale checkpoints and dismissal preserve a newer navigation", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  const retained = await page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    const oldStore = new NavigationStore();
    const oldSnapshot = (await oldStore.read())!;
    await oldStore.clear();
    const fresh = structuredClone(oldSnapshot);
    fresh.trip!.id = "new-navigation";
    fresh.resumeEpoch = (await oldStore.readStatistics()).resumeEpoch;
    await new NavigationStore().save(fresh);
    await oldStore.save(oldSnapshot);
    await oldStore.clear(oldSnapshot.trip!.id);
    return (await new NavigationStore().read())?.trip?.id;
  });
  expect(retained).toBe("new-navigation");
});

test("arrival summary totals can be deleted after removing every history entry", async ({
  page,
}) => {
  await setup(page);
  await complete(page);
  await expect(page.locator("#navigation-finish-count")).toHaveText("1");
  await page.locator("#navigation-finish-close").click();
  await expect(page.locator("#search-heading")).toBeFocused();
  await page.locator("#tab-history").click();
  await page.locator(".history-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".history-row")).toHaveCount(0);
  await page.locator("#tab-settings").click();
  await page.locator("#settings-data > summary").click();
  await expect(page.locator("#delete-saved")).toBeDisabled();
  await expect(page.locator("#delete-statistics")).toBeEnabled();
  await page.locator("#delete-statistics").click();
  await expect(page.locator("#delete-storage-dialog")).toContainText(
    "Fahrtstatistik",
  );
  await page.locator("#confirm-delete-storage").click();
  await expect(page.locator("#delete-statistics")).toBeDisabled();
  expect(
    await page.evaluate(async () => {
      const { NavigationStore } = await import("/src/navigation-store.ts");
      return (await new NavigationStore().readStatistics()).statistics
        .completedIds.length;
    }),
  ).toBe(0);
});

test("arrival summary gives legacy snapshots one random identity across concurrent resumes", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  const result = await page.evaluate(async () => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    const store = new NavigationStore();
    const snapshot = (await store.read())!;
    delete snapshot.trip;
    delete snapshot.sessionId;
    snapshot.journey.id = "route-with-coordinates-48.0-11.0";
    await store.save(snapshot);
    const [first, second] = await Promise.all([
      new NavigationStore().read(),
      new NavigationStore().read(),
    ]);
    const { epoch } = await store.readStatistics();
    await store.completeTrip({
      id: first!.sessionId!,
      originName: "A",
      destinationName: "B",
      arrivedAt: 1000,
      distanceMeters: 500,
      elapsedSeconds: 60,
      sinceResume: true,
      storageEpoch: epoch,
    });
    return {
      firstId: first!.sessionId,
      secondId: second!.sessionId,
      statistics: (await store.readStatistics()).statistics,
      active: await store.read(),
    };
  });
  expect(result.firstId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(result.secondId).toBe(result.firstId);
  expect(result.statistics.completedIds).toEqual([result.firstId]);
  expect(result.active).toBeUndefined();
});
