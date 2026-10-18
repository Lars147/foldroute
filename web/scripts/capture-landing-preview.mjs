import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import {
  comparisonURL,
  previewPlannerModule,
  validateComparisonFixture,
} from "./landing-preview-data.mjs";

const recording = JSON.parse(
  await readFile(
    new URL("../src/data/bike-transfer.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(recording.journey.arrival - recording.journey.departure, 57 * 60);
const comparisonFile = new URL(
  "../tests/fixtures/landing-preview-direct.json",
  import.meta.url,
);
const planner = new URL(process.argv[2] ?? "http://127.0.0.1:4173/");
planner.search = new URLSearchParams({
  v: "3",
  from: `${recording.request.origin.latitude},${recording.request.origin.longitude}`,
  fromName: recording.request.origin.name,
  to: `${recording.request.destination.latitude},${recording.request.destination.longitude}`,
  toName: recording.request.destination.name,
  timing: recording.request.timing,
  time: new Date(recording.request.time * 1000).toISOString(),
}).toString();

const browser = await chromium.launch({
  args: process.env.FOLDROUTE_CAPTURE_HOST_RULES
    ? [`--host-resolver-rules=${process.env.FOLDROUTE_CAPTURE_HOST_RULES}`]
    : [],
});
const screenshots = [];
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    reducedMotion: "reduce",
    timezoneId: "Europe/Berlin",
    serviceWorkers: "block",
  });
  const needsComparisonRecording = !existsSync(comparisonFile);
  let comparison;
  if (needsComparisonRecording) {
    const url = comparisonURL(recording);
    const response = await context.request.get(url.href, { timeout: 20000 });
    assert(
      response.ok(),
      `Cycling comparison request failed: HTTP ${response.status()}`,
    );
    comparison = {
      capturedAt: new Date().toISOString(),
      source: url.href,
      request: recording.request,
      settings: recording.settings,
      response: await response.json(),
    };
  } else {
    comparison = JSON.parse(await readFile(comparisonFile, "utf8"));
  }
  validateComparisonFixture(recording, comparison);
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(recording.request.time * 1000));
  await page.addInitScript(
    ({ settings, origin }) => {
      localStorage.setItem("foldroute.routing.v3", JSON.stringify(settings));
      // Only the isolated capture browser receives a fixed, simulated position.
      const position = () => ({
        coords: {
          latitude: origin.latitude,
          longitude: origin.longitude,
          accuracy: 5,
          heading: 0,
          speed: 0,
        },
        timestamp: Date.now(),
      });
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: { query: async () => ({ state: "granted", onchange: null }) },
      });
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition: (success) => success(position()),
          watchPosition: (success) => {
            queueMicrotask(() => success(position()));
            return 1;
          },
          clearWatch: () => {},
        },
      });
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: { getVoices: () => [], speak: () => {}, cancel: () => {} },
      });
    },
    { settings: recording.settings, origin: recording.request.origin },
  );
  // Only the capture browser replaces the planning module. The real UI and
  // navigation render the recorded journeys without adding production hooks.
  await page.route("**/src/planner.ts", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: previewPlannerModule(recording, comparison),
    }),
  );
  await page.route("https://api.transitous.org/**", (route) => route.abort());
  await page.goto(planner.href);
  await expect(page.locator(".route-choice").first()).toBeVisible();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator(".route-choice")).toHaveCount(2);
  const selected = page.locator(
    `.route-choice[data-journey="${recording.journey.id}"]`,
  );
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(selected).toContainText("Früheste Ankunft");
  await expect(selected).toContainText("S8");
  await expect(selected).toContainText("U6");
  const clock = (seconds) =>
    new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(seconds * 1000));
  await expect(selected.locator(".route-choice-arrival")).toHaveText(
    `${clock(recording.journey.arrival)} an`,
  );
  await expect(
    page.locator('.route-choice[aria-pressed="false"] .route-choice-arrival'),
  ).toContainText(
    `${clock(Date.parse(comparison.response.direct[0].endTime) / 1000)} an`,
  );
  await expect(page.locator("#navigation-start")).toBeVisible();
  await expect(page.locator(".app-tabs")).toBeVisible();
  await expect(page.locator(".app-tabs > button .app-tab-label")).toHaveText([
    "Route",
    "Verlauf",
    "Einstellungen",
  ]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  async function capture(name) {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" || animation.pending,
              ).length,
        ),
      )
      .toBe(0);
    await page.evaluate(() => document.fonts.ready);
    const output = new URL(`../../docs/assets/${name}.png`, import.meta.url);
    screenshots.push({
      output,
      data: await page.screenshot({ animations: "disabled" }),
    });
  }
  await capture("webplaner-vorschau");
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await capture("webplaner-reiseablauf");
  await page.locator("#panel-map-toggle").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#panel-content")).toBeHidden();
  await expect(page.locator("#map-error")).toBeHidden();
  await capture("webplaner-karte");
  // Observe the real map's render completion in the isolated capture runtime.
  // The production app needs no screenshot-specific hooks or visual changes.
  await page.evaluate(async () => {
    const { NavigationMap } = await import("/src/navigation-map.ts");
    const { TransitRefresher } = await import("/src/transit-refresh.ts");
    // Replay the recorded timetable without inventing live delays or changing
    // journey times. The capture has no real trip IDs or live API requests.
    TransitRefresher.prototype.refresh = async function (legs, signal) {
      signal.throwIfAborted();
      return new Map(
        legs
          .filter((leg) => leg.kind === "transit")
          .map((leg) => [
            leg.navigationId,
            {
              kind: "updated",
              update: {
                departure: leg.start,
                arrival: leg.end,
                platform: leg.platform,
                arrivalPlatform: leg.arrivalPlatform,
                realtime: false,
                cancelled: false,
                updatedAt: Date.now() / 1000,
              },
            },
          ]),
      );
    };
    const update = NavigationMap.prototype.update;
    NavigationMap.prototype.update = function (...args) {
      update.apply(this, args);
      window.captureNavigationMap = this.map;
    };
  });
  await page.locator("#map-open-details").click();
  await page.locator("#navigation-start").click();
  await expect(page.locator("#navigation-view")).toBeVisible();
  await expect(page.locator("#navigation-remaining")).not.toBeEmpty();
  await expect(page.locator("#navigation-instruction")).not.toHaveText(
    /Navigation wird vorbereitet|Navigation konnte nicht starten/,
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.captureNavigationMap
              ?.getLayers()
              .item(0)
              .getLayers()
              .getLength() ?? 0,
        ),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const map = window.captureNavigationMap;
        const timeout = setTimeout(
          () => reject(new Error("Navigation map did not finish rendering")),
          20000,
        );
        map.once("rendercomplete", () => {
          clearTimeout(timeout);
          requestAnimationFrame(resolve);
        });
        map.render();
      }),
  );
  await expect(page.locator("#navigation-map")).not.toHaveAttribute(
    "data-tile-error",
    "true",
  );
  await expect(page.locator("#navigation-alert")).toBeHidden();
  await capture("webplaner-navigation");
  await context.close();
  if (needsComparisonRecording) {
    await writeFile(comparisonFile, JSON.stringify(comparison, null, 2) + "\n");
  }
  // Writing under docs/ triggers a Vite reload. Save only after all views were
  // captured and the browser context is closed, so later shots retain state.
  for (const { output, data } of screenshots) {
    await writeFile(output, data);
    console.log(`Screenshot saved to ${output.pathname}`);
  }
} finally {
  await browser.close();
}
