import { test, expect, type Page } from "./test";
import {
  setup,
  complete,
  stationJourney,
  savedProgress,
  now,
} from "./navigation-fixture";
import { distance } from "../../src/geometry";
import { NavigationPath } from "../../src/navigation-estimate";
import { projectPath } from "../../src/navigation-engine";

async function position(page: Page) {
  return page
    .locator("#navigation-map")
    .evaluate((element) => JSON.parse(element.dataset.position!));
}
async function push(
  page: Page,
  latitude: number,
  longitude: number,
  accuracy = 70,
) {
  await page.clock.runFor(1000);
  await page.evaluate(
    ({ latitude, longitude, accuracy }) => {
      (window as any).navProbe.push(latitude, longitude, 90, accuracy);
    },
    { latitude, longitude, accuracy },
  );
}

for (const reducedMotion of ["reduce", "no-preference"] as const)
  test(`transit GPS corrections follow the curve with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    const journey = stationJourney();
    const train = journey.legs[2];
    delete train.transitReference;
    train.coordinates = [
      train.from,
      { latitude: train.from.latitude, longitude: train.to.longitude },
      train.to,
    ];
    await setup(page, true, true, {}, journey);
    await complete(page);
    await complete(page);
    await page.clock.pauseAt(new Date((now + 350) * 1000));
    await push(page, train.from.latitude, train.from.longitude);
    await page.clock.runFor(2100);
    await push(page, train.to.latitude, train.to.longitude);
    if (reducedMotion === "reduce") {
      expect(distance(await position(page), train.to)).toBeLessThan(0.1);
    } else {
      for (let i = 0; i < 3; i++) {
        await page.clock.runFor(500);
        const point = await position(page);
        expect(projectPath(point, train.coordinates).distance).toBeLessThan(
          0.1,
        );
        expect(distance(point, train.from)).toBeGreaterThan(1);
        expect(distance(point, train.to)).toBeGreaterThan(1);
      }
      await page.clock.runFor(600);
      expect(distance(await position(page), train.to)).toBeLessThan(0.1);
    }
  });

test("GPS circle drifts independently while the bike marker stays pinned", async ({
  page,
}) => {
  await setup(page);
  const map = page.locator("#navigation-map");
  const before = await savedProgress(page);
  for (const latitude of [48.00045, 47.99955]) {
    await push(page, latitude, 11.001);
    await expect(map).toHaveAttribute("data-position-source", "gps");
    await expect(map).toHaveAttribute("data-position-matched", "true");
    expect(
      distance(await position(page), { latitude: 48, longitude: 11.001 }),
    ).toBeLessThan(0.1);
    const circle = JSON.parse(
      (await map.getAttribute("data-accuracy-position"))!,
    );
    expect(circle).toEqual({ latitude, longitude: 11.001 });
    expect(Number(await map.getAttribute("data-accuracy-radius"))).toBeCloseTo(
      70 / Math.cos((latitude * Math.PI) / 180),
      5,
    );
  }
  expect(await savedProgress(page)).toEqual(before);
  await page.screenshot({
    path: test.info().outputPath("pinned-gps-drift.png"),
  });
});

test("three fresh outliers release the marker and a matching fix reattaches it", async ({
  page,
}) => {
  await setup(page);
  await push(page, 48.00045, 11.001);
  const pinned = await position(page);
  const map = page.locator("#navigation-map");
  for (let i = 0; i < 2; i++) {
    await push(page, 47.9985, 11.001);
    expect(await position(page)).toEqual(pinned);
    await expect(map).toHaveAttribute("data-position-source", "last-known");
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "Standort wird geprüft",
    );
  }
  await push(page, 47.9985, 11.001);
  await expect(map).toHaveAttribute("data-position-source", "gps");
  await expect(map).toHaveAttribute("data-position-matched", "false");
  expect(await position(page)).toMatchObject({
    latitude: 47.9985,
    longitude: 11.001,
  });
  await push(page, 48.00045, 11.001);
  await expect(map).toHaveAttribute("data-position-matched", "true");
  await expect(page.locator("#navigation-gps-status")).toBeHidden();
});

test("foreground recovery waits for a fresh fix and can reacquire farther along the route", async ({
  page,
}) => {
  await setup(page);
  await push(page, 48.00045, 11.001);
  await page.evaluate(() => {
    (window as any).navProbe.silent = true;
    (window as any).navProbe.hide(true);
  });
  await page.clock.fastForward(70000);
  await page.evaluate(() => (window as any).navProbe.hide(false));
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-position-source",
    "last-known",
  );
  await page.evaluate(() =>
    (window as any).navProbe.push(48.0017, 11.0024, 0, 70, 70000),
  );
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-position-source",
    "last-known",
  );
  await push(page, 48.0017, 11.0024);
  expect(
    distance(await position(page), { latitude: 48.0017, longitude: 11.002 }),
  ).toBeLessThan(0.1);
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-position-matched",
    "true",
  );
});

test("transit drift, held outliers and timetable estimates share the map source and badge", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const journey = stationJourney();
  delete journey.legs[2].transitReference;
  await setup(page, true, true, {}, journey);
  await complete(page);
  await complete(page);
  await page.clock.pauseAt(new Date((now + 350) * 1000));
  const path = new NavigationPath(journey.legs[2].coordinates);
  const target = path.at(40).point;
  await push(page, target.latitude + 0.0002, target.longitude - 0.0002);
  const map = page.locator("#navigation-map");
  await expect(map).toHaveAttribute("data-position-source", "gps");
  await expect(map).toHaveAttribute("data-position-matched", "true");
  const before = await savedProgress(page);
  const pinned = await position(page);
  for (let i = 0; i < 2; i++) {
    await push(page, 48.02, 11.02);
    await expect(map).toHaveAttribute("data-position-source", "last-known");
    expect(await position(page)).toEqual(pinned);
    await expect(page.locator("#navigation-gps-status")).not.toContainText(
      "Kartenposition geschätzt",
    );
  }
  await push(page, 48.02, 11.02);
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await expect(page.locator("#navigation-gps-status")).toContainText(
    "Kartenposition geschätzt",
  );
  expect(await savedProgress(page)).toEqual(before);
  await push(page, target.latitude, target.longitude);
  await expect(map).toHaveAttribute("data-position-source", "gps");
  await push(page, target.latitude, target.longitude, 500);
  await expect(map).toHaveAttribute("data-position-source", "estimated");
  await expect(page.locator("#navigation-gps-status")).toHaveText(
    "GPS ungenau Kartenposition geschätzt",
  );
});
