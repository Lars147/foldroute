import { test, expect, type Page } from "./test";
import { a, b, d, encoded, now, route, setup } from "./navigation-fixture";
import { distance } from "../../src/geometry";

const date = (offset: number) => new Date((now + offset) * 1000).toISOString();
const destination = {
  name: "Stadtmuseum",
  detail: "",
  latitude: 48.057,
  longitude: 11.002,
};

async function ride(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const journey = route();
  const leg = journey.legs[0];
  journey.destination = leg.to = destination;
  leg.coordinates = [a, b, destination];
  leg.end = journey.arrival = now + 1800;
  leg.distance = distance(a, b) + distance(b, destination);
  leg.maneuvers![1].coordinates = [b, destination];
  leg.maneuvers![1].distance = distance(b, destination);
  await setup(page, false, true, {}, journey);
  if (width < 900) await page.locator("#navigation-details-toggle").click();
}

function itinerary(line: string, arrival: number) {
  const access = [
    [a.latitude, a.longitude],
    [b.latitude, b.longitude],
  ];
  return {
    id: line,
    transfers: 0,
    legs: [
      {
        mode: "WALK",
        startTime: date(180),
        endTime: date(210),
        distance: 149,
        from: { name: "START", lat: a.latitude, lon: a.longitude },
        to: { name: "Nordbahnhof", lat: b.latitude, lon: b.longitude },
        legGeometry: { points: encoded(access), precision: 5 },
      },
      {
        mode: "BUS",
        routeShortName: line,
        headsign: "Stadtmitte",
        startTime: date(380),
        endTime: date(arrival),
        scheduledStartTime: date(380),
        scheduledEndTime: date(arrival),
        realTime: true,
        from: {
          name: "Nordbahnhof",
          lat: b.latitude,
          lon: b.longitude,
          stopId: "B",
        },
        to: {
          name: "END",
          lat: destination.latitude,
          lon: destination.longitude,
          stopId: "C",
        },
        legGeometry: {
          points: encoded([
            [b.latitude, b.longitude],
            [d.latitude, d.longitude],
            [destination.latitude, destination.longitude],
          ]),
          precision: 5,
        },
      },
    ],
  };
}

async function mockRoutes(page: Page, options: ReturnType<typeof itinerary>[]) {
  let requests = 0;
  await page.route("**/api/v6/plan?*", (request) => {
    requests++;
    const params = new URL(request.request().url()).searchParams;
    return request.fulfill({
      json: {
        itineraries: params.get("preTransitModes") === "WALK" ? options : [],
        direct: [],
      },
    });
  });
  return () => requests;
}

for (const width of [390, 1280]) {
  test(`compares faster transit only after a request and confirms the switch at ${width}px`, async ({
    page,
  }, info) => {
    const requests = await mockRoutes(page, [
      itinerary("Bus 21", 720),
      itinerary("Bus 24", 900),
      itinerary("Bus 90", 1900),
    ]);
    await ride(page, width);
    const compare = page.getByRole("button", {
      name: "Verbindungen vergleichen",
    });
    const dialog = page.getByRole("dialog", {
      name: "Verbindungen vergleichen",
    });
    await expect(compare).toBeVisible();
    expect(requests()).toBe(0);
    if (width === 390)
      await page.screenshot({ path: info.outputPath("compare-entry.png") });

    await compare.click();
    await expect(dialog.locator(".route-choice")).toHaveCount(2);
    await expect(dialog).toContainText("Bisherige Route: Ankunft 12:30");
    await expect(dialog).toContainText("früher am Ziel");
    await expect(dialog).not.toContainText("Bus 90");
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
    if (width === 390)
      await page.screenshot({ path: info.outputPath("compare-results.png") });

    await dialog.getByRole("button", { name: "Bisherige behalten" }).click();
    await expect(dialog).toBeHidden();
    await expect(compare).toBeFocused();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );

    await compare.click();
    await dialog.getByRole("button", { name: /Alternative 2:/ }).click();
    await expect(
      dialog.locator(".route-choice[aria-pressed=true]"),
    ).toContainText("Bus 24");
    await dialog.getByRole("button", { name: "Verbindung übernehmen" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: /Bus 24/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Bus 21/ })).toHaveCount(0);
  });
}

test("empty comparison leaves the ride active and can be retried", async ({
  page,
}) => {
  await mockRoutes(page, [itinerary("Bus 90", 1900)]);
  await ride(page, 390);
  await page.getByRole("button", { name: "Verbindungen vergleichen" }).click();
  const dialog = page.getByRole("dialog", { name: "Verbindungen vergleichen" });
  await expect(dialog.getByRole("status")).toHaveText(
    "Keine schnellere ÖPNV-Verbindung gefunden.",
  );
  await expect(
    dialog.getByRole("button", { name: "Verbindung übernehmen" }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Erneut suchen" }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
});

test("advancing GPS expires a proposal and refresh still requires confirmation", async ({
  page,
}) => {
  const requests = await mockRoutes(page, [itinerary("Bus 21", 720)]);
  await ride(page, 390);
  await page.getByRole("button", { name: "Verbindungen vergleichen" }).click();
  const dialog = page.getByRole("dialog", { name: "Verbindungen vergleichen" });
  await expect(
    dialog.getByRole("button", { name: "Verbindung übernehmen" }),
  ).toBeEnabled();
  const firstSearch = requests();
  await page.clock.runFor(6000);
  await page.evaluate(() => window.navProbe.push(48, 11.0009, 90));

  await expect(page.locator("#navigation-distance")).toHaveText("80 m");
  await dialog
    .getByRole("button", { name: "Vorschläge aktualisieren" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Verbindung übernehmen" }),
  ).toBeEnabled();
  expect(requests()).toBeGreaterThan(firstSearch);
  await expect(page.getByRole("tab", { name: /Bus 21/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Verbindung übernehmen" }).click();
  await expect(page.getByRole("tab", { name: /Bus 21/ })).toBeVisible();
});
