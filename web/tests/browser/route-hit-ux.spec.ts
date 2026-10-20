import { test, expect, type Page } from "@playwright/test";
import { expectRouteFits, expectRouteFitUnchanged } from "./planner-fixture";

type Shape =
  | "separate"
  | "shared"
  | "partial-shared"
  | "crossing"
  | "parallel"
  | "other-shared"
  | "three"
  | "walk";

test("place markers reuse coincident groups across contexts and replace changed place data", async ({
  page,
}) => {
  await setup(page, 390);
  await page.evaluate(() => {
    const f = (window as any).routeHitFixture;
    const origin = { ...f.selected.origin, name: "Hauptplatz" };
    const stop = {
      id: "coffee",
      stayMinutes: 0,
      place: { ...f.selected.destination, name: "Café" },
    };
    const request = {
      origin,
      destination: origin,
      stops: [stop],
      timing: "depart",
      time: 1000,
    };
    f.markerRequest = request;
    f.view.show([], undefined, false, "request", false, request);
  });
  await expect(page.locator("#map .route-marker")).toHaveCount(2);
  const combined = page.getByRole("button", {
    name: "Start: Hauptplatz · Ziel: Hauptplatz",
    exact: true,
  });
  await expect(combined.locator(".route-marker-slot")).toHaveCount(2);
  expect((await combined.boundingBox())!.width).toBe(88);
  const original = await combined.elementHandle();
  await page.evaluate(() => {
    const f = (window as any).routeHitFixture;
    const request = f.markerRequest;
    const stop = request.stops[0];
    const leg = (from: any, to: any, start: number) => ({
      ...f.selected.legs[0],
      from,
      to,
      start,
      end: start + 100,
      coordinates: [from, to],
    });
    const journey = {
      ...f.selected,
      id: "complete-loop",
      origin: request.origin,
      destination: request.destination,
      legs: [
        leg(request.origin, stop.place, 1000),
        {
          kind: "stop",
          stop,
          from: stop.place,
          to: stop.place,
          start: 1100,
          end: 1100,
          distance: 0,
          coordinates: [stop.place],
        },
        leg(stop.place, request.destination, 1100),
      ],
    };
    f.view.show([journey], journey, false, "completed", true);
  });
  expect(
    await combined.evaluate(
      (current, previous) => current === previous,
      original,
    ),
  ).toBe(true);
  await expectRouteFits(page);
  await expectRouteFitUnchanged(page);
  await page.evaluate(() => {
    const f = (window as any).routeHitFixture;
    const request = structuredClone(f.markerRequest);
    request.origin.name = "Marktplatz";
    request.stops[0].place.name = "Park";
    f.view.show([], undefined, false, "edited", false, request);
  });
  expect(await original!.evaluate((element) => element.isConnected)).toBe(
    false,
  );
  await expect(
    page.getByRole("button", {
      name: "Start: Marktplatz · Ziel: Marktplatz",
      exact: true,
    }),
  ).toBeAttached();
  await expect(
    page.getByRole("button", { name: "Zwischenstopp 1: Park", exact: true }),
  ).toBeAttached();
  await page.evaluate(() =>
    (window as any).routeHitFixture.view.show(
      [],
      undefined,
      false,
      "empty",
      true,
    ),
  );
  await expect(page.locator("#map .route-marker")).toHaveCount(0);
  await expect(page.locator("#map .leaflet-overlay-pane svg path")).toHaveCount(
    0,
  );
});

async function setup(page: Page, width = 1100, shape: Shape = "separate") {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await page.evaluate(
    async ({ shape }) => {
      const path = "/src/map-view.ts";
      const { RouteMap } = await import(path);
      document.getElementById("search-view")!.hidden = true;
      document.getElementById("map-view")!.hidden = false;
      document.getElementById("journey-panel")!.style.height = "240px";
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
      const view = new RouteMap(
        (id: string) => {
          fixture.selections.push(id);
          fixture.selected = fixture.journeys.find(
            (journey: any) => journey.id === id,
          );
          fixture.show();
        },
        () => fixture.backgrounds++,
      );
      const fixture = {
        view,
        journeys: [] as any[],
        selected: undefined as any,
        selections: [] as string[],
        backgrounds: 0,
        show() {
          view.show(this.journeys, this.selected, false, "hit-test");
        },
      };
      (window as any).routeHitFixture = fixture;
      fixture.show();
      const map = (view as any).map;
      // Hold the camera while installing geometry with known pixel separations.
      map.panBy([1, 0], { animate: false });
      const bounds = document.getElementById("map")!.getBoundingClientRect();
      const panel = document
        .getElementById("journey-panel")!
        .getBoundingClientRect();
      const controls = document
        .getElementById("map-controls")!
        .getBoundingClientRect();
      const left = innerWidth >= 900 ? panel.right - bounds.left : 0;
      const right = controls.left - bounds.left - 12;
      const bottom = innerWidth >= 900 ? bounds.height : panel.top - bounds.top;
      const center = { x: (left + right) / 2, y: (40 + bottom) / 2 };
      const place = ([x, y]: number[]) => {
        const p = map.containerPointToLatLng([center.x + x, center.y + y]);
        return { name: "Ort", detail: "", latitude: p.lat, longitude: p.lng };
      };
      const journey = (id: string, points: number[][], walk = false) => {
        const coordinates = points.map(place);
        return {
          id,
          origin: coordinates[0],
          destination: coordinates.at(-1),
          departure: 1000,
          arrival: 2000,
          transfers: 0,
          isDirect: true,
          legs: coordinates.slice(1).map((to, index) => ({
            kind: walk ? "walk" : "bike",
            from: coordinates[index],
            to,
            start: 1000,
            end: 2000,
            distance: 1000,
            coordinates: [coordinates[index], to],
          })),
        };
      };
      const selected =
        shape === "shared"
          ? [
              [-90, -60],
              [90, -60],
            ]
          : shape === "crossing"
            ? [
                [-90, -60],
                [90, 60],
              ]
            : shape === "parallel"
              ? [
                  [-90, -52],
                  [90, -52],
                ]
              : [
                  [-90, 60],
                  [90, 60],
                ];
      const alternative =
        shape === "crossing"
          ? [
              [-90, 60],
              [0, 0],
              [90, -60],
            ]
          : shape === "partial-shared"
            ? [
                [-90, -60],
                [0, -60],
                [45, 60],
                [90, 60],
              ]
            : [
                [-90, -60],
                [0, -60],
                [90, -60],
              ];
      fixture.journeys = [
        journey("selected", selected),
        journey("alternative", alternative, shape === "walk"),
        ...(shape === "other-shared" ? [journey("other", alternative)] : []),
        ...(shape === "three"
          ? [
              journey("other", [
                [-90, 0],
                [0, 0],
                [90, 0],
              ]),
            ]
          : []),
      ];
      fixture.selected = fixture.journeys[0];
      fixture.show();
    },
    { shape },
  );
  await expect(page.locator(".route-marker")).toHaveCount(2);
}

async function point(
  page: Page,
  id = "alternative",
  offsetY = 0,
  fraction = 0.5,
  leg?: number,
) {
  return page.evaluate(
    ({ id, offsetY, fraction, leg }) => {
      const { view, journeys } = (window as any).routeHitFixture;
      const journey = journeys.find((j: any) => j.id === id);
      const coordinates =
        leg === undefined
          ? journey.legs.flatMap((leg: any) => leg.coordinates)
          : journey.legs[leg].coordinates;
      const start = coordinates[0],
        end = coordinates.at(-1);
      const a = view.map.latLngToContainerPoint([
        start.latitude,
        start.longitude,
      ]);
      const b = view.map.latLngToContainerPoint([end.latitude, end.longitude]);
      const bounds = view.map.getContainer().getBoundingClientRect();
      return {
        x: bounds.left + a.x + (b.x - a.x) * fraction,
        y: bounds.top + a.y + (b.y - a.y) * fraction + offsetY,
      };
    },
    { id, offsetY, fraction, leg },
  );
}

async function state(page: Page) {
  return page.evaluate(() => {
    const f = (window as any).routeHitFixture;
    return {
      selected: f.selected.id,
      selections: f.selections,
      backgrounds: f.backgrounds,
      camera: { center: f.view.map.getCenter(), zoom: f.view.map.getZoom() },
    };
  });
}

async function expectPreview(page: Page, count: number) {
  await expect
    .poll(() =>
      page.locator(".route-preview-line").evaluateAll((paths) => {
        const opacity = paths.map((path) =>
          Number(getComputedStyle(path).opacity),
        );
        return {
          visible: opacity.filter((value) => value > 0).length,
          settled: opacity.every((value) => value === 0 || value === 1),
        };
      }),
    )
    .toEqual({ visible: count, settled: true });
}

async function pauseHoverClock(page: Page) {
  const time = Date.now();
  await page.clock.install({ time });
  await page.clock.pauseAt(time + 1000);
}

test("hover intent ignores brief crossings and preserves preview through small edge movements", async ({
  page,
}) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pauseHoverClock(page);
  const p = await point(page);
  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(40);
  await expect(page.locator("#map")).toHaveCSS("cursor", "pointer");
  await expectPreview(page, 0);
  await page.mouse.move(p.x, p.y + 13);
  await page.clock.runFor(120);
  await expectPreview(page, 0);

  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(60);
  await expectPreview(page, 0);
  // Moving along the same route must not restart the entry timer.
  await page.mouse.move(p.x + 10, p.y);
  await page.clock.runFor(40);
  await expectPreview(page, 2);
  const paths = await page.locator(".route-preview-line").elementHandles();
  await page.mouse.move(p.x, p.y + 13);
  await page.clock.runFor(50);
  await expect(page.locator("#map")).not.toHaveCSS("cursor", "pointer");
  await expectPreview(page, 2);
  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(120);
  await expectPreview(page, 2);
  for (const path of paths)
    expect(await path.evaluate((node) => node.isConnected)).toBe(true);
  await page.mouse.move(p.x, p.y + 13);
  await page.clock.runFor(120);
  await expectPreview(page, 0);
});

test("rapid route changes settle on current target and clicks bypass pending hover", async ({
  page,
}) => {
  await setup(page, 1100, "three");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pauseHoverClock(page);
  const a = await point(page),
    b = await point(page, "other");
  await page.mouse.move(a.x, a.y);
  await page.clock.runFor(120);
  await expectPreview(page, 2);
  await page.mouse.move(b.x, b.y);
  await page.clock.runFor(40);
  await expect(
    page.locator(".route-preview-line.is-hovered").first(),
  ).toHaveAttribute("data-preview-route", "alternative");
  await page.mouse.move(a.x, a.y);
  await page.clock.runFor(120);
  await expectPreview(page, 2);
  await expect(
    page.locator(".route-preview-line.is-hovered").first(),
  ).toHaveAttribute("data-preview-route", "alternative");
  await page.mouse.move(b.x, b.y);
  await page.clock.runFor(120);
  await expectPreview(page, 2);
  await expect(
    page.locator(".route-preview-line.is-hovered").first(),
  ).toHaveAttribute("data-preview-route", "other");
  await page.mouse.move(a.x, a.y);
  await page.clock.runFor(40);
  await page.mouse.click(a.x, a.y);
  expect(await state(page)).toMatchObject({
    selected: "alternative",
    selections: ["alternative"],
    backgrounds: 0,
  });
  await page.clock.runFor(500);
  await expectPreview(page, 0);
});

test("clicking before hover appears selects immediately and cancels delayed preview", async ({
  page,
}) => {
  await setup(page);
  await pauseHoverClock(page);
  const p = await point(page);
  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(40);
  await expectPreview(page, 0);
  await page.mouse.click(p.x, p.y);
  expect(await state(page)).toMatchObject({
    selected: "alternative",
    selections: ["alternative"],
  });
  await page.clock.runFor(500);
  await expectPreview(page, 0);
});

test("ambiguous segments dismiss hover without the background grace period", async ({
  page,
}) => {
  await setup(page, 1100, "parallel");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pauseHoverClock(page);
  const p = await point(page);
  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(120);
  await expectPreview(page, 2);
  await page.mouse.move(p.x, p.y + 4);
  await page.clock.runFor(20);
  await expectPreview(page, 0);
  await page.mouse.click(p.x, p.y + 4);
  expect(await state(page)).toMatchObject({
    selected: "selected",
    selections: [],
    backgrounds: 0,
  });
});

test("pending hover is cancelled on camera changes, redraw and leaving the map", async ({
  page,
}) => {
  await setup(page);
  await pauseHoverClock(page);
  for (const change of ["pan", "redraw", "leave", "hidden"] as const) {
    const p = await point(page);
    await page.mouse.move(p.x + 1, p.y);
    await page.clock.runFor(40);
    await expectPreview(page, 0);
    if (change === "leave") await page.mouse.move(1, 1);
    else
      await page.evaluate((change) => {
        const f = (window as any).routeHitFixture;
        if (change === "pan") f.view.map.panBy([8, 0], { animate: false });
        if (change === "redraw") {
          f.journeys.reverse();
          f.show();
        }
        if (change === "hidden") {
          Object.defineProperty(document, "hidden", {
            configurable: true,
            value: true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      }, change);
    await page.clock.runFor(500);
    await expectPreview(page, 0);
  }
});

async function pauseNextPreviewTransition(page: Page, marker: string) {
  await page
    .locator(".route-preview-line")
    .first()
    .evaluate((path, marker) => {
      path.addEventListener(
        "transitionrun",
        () => {
          for (const animation of path.getAnimations()) animation.pause();
          path.setAttribute(marker, "true");
        },
        { once: true },
      );
    }, marker);
}

async function transitionFrames(page: Page) {
  return page
    .locator(".route-preview-line")
    .first()
    .evaluate((path) => {
      const animation = path.getAnimations()[0];
      if (!animation) throw new Error("Missing preview opacity transition");
      const duration = Number(animation.effect!.getTiming().duration);
      const opacity = [0, 0.5, 1].map((progress) => {
        animation.currentTime = progress * duration;
        return Number(getComputedStyle(path).opacity);
      });
      animation.finish();
      return { duration, opacity, width: path.getAttribute("stroke-width") };
    });
}

test("preview fades in over 160ms and out over 120ms without changing width", async ({
  page,
}) => {
  await setup(page);
  await pauseNextPreviewTransition(page, "data-entry-paused");
  const p = await point(page);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator(".route-preview-line").first()).toHaveAttribute(
    "data-entry-paused",
    "true",
  );
  const entry = await transitionFrames(page);
  expect(entry.duration).toBe(160);
  expect(entry.opacity[0]).toBe(0);
  expect(entry.opacity[1]).toBeGreaterThan(0);
  expect(entry.opacity[1]).toBeLessThan(1);
  expect(entry.opacity[2]).toBe(1);
  expect(entry.width).toBe("6");
  await expectPreview(page, 2);
  await pauseNextPreviewTransition(page, "data-exit-paused");
  await page.mouse.move(1, 1);
  await expect(page.locator(".route-preview-line").first()).toHaveAttribute(
    "data-exit-paused",
    "true",
  );
  const exit = await transitionFrames(page);
  expect(exit.duration).toBe(120);
  expect(exit.opacity[0]).toBe(1);
  expect(exit.opacity[1]).toBeGreaterThan(0);
  expect(exit.opacity[1]).toBeLessThan(1);
  expect(exit.opacity[2]).toBe(0);
  expect(exit.width).toBe("6");
  await expectPreview(page, 0);
});

test("interrupted fades continue from their current opacity when hover returns", async ({
  page,
}) => {
  await setup(page);
  const preview = page.locator(".route-preview-line").first();
  const p = await point(page);
  await pauseNextPreviewTransition(page, "data-first-entry");
  await page.mouse.move(p.x, p.y);
  await expect(preview).toHaveAttribute("data-first-entry", "true");
  const entering = await preview.evaluate((path) => {
    path.getAnimations()[0].currentTime = 80;
    return Number(getComputedStyle(path).opacity);
  });
  await pauseNextPreviewTransition(page, "data-interrupted-exit");
  await page.mouse.move(1, 1);
  await expect(preview).toHaveAttribute("data-interrupted-exit", "true");
  const exiting = await preview.evaluate((path) => {
    const animation = path.getAnimations()[0];
    const start = Number(animation.effect!.getKeyframes()[0].opacity);
    animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
    return { start, middle: Number(getComputedStyle(path).opacity) };
  });
  expect(exiting.start).toBeCloseTo(entering, 3);
  expect(exiting.middle).toBeGreaterThan(0);
  expect(exiting.middle).toBeLessThan(entering);
  await pauseNextPreviewTransition(page, "data-returning-entry");
  await page.mouse.move(p.x, p.y);
  await expect(preview).toHaveAttribute("data-returning-entry", "true");
  const resumed = await preview.evaluate((path) => {
    const animation = path.getAnimations()[0];
    const start = Number(animation.effect!.getKeyframes()[0].opacity);
    animation.finish();
    return start;
  });
  expect(resumed).toBeCloseTo(exiting.middle, 3);
  await expectPreview(page, 2);
});

test("Reduced Motion ends a running preview transition and keeps hover intent", async ({
  page,
}) => {
  await setup(page);
  await pauseNextPreviewTransition(page, "data-entry-paused");
  const p = await point(page);
  await page.mouse.move(p.x, p.y);
  const preview = page.locator(".route-preview-line").first();
  await expect(preview).toHaveAttribute("data-entry-paused", "true");
  await preview.evaluate((path) => {
    path.getAnimations()[0].currentTime = 60;
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectPreview(page, 2);
  expect(await preview.evaluate((path) => path.getAnimations().length)).toBe(0);
  await page.mouse.move(1, 1);
  await expectPreview(page, 0);
  await pauseHoverClock(page);
  await page.mouse.move(p.x, p.y);
  await page.clock.runFor(40);
  await expectPreview(page, 0);
  await page.clock.runFor(80);
  await expectPreview(page, 2);
  expect(await preview.evaluate((path) => path.getAnimations().length)).toBe(0);
});

for (const width of [390, 1100]) {
  test(`mouse previews the entire route and selects within 12px at ${width}px`, async ({
    page,
  }) => {
    await setup(page, width);
    const before = await state(page);
    const p = await point(page, "alternative", 12);
    await page.mouse.move(p.x, p.y);
    await expectPreview(page, 2);
    await expect(page.locator(".route-preview-line").first()).toHaveAttribute(
      "stroke-width",
      "6",
    );
    await expect(page.locator("#map")).toHaveCSS("cursor", "pointer");
    expect(await state(page)).toEqual(before);
    await page.mouse.click(p.x, p.y);
    await expectPreview(page, 0);
    expect(await state(page)).toEqual({
      ...before,
      selected: "alternative",
      selections: ["alternative"],
    });
  });

  test(`mouse outside 12px clears preview and reaches background at ${width}px`, async ({
    page,
  }) => {
    await setup(page, width);
    const p = await point(page);
    await page.mouse.move(p.x, p.y);
    await expectPreview(page, 2);
    await page.mouse.move(p.x, p.y + 13);
    await expectPreview(page, 0);
    await expect(page.locator("#map")).not.toHaveCSS("cursor", "pointer");
    await page.mouse.click(p.x, p.y + 13);
    expect(await state(page)).toMatchObject({
      selected: "selected",
      selections: [],
      backgrounds: 1,
    });
  });
}

for (const shape of ["shared", "crossing", "parallel"] as const) {
  test(`${shape} ambiguity keeps selection without preview or background action`, async ({
    page,
  }) => {
    await setup(page, 1100, shape);
    const before = await state(page);
    const p = await point(page, "alternative", shape === "parallel" ? 4 : 0);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await expectPreview(page, 0);
    expect(await state(page)).toEqual(before);
  });
}

test("previously selected overlapping alternatives remain reachable after choosing another route", async ({
  page,
}) => {
  await setup(page, 1100, "other-shared");
  await page.evaluate(() => {
    const f = (window as any).routeHitFixture;
    f.selected = f.journeys.find((j: any) => j.id === "alternative");
    f.show();
  });
  const before = await state(page);
  const different = await point(page, "selected");
  await page.mouse.click(different.x, different.y);
  expect(await state(page)).toMatchObject({
    selected: "selected",
    selections: ["selected"],
  });
  await page.evaluate(() => {
    // SVG stacking must not override the connection list's result order.
    const { view } = (window as any).routeHitFixture;
    for (const line of view.routeLines.get("other")) line.bringToFront();
  });
  const shared = await point(page);
  await page.mouse.move(shared.x, shared.y);
  await expect(page.locator("#map")).toHaveCSS("cursor", "pointer");
  await expectPreview(page, 2);
  await expect(
    page.locator(".route-preview-line.is-hovered").first(),
  ).toHaveAttribute("data-preview-route", "alternative");
  await page.mouse.click(shared.x, shared.y);
  await expectPreview(page, 0);
  const selected = await state(page);
  expect(selected).toEqual({
    ...before,
    selections: ["selected", "alternative"],
  });
  await page.mouse.click(shared.x, shared.y);
  expect(await state(page)).toEqual(selected);
});

test("nearby route targets select nearest line independently of drawing order", async ({
  page,
}) => {
  await setup(page, 1100, "parallel");
  const p = await point(page, "alternative", 2);
  for (const reverse of [false, true]) {
    await page.evaluate((reverse) => {
      const f = (window as any).routeHitFixture;
      f.selected = f.journeys.find((j: any) => j.id === "selected");
      if (reverse) f.journeys.reverse();
      f.show();
    }, reverse);
    await page.mouse.click(p.x, p.y);
    expect(await state(page)).toMatchObject({
      selected: "alternative",
      backgrounds: 0,
    });
  }
});

test("walking dash gaps remain clickable", async ({ page }) => {
  await setup(page, 1100, "walk");
  // Six pixels into a 3px dash / 8px gap, beyond the round end cap.
  const p = await point(page, "alternative", 0, 6 / 180);
  await page.mouse.click(p.x, p.y);
  expect(await state(page)).toMatchObject({
    selected: "alternative",
    backgrounds: 0,
  });
});

test("marker popups, controls and drags preserve route selection", async ({
  page,
}) => {
  await setup(page);
  const initial = await state(page);
  await page.locator(".route-marker").first().click();
  await expect(page.locator(".leaflet-popup-content")).toContainText(
    "Start: Ort",
  );
  expect(await state(page)).toEqual(initial);
  const p = await point(page);
  await page.mouse.move(p.x, p.y);
  await expectPreview(page, 2);
  await page.mouse.down();
  await page.mouse.move(p.x + 60, p.y + 15, { steps: 6 });
  await page.mouse.up();
  await expectPreview(page, 0);
  await expect
    .poll(async () => (await state(page)).camera)
    .not.toEqual(initial.camera);
  expect(await state(page)).toMatchObject({
    selected: "selected",
    selections: [],
    backgrounds: 0,
  });
  await page.getByRole("button", { name: "Vergrößern", exact: true }).click();
  expect(await state(page)).toMatchObject({
    selected: "selected",
    selections: [],
    backgrounds: 0,
  });
});

test("hover clears on exit and redraw, and hit geometry follows pan, zoom, resize and updates", async ({
  page,
}) => {
  await setup(page);
  let p = await point(page);
  await page.mouse.move(p.x, p.y);
  await expectPreview(page, 2);
  await page.mouse.move(1, 1);
  await expectPreview(page, 0);
  for (const change of ["pan", "zoom", "geometry", "theme"] as const) {
    p = await point(page);
    await page.mouse.move(p.x, p.y);
    await expectPreview(page, 2);
    await page.evaluate(async (change) => {
      const f = (window as any).routeHitFixture;
      if (change === "pan") f.view.map.panBy([15, 5], { animate: false });
      if (change === "zoom")
        f.view.map.setZoom(f.view.map.getZoom() + 1, { animate: false });
      if (change === "geometry") {
        for (const leg of f.journeys[1].legs)
          for (const coordinate of leg.coordinates)
            coordinate.latitude += 0.00001;
        f.show();
      }
      if (change === "theme") {
        const path = "/src/map-style.ts";
        const { mapStyle } = await import(path);
        mapStyle.set("dark");
      }
    }, change);
    await expectPreview(page, 0);
    p = await point(page);
    await page.mouse.move(p.x, p.y);
    await expectPreview(page, 2);
  }
  await page.setViewportSize({ width: 1000, height: 800 });
  await expectPreview(page, 0);
  p = await point(page, "alternative", 8);
  await page.mouse.click(p.x, p.y);
  expect(await state(page)).toMatchObject({
    selected: "alternative",
    backgrounds: 0,
  });
});

for (const palette of ["positron", "dark"] as const) {
  test(`${palette} hover previews retain selected route above shared sections`, async ({
    page,
  }, info) => {
    await setup(page, 1100, "partial-shared");
    await page.evaluate(async (palette) => {
      const path = "/src/map-style.ts";
      const { mapStyle } = await import(path);
      mapStyle.set(palette);
    }, palette);
    const before = await state(page);
    const p = await point(page, "alternative", 6, 0.5, 0);
    await page.mouse.move(p.x, p.y);
    await expectPreview(page, 3);
    expect(await state(page)).toEqual(before);
    expect(
      await page.evaluate(() => {
        const { view } = (window as any).routeHitFixture;
        return view.selectedPaths.every((selected: any) =>
          view.hoverLayers
            .getLayers()
            .every(
              (preview: any) =>
                preview
                  .getElement()
                  .compareDocumentPosition(selected.getElement()) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            ),
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`hover-${palette}.png`) });
  });
}

test.describe("touch input", () => {
  test.use({ hasTouch: true });
  test("touch cancels pending and visible mouse hover immediately", async ({
    page,
  }) => {
    await setup(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      // hasTouch emulates touch-only hardware; this case also has an attached mouse.
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const media = matchMedia(query);
        if (query === "(any-hover: hover) and (any-pointer: fine)")
          Object.defineProperty(media, "matches", { value: true });
        return media;
      };
    });
    await pauseHoverClock(page);
    const p = await point(page),
      selected = await point(page, "selected");
    for (const time of [40, 120]) {
      await page.mouse.move(p.x, p.y);
      await page.clock.runFor(time);
      await expectPreview(page, time === 40 ? 0 : 2);
      await page.touchscreen.tap(selected.x, selected.y);
      await expectPreview(page, 0);
      await page.clock.runFor(500);
      await expectPreview(page, 0);
    }
    expect(await state(page)).toMatchObject({
      selected: "selected",
      selections: [],
      backgrounds: 0,
    });
  });
  for (const width of [390, 1100]) {
    test(`touch target reaches 22px without hover at ${width}px`, async ({
      page,
    }) => {
      await setup(page, width);
      const p = await point(page, "alternative", 22);
      await page.touchscreen.tap(p.x, p.y);
      expect(await state(page)).toMatchObject({
        selected: "alternative",
        selections: ["alternative"],
        backgrounds: 0,
      });
      await expectPreview(page, 0);
    });
    test(`touch outside 22px reaches background at ${width}px`, async ({
      page,
    }) => {
      await setup(page, width);
      const p = await point(page, "alternative", 23);
      await page.touchscreen.tap(p.x, p.y);
      expect(await state(page)).toMatchObject({
        selected: "selected",
        selections: [],
        backgrounds: 1,
      });
    });
  }
  test("shared segments keep selected route on touch", async ({ page }) => {
    await setup(page, 390, "shared");
    const before = await state(page);
    const p = await point(page);
    await page.touchscreen.tap(p.x, p.y);
    expect(await state(page)).toEqual(before);
  });
  test("shared unselected alternatives expose the first matching result on touch", async ({
    page,
  }) => {
    await setup(page, 390, "other-shared");
    const before = await state(page);
    const p = await point(page, "alternative", 20);
    await page.touchscreen.tap(p.x, p.y);
    const selected = await state(page);
    expect(selected).toEqual({
      ...before,
      selected: "alternative",
      selections: ["alternative"],
    });
    await page.touchscreen.tap(p.x, p.y);
    expect(await state(page)).toEqual(selected);
    await expectPreview(page, 0);
  });
  test("hybrid input switches between touch and mouse target widths", async ({
    page,
  }) => {
    await setup(page);
    const alternative = await point(page, "alternative", 20);
    await page.touchscreen.tap(alternative.x, alternative.y);
    expect(await state(page)).toMatchObject({
      selected: "alternative",
      backgrounds: 0,
    });
    const selected = await point(page, "selected", 20);
    await page.mouse.click(selected.x, selected.y);
    expect(await state(page)).toMatchObject({
      selected: "alternative",
      backgrounds: 1,
    });
    await page.touchscreen.tap(selected.x, selected.y);
    expect(await state(page)).toMatchObject({
      selected: "selected",
      backgrounds: 1,
    });
    await expectPreview(page, 0);
  });
  test("native touch pan and pinch never select a route", async ({
    page,
  }, info) => {
    test.skip(
      info.project.name !== "chromium",
      "Native multi-touch input requires Chromium CDP",
    );
    await setup(page, 390);
    const client = await page.context().newCDPSession(page);
    let p = await point(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: p.x, y: p.y }],
    });
    for (const dx of [15, 30, 45]) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: p.x + dx, y: p.y }],
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await state(page)).toMatchObject({
      selected: "selected",
      selections: [],
      backgrounds: 0,
    });
    p = await point(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: p.x - 15, y: p.y, id: 1 },
        { x: p.x + 15, y: p.y, id: 2 },
      ],
    });
    for (const dx of [25, 35, 45]) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: p.x - dx, y: p.y, id: 1 },
          { x: p.x + dx, y: p.y, id: 2 },
        ],
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await state(page)).toMatchObject({
      selected: "selected",
      selections: [],
      backgrounds: 0,
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).routeHitFixture.view.zooming),
      )
      .toBe(false);
    p = await point(page, "alternative", 20);
    await page.touchscreen.tap(p.x, p.y);
    expect(await state(page)).toMatchObject({
      selected: "alternative",
      selections: ["alternative"],
      backgrounds: 0,
    });
  });
});
