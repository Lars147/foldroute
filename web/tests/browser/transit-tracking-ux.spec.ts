import { expect, test } from "@playwright/test";
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
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Rathaus",
  );
  const before = await savedProgress(page);
  await page.clock.fastForward(51000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
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
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "Nächster Halt: Rathaus",
  );
  await page.clock.fastForward(51000);
  await expect(page.locator("#navigation-context-title")).toHaveText(
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
  await expect(page.locator("#navigation-context-status")).toContainText(
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
  await expect(page.locator("#navigation-context-status")).toContainText(
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
  await expect(page.locator("#navigation-context-status")).not.toContainText(
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
