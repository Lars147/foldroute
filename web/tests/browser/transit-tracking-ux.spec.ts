import { expect, test } from "./test";
import {
  complete,
  now,
  savedProgress,
  setup,
  stationJourney,
} from "./navigation-fixture";

test("station tracking keeps running when the navigation map cannot load", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/src/navigation-map.ts*", (route) => route.abort());
  const journey = stationJourney();
  delete journey.legs[2].transitReference;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-load-error",
    "true",
  );
  await page.clock.pauseAt(new Date((now + 450) * 1000));
  await expect(page.locator("#navigation-stations-announcement")).toContainText(
    "Nächster Halt: Rathaus",
  );
  const before = await savedProgress(page);
  await page.clock.fastForward(51000);
  await expect(page.locator("#navigation-stations-announcement")).toContainText(
    "Nächster Halt: Ausstieg",
  );
  expect(await savedProgress(page)).toEqual(before);
});

test("an unusable future station projection uses a schematic map without freezing the tracker", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = stationJourney(),
    train = journey.legs[2];
  delete train.transitReference;
  train.transitStops = structuredClone(train.transitStops);
  train.transitStops![2].latitude += 0.015;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  await page.clock.pauseAt(new Date((now + 450) * 1000));
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-position-precision",
    "schematic",
  );
  await expect(page.locator("#navigation-gps-estimate")).toHaveText(
    "Kartenposition grob geschätzt",
  );
  await expect(page.locator("#navigation-stations-announcement")).toContainText(
    "Nächster Halt: Rathaus",
  );
  await page.clock.fastForward(51000);
  await expect(page.locator("#navigation-stations-announcement")).toContainText(
    "Nächster Halt: Ausstieg",
  );
});

test("estimated arrival keeps the train active and exposes manual exit in the compact panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = stationJourney();
  delete journey.legs[2].transitReference;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.fail(2);
  });
  await page.clock.pauseAt(new Date((now + 601) * 1000));
  await expect(page.locator("#navigation-station-status")).toContainText(
    "Ausstieg laut Fahrzeiten erreicht",
  );
  if (await page.locator("#navigation-details").isVisible())
    await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  const exit = page.locator("#navigation-quick-actions #navigation-complete");
  await expect(exit).toHaveText("Ausgestiegen");
  await expect(exit).toBeInViewport();
  await exit.click();
  await expect(page.locator("#navigation-confirm")).toBeVisible();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt entfalten",
  );
});

test("network recovery refreshes current trip without waiting through network-error backoff", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, true, true, {}, stationJourney());
  await complete(page);
  await complete(page);
  await page.route("**/api/v6/trip?*", (route) => route.abort("failed"));
  await page.clock.fastForward(61000);
  await expect(page.locator("#navigation-transit-status")).toContainText(
    "Abruf fehlgeschlagen",
  );
  let recoveredRequests = 0;
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  await page.route("**/api/v6/trip?*", (route) => {
    recoveredRequests++;
    return route.fulfill({
      json: {
        legs: [
          {
            from: {
              stopId: "A",
              scheduledDeparture: iso(now + 300),
              departure: iso(now + 300),
            },
            to: {
              stopId: "D",
              scheduledArrival: iso(now + 600),
              arrival: iso(now + 660),
            },
            realTime: true,
          },
        ],
      },
    });
  });
  await context.setOffline(true);
  await context.setOffline(false);
  await expect.poll(() => recoveredRequests).toBe(1);
  await expect(page.locator("#navigation-transit-status")).not.toContainText(
    "Abruf fehlgeschlagen",
  );
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const { NavigationStore } = await import("/src/navigation-store.ts");
          return (await new NavigationStore().read())?.journey.legs[2].end;
        }),
    )
    .toBe(now + 660);
  for (const id of [
    "navigation-stations-preview",
    "navigation-stations-detail",
  ])
    await expect(
      page.locator(`#${id} .navigation-station`).last().locator("time"),
    ).toHaveText("12:11");
});

for (const width of [390, 1280]) {
  test(`next stop stays through arrival and dwell until GPS confirms departure (${width}px)`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const journey = stationJourney();
    delete journey.legs[2].transitReference;
    await setup(page, true, true, {}, journey);
    await complete(page);
    await complete(page);
    await page.evaluate(() => {
      (window as any).navProbe.silent = true;
    });
    const stops = journey.legs[2].transitStops!;
    const announcement = page.locator("#navigation-stations-announcement");
    const push = async (fraction: number) => {
      await page.clock.runFor(1000);
      await page.evaluate(
        ({ a, b, fraction }) => {
          (window as any).navProbe.push(
            a.latitude + (b.latitude - a.latitude) * fraction,
            a.longitude + (b.longitude - a.longitude) * fraction,
          );
        },
        { a: stops[1], b: stops[2], fraction },
      );
    };
    for (const fraction of [-0.3, -0.2, 0, 0.04, -0.03, 0, 0]) {
      await push(fraction);
    }
    await expect(announcement).toContainText("Nächster Halt: Stadtmitte");
    await expect(announcement).toContainText("Noch 3 Halte");
    await expect(page.locator("#navigation-gps-status")).toBeHidden();
    await expect
      .poll(async () => (await savedProgress(page))?.transitDepartedStop)
      .toContain("A");
    if (width < 900 && (await page.locator("#navigation-details").isVisible()))
      await page.locator("#navigation-details-toggle").click();
    const visibleList = page.locator(
      '.navigation-stations[data-active="true"]:visible',
    );
    await expect(visibleList).toContainText("Stadtmitte");
    await expect(visibleList).toContainText("Ausstieg in 3 Halten");
    // Frequent, small movements must accumulate into a departure.
    for (const fraction of [0.2, 0.4, 0.7, 0.75]) await push(fraction);
    await expect(announcement).toContainText("Nächster Halt: Rathaus");
    await expect(visibleList).toContainText("Ausstieg in 2 Halten");
    await expect
      .poll(async () => (await savedProgress(page))?.transitDepartedStop)
      .toContain("station-1");
    // Approaching the following station must not immediately advance again.
    await push(1);
    await push(1);
    await expect(announcement).toContainText("Nächster Halt: Rathaus");
    await page.evaluate(() => {
      (window as any).navProbe.fail(2);
    });
    await page.clock.pauseAt(new Date((now + 550) * 1000));
    await expect(announcement).toContainText("Nächster Halt: Ausstieg");
    await expect(page.locator("#navigation-gps-status")).toContainText(
      "geschätzt",
    );
    await expect(page.locator("#navigation-station-status")).toBeEmpty();
    await expect(visibleList).not.toContainText(/geschätzt|Voraussichtlich/);
    await expect
      .poll(async () => (await savedProgress(page))?.transitDepartedStop)
      .toContain("station-1");
  });
}
