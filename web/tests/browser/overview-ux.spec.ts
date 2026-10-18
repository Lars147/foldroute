import { test, expect, type Page } from "@playwright/test";

async function setup(
  page: Page,
  width = 1100,
  height = 986,
  shape: "tall" | "wide" | "grouped" = "tall",
) {
  await page.setViewportSize({ width, height });
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await page.evaluate(async (shape) => {
    const path = "/src/map-view.ts";
    const { RouteMap } = await import(path);
    const point = (latitude: number, longitude: number) => ({
      latitude,
      longitude,
      name: "Ort",
      detail: "",
    });
    const origin = point(48.13, shape === "tall" ? 11.57 : 11),
      destination = point(48.15, shape === "tall" ? 11.65 : 12.4);
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
        ...(shape === "grouped" && id === "north"
          ? [1, 2].map(() => ({
              kind: "stop",
              from: destination,
              to: destination,
              start: 1000,
              end: 2000,
              distance: 0,
              coordinates: [],
            }))
          : []),
      ],
    });
    const journeys = [
      journey(
        "north",
        shape === "tall" ? point(48.2, 11.6) : point(48.16, 11.7),
      ),
      journey(
        "south",
        shape === "tall" ? point(48.08, 11.6) : point(48.12, 11.7),
      ),
    ];
    document.getElementById("search-view")!.hidden = true;
    document.getElementById("map-view")!.hidden = false;
    const panel = document.getElementById("journey-panel")!;
    panel.style.height = "240px";
    document.getElementById("map-view")!.dataset.resultScreen = "map";
    for (const id of [
      "map",
      "map-controls",
      "map-style-control",
      "map-route",
      "map-location",
    ]) {
      document.getElementById(id)!.inert = false;
      document.getElementById(id)!.style.visibility = "visible";
    }
    document.getElementById("map")!.style.visibility = "visible";
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
  }, shape);
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

async function expectClearOverview(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const mapBounds = document
          .getElementById("map")!
          .getBoundingClientRect();
        const panel = document
          .getElementById("journey-panel")!
          .getBoundingClientRect();
        const controls = document
          .getElementById("map-controls")!
          .getBoundingClientRect();
        const safe = getComputedStyle(document.getElementById("map-view")!);
        const sidebar =
          innerWidth >= 900 ||
          safe.getPropertyValue("--map-panel-layout").trim() === "side";
        const left = sidebar
          ? panel.right
          : mapBounds.left + parseFloat(safe.paddingLeft);
        const top = mapBounds.top + parseFloat(safe.paddingTop);
        const bottom = sidebar
          ? mapBounds.bottom - parseFloat(safe.paddingBottom)
          : panel.top;
        const { view, journeys } = (window as any).overviewTest;
        const points = journeys.flatMap((journey: any) => [
          journey.origin,
          journey.destination,
          ...journey.legs.flatMap((leg: any) => [leg.from, ...leg.coordinates]),
        ]);
        return {
          routeClear: points.every((point: any) => {
            const pixel = view.map.latLngToContainerPoint([
              point.latitude,
              point.longitude,
            ]);
            const x = mapBounds.left + pixel.x;
            const y = mapBounds.top + pixel.y;
            return (
              x - 5 >= left - 1 &&
              x + 5 <= controls.left - 8 + 1 &&
              y - 5 >= top - 1 &&
              y + 5 <= bottom + 1
            );
          }),
          markersClear: [
            ...document.querySelectorAll("#map .route-marker"),
          ].every((marker) => {
            const bounds = marker.getBoundingClientRect();
            return (
              bounds.left >= left - 1 &&
              bounds.right <= controls.left - 8 + 1 &&
              bounds.top >= top - 1 &&
              bounds.bottom <= bottom + 1
            );
          }),
        };
      }),
    )
    .toEqual({ routeClear: true, markersClear: true });
}

for (const [width, height] of [
  [320, 568],
  [425, 812],
  [844, 390],
  [1280, 900],
]) {
  for (const shape of ["tall", "wide", "grouped"] as const) {
    test(`${shape} overview clears the controls on entry and route fit at ${width}x${height}`, async ({
      page,
    }, info) => {
      await setup(page, width, height, shape);
      await expectClearOverview(page);
      await page.evaluate(() =>
        (window as any).overviewTest.view.map.panBy([150, 80], {
          animate: false,
        }),
      );
      await page.locator("#map-route").click();
      await expectClearOverview(page);
      if (shape === "grouped") {
        const before = await camera(page);
        await page.evaluate(() => {
          const fixture = (window as any).overviewTest;
          fixture.selected = fixture.journeys[1];
          fixture.show();
        });
        await expectClearOverview(page);
        expect(await camera(page)).toEqual(before);
      }
      if (shape === "wide" && width === 425) {
        const before = await camera(page);
        await page.locator("#map-controls").evaluate((controls) => {
          controls.style.width = "80px";
        });
        await expectClearOverview(page);
        expect(await camera(page)).not.toEqual(before);
      }
      await page.screenshot({ path: info.outputPath("clear-overview.png") });
    });
  }
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
