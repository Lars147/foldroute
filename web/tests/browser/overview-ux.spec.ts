import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, width = 1100) {
  await page.setViewportSize({ width, height: 986 });
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/src/map-view.ts";
    const { RouteMap } = await import(path);
    const point = (latitude: number, longitude: number) => ({
      latitude,
      longitude,
      name: "Ort",
      detail: "",
    });
    const origin = point(48.13, 11.57),
      destination = point(48.15, 11.65);
    const journey = (id: string, via: ReturnType<typeof point>) => ({
      id,
      origin,
      destination,
      departure: 1000,
      arrival: 2000,
      transfers: 0,
      isDirect: true,
      legs: [
        {
          kind: "bike",
          from: origin,
          to: destination,
          start: 1000,
          end: 2000,
          distance: 1000,
          coordinates: [origin, via, destination],
        },
      ],
    });
    const journeys = [
      journey("north", point(48.2, 11.6)),
      journey("south", point(48.08, 11.6)),
    ];
    document.getElementById("search-view")!.hidden = true;
    document.getElementById("map-view")!.hidden = false;
    const panel = document.getElementById("journey-panel")!;
    panel.style.height = "240px";
    const view = new RouteMap(
      () => {},
      () => {},
    );
    const fixture = {
      view,
      journeys,
      selected: journeys[0],
      context: "first",
      show() {
        view.show(this.journeys, this.selected, false, this.context);
      },
    };
    (window as any).overviewTest = fixture;
    fixture.show();
    document.getElementById("map-route")!.onclick = () => view.fitRoute();
  });
  await expect(page.locator(".route-marker")).toHaveCount(2);
}
async function camera(page: Page) {
  return page.evaluate(() => {
    const map = (window as any).overviewTest.view.map;
    return { center: map.getCenter(), zoom: map.getZoom() };
  });
}
async function allVisible(page: Page) {
  return page.evaluate(() => {
    const { view, journeys } = (window as any).overviewTest;
    return journeys
      .flatMap((j: any) => [
        j.origin,
        j.destination,
        ...j.legs.flatMap((l: any) => l.coordinates),
      ])
      .every((p: any) =>
        view.overviewArea.contains(
          view.map.latLngToContainerPoint([p.latitude, p.longitude]),
        ),
      );
  });
}
for (const width of [390, 1100]) {
  test(`shared overview stays fixed when selecting alternatives at ${width}`, async ({
    page,
  }, testInfo) => {
    await setup(page, width);
    await expect.poll(() => allVisible(page)).toBe(true);
    const initial = await camera(page);
    await page.evaluate(() => {
      const f = (window as any).overviewTest;
      f.selected = f.journeys[1];
      f.show();
    });
    expect(await camera(page)).toEqual(initial);
    await expect(page.locator("#map-route")).toHaveAccessibleName(
      "Alle Routen anzeigen",
    );
    await page.screenshot({ path: testInfo.outputPath("shared-overview.png") });
  });
}

test("geometry updates expand the overview without shrinking it when an alternative disappears", async ({
  page,
}) => {
  await setup(page);
  const initial = await camera(page);
  await page.evaluate(() => {
    const f = (window as any).overviewTest;
    const middle = f.journeys[0].legs[0].coordinates[1];
    middle.latitude += 0.000001;
    f.show();
  });
  expect(await camera(page)).toEqual(initial);
  await page.evaluate(() => {
    const f = (window as any).overviewTest;
    f.journeys[0].legs[0].coordinates[1].latitude = 49;
    f.show();
  });
  await expect.poll(() => allVisible(page)).toBe(true);
  const expanded = await camera(page);
  expect(expanded).not.toEqual(initial);
  await page.evaluate(() => {
    const f = (window as any).overviewTest;
    f.journeys = [f.journeys[1]];
    f.selected = f.journeys[0];
    f.show();
  });
  expect(await camera(page)).toEqual(expanded);
  await page.locator("#map-route").click();
  expect(await camera(page)).not.toEqual(expanded);
  await expect.poll(() => allVisible(page)).toBe(true);
  await expect(page.locator("#map-route")).toHaveAccessibleName(
    "Gesamte Route anzeigen",
  );
});

test("manual camera survives selection and new geometry until overview or a new result set", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    (window as any).overviewTest.view.map.panBy([110, 80], { animate: false }),
  );
  const manual = await camera(page);
  await page.evaluate(() => {
    const f = (window as any).overviewTest;
    f.selected = f.journeys[1];
    f.journeys[0].legs[0].coordinates[1].latitude = 49;
    f.show();
    document.getElementById("journey-panel")!.dataset.size = "expanded";
    f.view.resize();
  });
  expect(await camera(page)).toEqual(manual);
  await page.locator("#map-route").click();
  await expect.poll(() => allVisible(page)).toBe(true);
  await page.evaluate(() =>
    (window as any).overviewTest.view.map.panBy([110, 80], { animate: false }),
  );
  await page.evaluate(() => {
    const f = (window as any).overviewTest;
    f.journeys[0].legs[0].coordinates[1].latitude = 48.2;
    f.context = "new-calculation";
    f.show();
  });
  await expect.poll(() => allVisible(page)).toBe(true);
});
