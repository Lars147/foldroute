import { test, expect, type Page } from "./test";

import { preview } from "./journey-preview-fixture";

async function expectRequestMarkersAligned(page: Page) {
  const geometry = await page.locator("#adjust-route").evaluate((button) => {
    const points = [
      ...button.querySelectorAll<HTMLElement>(".route-request-point"),
    ];
    const markers = points.map((point) =>
      point
        .querySelector<HTMLElement>(".route-request-marker")!
        .getBoundingClientRect(),
    );
    const origin = button
      .querySelector(".route-origin-marker")!
      .getBoundingClientRect();
    const flag = button.querySelector<SVGGeometryElement>(
      ".route-request-destination svg path",
    )!;
    const matrix = flag.getScreenCTM()!;
    const pole = flag.getPointAtLength(0).matrixTransform(matrix);
    // The first path segment is the 18-unit flagpole, from its bottom to its top.
    const poleTop = flag.getPointAtLength(18).matrixTransform(matrix);
    const capRadius =
      (parseFloat(getComputedStyle(flag).strokeWidth) *
        Math.hypot(matrix.c, matrix.d)) /
      2;
    const shapes = [
      origin,
      ...markers.slice(1, -1),
      { top: poleTop.y - capRadius, bottom: pole.y + capRadius },
    ];
    const lines = points.slice(0, -1).map((point) => {
      const line = getComputedStyle(point, "::after");
      const bounds = point.getBoundingClientRect();
      const top = bounds.top + parseFloat(line.top);
      const transform = new DOMMatrix(line.transform);
      return {
        x:
          bounds.left +
          parseFloat(line.left) +
          parseFloat(line.width) / 2 +
          transform.e,
        top,
        bottom: top + parseFloat(line.height),
      };
    });
    return {
      originX: origin.left + origin.width / 2,
      axes: [
        ...lines.map((line) => line.x),
        ...markers.slice(1, -1).map((marker) => marker.left + marker.width / 2),
      ],
      gaps: markers.slice(1).map((marker, i) => marker.top - markers[i].bottom),
      clearances: lines.map((line, i) => ({
        start: line.top - shapes[i].bottom,
        end: shapes[i + 1].top - line.bottom,
      })),
    };
  });
  for (const axis of geometry.axes)
    expect(Math.abs(axis - geometry.originX)).toBeLessThanOrEqual(0.5);
  for (const gap of geometry.gaps) expect(gap).toBeGreaterThanOrEqual(10);
  for (const clearance of geometry.clearances) {
    expect(clearance.start).toBeCloseTo(3, 1);
    expect(clearance.end).toBeCloseTo(3, 1);
  }
}

async function expectRequestPixelsAligned(page: Page) {
  const geometry = await page
    .locator("#adjust-route .route-request-chain")
    .evaluate((chain) => {
      const origin = chain.querySelector<HTMLElement>(".route-request-origin")!;
      const circle = origin
        .querySelector(".route-request-marker")!
        .getBoundingClientRect();
      const flag = chain
        .querySelector(".route-request-destination .route-request-marker")!
        .getBoundingClientRect();
      const line = getComputedStyle(origin, "::after");
      const lineTop = origin.getBoundingClientRect().top + parseFloat(line.top);
      const x = Math.floor(circle.left);
      const y = Math.floor(circle.top);
      return {
        clip: {
          x,
          y,
          width: Math.ceil(circle.right) - x,
          height: Math.ceil(flag.bottom) - y,
        },
        regions: {
          circle: { top: circle.top, bottom: circle.bottom },
          line: {
            top: lineTop + 1,
            bottom: lineTop + parseFloat(line.height) - 1,
          },
          flag: { top: flag.top, bottom: flag.bottom },
        },
      };
    });
  const screenshot = await page.screenshot({ clip: geometry.clip });
  const centers = await page.evaluate(
    async ({ png, clip, regions }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const scale = canvas.width / clip.width;
      const centers: Record<string, number> = {};
      for (const [name, region] of Object.entries(regions)) {
        let weight = 0;
        let moment = 0;
        for (
          let y = Math.ceil((region.top - clip.y) * scale);
          y < Math.floor((region.bottom - clip.y) * scale);
          y++
        ) {
          for (let x = 0; x < canvas.width; x++) {
            const offset = (y * canvas.width + x) * 4;
            // Contrast against the empty corner measures painted pixels,
            // including antialiasing, rather than the element's layout box.
            const contrast =
              Math.abs(data[offset] - data[0]) +
              Math.abs(data[offset + 1] - data[1]) +
              Math.abs(data[offset + 2] - data[2]);
            weight += contrast;
            moment += ((x + 0.5) / scale) * contrast;
          }
        }
        if (!weight) throw new Error(`No visible pixels in ${name}`);
        centers[name] = moment / weight;
      }
      return centers;
    },
    { ...geometry, png: screenshot.toString("base64") },
  );
  expect(
    Math.abs(centers.line - centers.circle),
    `Painted circle/line centers: ${JSON.stringify(centers)}`,
  ).toBeLessThanOrEqual(0.15);
  expect(
    Math.abs(centers.flag - centers.circle),
    `Optical flag center: ${JSON.stringify(centers)}`,
  ).toBeLessThanOrEqual(0.25);
}

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`route marker pixels at ${deviceScaleFactor}x density`, () => {
    test.use({ deviceScaleFactor });
    test("circle, connector and flag share an optical axis", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await preview(page);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const fontSize of [16, 32]) {
          await page.evaluate((size) => {
            document.documentElement.style.fontSize = `${size}px`;
          }, fontSize);
          await expectRequestPixelsAligned(page);
        }
      }
    });
  });
}

for (const width of [320, 390, 1280]) {
  test(`result header connects endpoints and changing intermediate stops at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await preview(page);
    const names = [
      "Marktplatz, Eingang am Rathaus",
      "Bahnhof West, Ausgang zur Schillerstraße",
      "Park <Am Weiher>, nördlicher Eingang",
    ];
    const stops = page.locator("#route-request-stops .route-request-stop-name");
    for (const count of [0, 1, 3]) {
      await page.evaluate(
        (names) => {
          const { state, view } = (window as any).uxPreview;
          state.request.stops = names.map((name, i) => ({
            id: `via-${i}`,
            place: { ...state.request.origin, name },
            stayMinutes: 5,
          }));
          view.render(state, 30);
        },
        names.slice(0, count),
      );
      await expect(stops).toHaveCount(count);
      await expect(
        page.locator("#adjust-route .route-request-point"),
      ).toHaveCount(count + 2);
      await expect(page.locator("#route-origin")).toHaveText("Start");
      await expect(page.locator("#route-destination")).toHaveText("Ziel");
      for (let i = 0; i < count; i++)
        await expect(stops.nth(i)).toHaveText(
          `Zwischenziel ${i + 1}: ${names[i]}`,
        );
      await expect(page.locator("#adjust-route")).toHaveAccessibleDescription(
        count
          ? new RegExp(
              `Start Zwischenziel 1: ${names[0]}.*Ziel Abfahrt jetzt.*${count} Zwischenstopp`,
            )
          : "Start Ziel Abfahrt jetzt",
      );
      await expectRequestMarkersAligned(page);
      if (count === 0)
        await page.screenshot({
          path: info.outputPath("connected-endpoints.png"),
        });
    }
    await expect(
      page.locator("#adjust-route marktplatz, #adjust-route am"),
    ).toHaveCount(0);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const fontSize of [16, 32]) {
        await page.evaluate((fontSize) => {
          document.documentElement.style.fontSize = `${fontSize}px`;
        }, fontSize);
        for (const name of [
          page.locator("#route-origin"),
          ...(await stops.all()),
          page.locator("#route-destination"),
        ]) {
          await name.scrollIntoViewIfNeeded();
          expect(
            await name.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.locator("#route-origin").scrollIntoViewIfNeeded();
        await expectRequestMarkersAligned(page);
        await page.screenshot({
          path: info.outputPath(
            `connected-places-${colorScheme}-${fontSize}.png`,
          ),
        });
      }
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "16px";
    });
    await page.locator("#route-origin").scrollIntoViewIfNeeded();
    const before = (await page.locator(".planning-context").boundingBox())!;
    if (width < 900) {
      await page.evaluate(() => {
        (window as any).uxPreview.view.showScreen("detail");
      });
      const details = (await page.locator(".planning-context").boundingBox())!;
      expect(Math.abs(before.y - details.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(before.height - details.height)).toBeLessThanOrEqual(1);
      await page.locator("#panel-map-toggle").click();
      await expect(page.locator("#route-origin")).toBeHidden();
      await expect(page.locator("#route-request-stops")).toBeHidden();
      await expect(page.locator("#route-destination")).toBeVisible();
      await expect(page.locator("#map-request-meta")).toHaveText(
        "3 Zwischenstopps",
      );
      await page.locator("#result-back").click();
      await expect(stops).toHaveCount(3);
      await expect(page.locator("#alternatives-dialog")).toBeVisible();
      await expect(page.locator("#choices")).toBeVisible();
      await page.locator("#alternatives-close").click();
      await page.locator("#map-open-details").click();
      await page.locator("#result-back").click();
      await expect(stops.first()).toBeVisible();
    }
    // Updating the confirmed request must work even when JourneyView's detail key is unchanged.
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.request.stops = [state.request.stops[2], state.request.stops[0]];
      state.request.stops[0].place.name = "Neuer Zwischenhalt";
      view.render(state, 30);
    });
    await expect(stops).toHaveText([
      "Zwischenziel 1: Neuer Zwischenhalt",
      `Zwischenziel 2: ${names[0]}`,
    ]);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      delete state.request.stops;
      view.render(state, 30);
    });
    await expect(stops).toHaveCount(0);
    await expect(page.locator("#adjust-route")).toHaveAccessibleDescription(
      "Start Ziel Abfahrt jetzt",
    );
  });
}

for (const width of [320, 390, 1280]) {
  test(`planning context stays grouped and accessible at ${width}`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.request.origin.name = "Aktueller Standort";
      state.request.destination.name = "Bahnhofstraße 3a";
      view.render(state, 30);
    });
    const context = page.locator(".planning-context");
    if (width < 900) {
      await expect(page.locator("#result-nav")).toBeHidden();
      await expect(
        context.getByRole("button", { name: "Karte anzeigen" }),
      ).toBeVisible();
      await expect(page.locator("#panel-map-toggle")).toHaveText("Karte");
    }
    await expect(
      context.getByRole("button", { name: "Route anpassen" }),
    ).toBeVisible();
    await expect(context.getByRole("heading", { level: 1 })).toHaveText(
      "Aktueller Standort → Bahnhofstraße 3a",
    );
    await page.locator("#result-context").focus();
    await expect(page.locator("#result-context")).toBeFocused();
    await expect(context).toHaveCSS("outline-style", "none");
    await expect(page.locator("#result-context")).toHaveCSS(
      "outline-style",
      "solid",
    );
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(page.locator("#adjust-route")).toBeFocused();
    await expect(page.locator("#adjust-route")).toHaveCSS(
      "outline-style",
      "solid",
    );
    await page.locator("#adjust-route").blur();
    await page.screenshot({ path: info.outputPath("planning-context.png") });

    // Long place names and all planning metadata must remain readable with large text.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      const { state, view } = (window as any).uxPreview;
      state.request.origin.name = "München Hauptbahnhof, Ausgang Arnulfstraße";
      state.request.destination.name = "Bahnhofstraße 3a, 82166 Gräfelfing";
      state.request.timing = "arrive";
      state.request.stops = [
        state.request.origin,
        state.request.destination,
      ].map((place, i) => ({ id: `stop-${i}`, place, stayMinutes: 0 }));
      state.restored = true;
      view.render(state, 30);
    });
    await expect(page.locator("#route-request-meta")).toContainText("Ankunft");
    await expect(page.locator("#route-request-meta")).toContainText(
      "2 Zwischenstopps",
    );
    await expect(page.locator("#result-stand")).toContainText("Gespeichert:");
    expect(
      await page.evaluate(() => {
        const ids = ["route-origin", "route-destination", "route-request-meta"];
        return (
          ids.every((id) => {
            const element = document.getElementById(id)!;
            return (
              element.scrollWidth <= element.clientWidth &&
              element.scrollHeight <= element.clientHeight
            );
          }) && document.documentElement.scrollWidth <= innerWidth
        );
      }),
    ).toBe(true);
    for (const id of [
      "adjust-route",
      "route-more",
      "close-route",
      ...(width < 900 ? ["panel-map-toggle"] : []),
    ]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
      const bounds = (await control.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: info.outputPath("planning-context-large-text.png"),
    });
  });
}

for (const width of [320, 390, 430, 768]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`route header stays fixed through details and back at ${width} with ${reducedMotion} motion`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion });
      await preview(page);
      await page.locator('[data-journey="best"]').click();
      await page.evaluate(async () => {
        await document.fonts.ready;
        const elements = [
          ...document.querySelectorAll<HTMLElement>(
            "#result-header, .planning-context, #route-origin, #route-destination, #adjust-route, #route-more, #close-route, #route-request-meta, #result-stand, #panel-map-toggle",
          ),
        ];
        const bounds = () =>
          elements.flatMap((element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return [x, y, width, height];
          });
        const baseline = bounds();
        const recording = { baseline, samples: [baseline], active: true };
        (window as any).headerGeometry = recording;
        const sample = () => {
          if (!recording.active) return;
          recording.samples.push(bounds());
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const details = page.locator(
        ".route-choice-row.selected .route-detail-link",
      );
      const content = page.locator("#panel-content");
      let detailScroll = 0;
      for (let visit = 0; visit < 2; visit++) {
        await details.click();
        await expect(page.locator("#journey-heading")).toBeFocused();
        await expect(page.locator("#close-route")).toBeVisible();
        await expect(content).toHaveJSProperty("scrollTop", detailScroll);
        await expect
          .poll(() =>
            page
              .locator("#panel-details")
              .evaluate(
                (element) => element.getAnimations({ subtree: true }).length,
              ),
          )
          .toBe(0);
        const header = (await page.locator("#result-header").boundingBox())!;
        const back = (await page.locator("#result-back").boundingBox())!;
        expect(back.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
        expect(back.height).toBeGreaterThanOrEqual(44);
        await content.evaluate((element) => (element.scrollTop = 150));
        detailScroll = await content.evaluate((element) => element.scrollTop);
        expect(detailScroll).toBeGreaterThan(0);
        await expect(page.locator("#result-back")).toBeInViewport({ ratio: 1 });
        if (visit === 0)
          await page.screenshot({ path: info.outputPath("stable-header.png") });
        await page.locator("#result-back").click();
        await expect(details).toBeFocused();
        await expect(content).toHaveJSProperty("scrollTop", 0);
        await expect
          .poll(() =>
            page
              .locator("#choices")
              .evaluate(
                (element) => element.getAnimations({ subtree: true }).length,
              ),
          )
          .toBe(0);
      }
      const maximumShift = await page.evaluate(() => {
        const recording = (window as any).headerGeometry as {
          active: boolean;
          baseline: number[];
          samples: number[][];
        };
        recording.active = false;
        return Math.max(
          ...recording.samples.flatMap((sample) =>
            sample.map((value, index) =>
              Math.abs(value - recording.baseline[index]),
            ),
          ),
        );
      });
      expect(maximumShift).toBeLessThanOrEqual(1);
    });
  }
}

test("map action stays in the route header across desktop resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  const toggle = page.getByRole("button", { name: "Karte anzeigen" });
  await expect(
    page.locator("#planning-context-footer #panel-map-toggle"),
  ).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect(page.locator("#panel-map-toggle")).toBeHidden();
  await page.locator("#result-back").click();
  await expect(page.locator("#choices")).toBeVisible();
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await expect(page.locator("#alternatives-title")).toHaveText("Reiseablauf");
  await page.locator("#alternatives-close").click();
  await page.locator("#map-open-details").click();
  await expect(
    page.locator("#planning-context-footer #panel-map-toggle"),
  ).toBeVisible();
  await toggle.click();
  await page.locator("#map-open-details").click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#panel-map-toggle")).toBeHidden();
  await expect(page.locator("#result-nav")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator("#planning-context-footer #panel-map-toggle"),
  ).toBeVisible();
  await page.locator("#result-back").click();
  await expect(
    page.locator("#planning-context-footer #panel-map-toggle"),
  ).toBeVisible();
  await expect(page.locator("#panel-map-toggle")).toHaveCount(1);
});

for (const width of [320, 390, 768, 1280]) {
  test(`separate results and itinerary remain readable at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await expect(page.locator(".route-choice")).toHaveCount(4);
    await expect(page.locator("#choices .route-recommendation")).toHaveText(
      "Früheste Ankunft",
    );
    const selected = page.locator('.route-choice[aria-pressed="true"]');
    await expect(selected.locator(".route-stage")).toHaveCount(4);
    await expect(selected.locator(".route-line")).toHaveText("ÖPNV");
    await expect(
      selected.locator('.route-effort-metric[data-kind="bike"]'),
    ).toHaveText("14 min Rad");
    await expect(
      selected.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveCount(0);
    await expect(selected.locator(".route-effort-label")).toHaveText("Gesamt:");
    await expect(selected.locator(".route-choice-effort .icon")).toHaveCount(0);
    await expect(
      selected.locator('.route-stage[data-kind="walk"] .icon'),
    ).toHaveCount(1);
    await expect(selected).toHaveAccessibleName(/14 min Rad · 1 Umstieg/);
    await expect(selected).not.toHaveAccessibleName(/\d+ min Fuß/);
    await expect(
      selected.locator('.route-effort-metric[data-kind="transfer"]'),
    ).toHaveText("1 Umst.");
    const details = (await page
      .locator(".route-choice-row.selected .route-detail-link")
      .boundingBox())!;
    for (const metric of await selected.locator(".route-effort-metric").all()) {
      const box = (await metric.boundingBox())!;
      expect(
        box.x + box.width <= details.x ||
          box.y + box.height <= details.y ||
          box.y >= details.y + details.height,
      ).toBe(true);
    }
    const comparison = page.locator('[data-journey="comparison"]');
    await expect(
      comparison.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveCount(0);
    await expect(comparison).toHaveAccessibleName(/1 h 5 min Rad · 0 Umstiege/);
    await expect(
      page.locator("#panel-handle, .route-details-button"),
    ).toHaveCount(0);
    await page.locator("#route-more").click();
    await expect(page.locator("#refresh-route")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: info.outputPath(`list-${width}.png`) });
    await page.locator('[data-journey="best"]').click();
    await page.locator(".route-choice-row.selected .route-detail-link").click();
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(page.locator("#journey-heading")).toBeFocused();
    await expect(page.locator("#journey-effort")).toContainText("14 min Rad");
    expect(
      await page
        .locator(".journey-legs small")
        .first()
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(14);
    await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
    if (width < 900) {
      await expect(page.locator("#choices")).toBeHidden();
      await expect(page.locator("#map")).toHaveJSProperty("inert", true);
      await page.locator("#panel-content").evaluate((e) => (e.scrollTop = 150));
      const scroll = await page
        .locator("#panel-content")
        .evaluate((e) => e.scrollTop);
      await page.locator("#result-back").click();
      await expect(
        page.locator(".route-choice-row.selected .route-detail-link"),
      ).toBeFocused();
      await page.locator('[data-journey="best"]').click();
      await page
        .locator(".route-choice-row.selected .route-detail-link")
        .click();
      await expect(page.locator("#panel-content")).toHaveJSProperty(
        "scrollTop",
        scroll,
      );
      await page.locator("#panel-map-toggle").click();
      await expect(page.locator("#map")).toHaveJSProperty("inert", false);
      await expect(page.locator("#map-preview")).toBeVisible();
      await page.locator("#result-back").click();
      await expect(page.locator("#choices")).toBeVisible();
      await page
        .locator(".route-choice-row.selected .route-detail-link")
        .click();
      await expect(page.locator("#panel-details")).toBeVisible();
      await expect(page.locator("#alternatives-body")).toHaveJSProperty(
        "scrollTop",
        0,
      );
      await expect(page.locator("#alternatives-dialog")).toBeVisible();
      await page.locator("#alternatives-close").click();
    } else {
      await expect(page.locator("#choices")).toBeVisible();
      await expect(page.locator("#panel-map-toggle")).toBeHidden();
    }
    await page.screenshot({ path: info.outputPath(`itinerary-${width}.png`) });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const width of [320, 390, 425, 844]) {
  test(`compact map preserves orientation and reachable actions at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
    await page.clock.setFixedTime(new Date("2026-09-11T08:00:00Z"));
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.request.destination.name = "Bahnhofstraße 3a";
      view.render(state, 30);
    });
    const previousHeight = (await page
      .locator(".planning-context")
      .boundingBox())!.height;
    await page.locator("#panel-map-toggle").click();
    await expect(page.locator("#map-preview-heading")).toBeFocused();
    await expect(page.locator("#map-preview-heading")).toHaveText(
      "Ausgewählte Verbindung",
    );
    await expect(page.locator("#route-origin")).toBeHidden();
    await expect(page.locator("#route-destination")).toHaveText(
      "Bahnhofstraße 3a",
    );
    await expect(page.locator("#map-request-meta")).toBeHidden();
    await expect(page.locator("#result-freshness")).toBeHidden();
    await expect(page.locator("#route-start-summary")).toBeHidden();
    await expect(page.locator("#map-preview-actions #result-back")).toHaveText(
      "Alternativen",
    );
    await expect(
      page.locator("#map-preview-actions #navigation-start"),
    ).toBeVisible();
    await expect(page.locator("#map-open-details")).toHaveClass("text-button");
    const compactHeight = (await page
      .locator(".planning-context")
      .boundingBox())!.height;
    if (width === 425) {
      expect(compactHeight).toBeLessThanOrEqual(64);
      expect(previousHeight - compactHeight).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator("#adjust-route")).toHaveAccessibleDescription(
      /Start Bahnhofstraße 3a Abfahrt jetzt/,
    );
    await page.screenshot({ path: info.outputPath("compact-map.png") });
    await page.locator("#route-more").click();
    await expect(page.locator("#route-action-origin")).toHaveText("Start");
    await expect(page.locator("#route-action-destination")).toHaveText(
      "Bahnhofstraße 3a",
    );
    await expect(page.locator("#route-action-time")).toHaveText(
      "Abfahrt jetzt",
    );
    await expect(page.locator("#route-action-stand")).toContainText("Stand:");
    await page.keyboard.press("Escape");
    await expect(page.locator("#route-more")).toBeFocused();

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
      const { state, view } = (window as any).uxPreview;
      state.request.destination.name =
        "Bahnhofstraße 3a, Eingang hinter dem Rathaus, 82166 Gräfelfing";
      view.render(state, 30);
    });
    for (const id of [
      "adjust-route",
      "route-more",
      "close-route",
      "map-open-details",
      "result-back",
      "navigation-start",
    ]) {
      const control = page.locator(`#${id}`);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 0.99 });
      const bounds = (await control.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(
        await control.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: info.outputPath("compact-map-large-text.png"),
    });
  });
}

test("compact map keeps constraints, warnings and focus across layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date("2026-09-11T08:00:00Z"));
  await preview(page);
  await page.locator("#panel-map-toggle").click();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.request.timing = "depart";
    state.request.time += 30 * 60;
    state.request.stops = [
      {
        id: "stop-1",
        place: { ...state.request.origin, name: "Marktplatz" },
        stayMinutes: 5,
      },
    ];
    view.render(state, 30);
  });
  await expect(page.locator("#map-request-meta")).toHaveText(
    "Ab 10:30 · 1 Zwischenstopp",
  );
  await page.locator("#route-more").click();
  await expect(page.locator("#route-action-stops")).toHaveText("Marktplatz");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.request.timing = "arrive";
    state.request.time += 86400;
    view.render(state, 30);
  });
  await expect(page.locator("#map-request-meta")).toHaveText(
    "Ankunft bis 12. Sept., 10:30 · 1 Zwischenstopp",
  );
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.request.timing = "now";
    state.request.time = state.selected.departure - 7200;
    state.issues = ["Ein Verkehrsmittel ist nicht verfügbar."];
    view.render(state, 30);
  });
  await expect(page.locator("#map-request-meta")).toHaveText("1 Zwischenstopp");
  await expect(page.locator("#map-preview-feedback #issues")).toBeVisible();
  await expect(
    page.locator("#map-preview-feedback #late-departure"),
  ).toBeVisible();
  await page.locator("#late-settings").focus();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#panel-content #late-departure")).toBeVisible();
  await expect(page.locator("#late-settings")).toBeFocused();
  await expect(page.locator("#panel-content #issues")).toBeVisible();
  await expect(page.locator("#route-origin")).toBeVisible();
  await expect(page.locator("#map-request-meta")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator("#map-preview-feedback #late-settings"),
  ).toBeFocused();
  await page.locator("#result-back").click();
  await expect(
    page.locator("#alternatives-body #late-departure"),
  ).toBeVisible();
  await page.locator('[data-journey="comparison"]').click();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#map-preview-heading")).toHaveText(
    "Fahrradvergleich",
  );
  await expect(
    page.locator("#map-preview-feedback #cycling-comparison"),
  ).toBeVisible();
});

for (const [width, height] of [
  [320, 844],
  [390, 844],
  [844, 390],
]) {
  test(`map summary keeps route symbols and metrics at ${width}x${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      for (const journey of state.journeys) {
        for (const leg of journey.legs)
          if (leg.kind === "transit") {
            leg.mode = "SUBURBAN";
            leg.line = "S6";
          }
      }
      view.render(state, 30);
    });
    await page.locator('[data-journey="best"]').click();
    const card = page.locator('[data-journey="best"]');
    const arrival = await card.locator(".route-choice-arrival").innerText();
    const schedule = await card.locator(".route-choice-schedule").innerText();
    const lineColor = await card
      .locator(".route-line")
      .evaluate((e) => getComputedStyle(e).color);
    await page.locator("#panel-map-toggle").click();
    const summary = page.locator("#map-preview-summary");
    await expect(summary.locator(".route-choice-arrival")).toHaveText(arrival);
    await expect(summary.locator(".route-choice-schedule")).toHaveText(
      schedule,
    );
    await expect(page.locator("#map-preview-heading")).toHaveText(
      "Früheste Ankunft",
    );
    await expect(summary.locator(".route-recommendation")).toHaveCount(0);
    await expect(summary.locator(".route-line")).toHaveText("S6");
    await expect(summary.locator(".route-line")).toHaveCSS("color", lineColor);
    await expect(
      summary.locator('.route-stage[data-kind="bike"] .icon'),
    ).toHaveCount(2);
    await expect(
      summary.locator('.route-stage[data-kind="walk"] .icon'),
    ).toHaveCount(1);
    await expect(
      summary.locator('.route-effort-metric[data-kind="bike"]'),
    ).toHaveText("14 min Rad");
    await expect(
      summary.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveCount(0);
    await expect(summary.locator(".route-effort-label")).toHaveText("Gesamt:");
    await expect(summary.locator(".route-choice-effort .icon")).toHaveCount(0);
    await expect(
      summary.locator('.route-effort-metric[data-kind="transfer"]'),
    ).toHaveText("1 Umst.");
    await expect(summary.locator(".sr-only")).toContainText(
      "14 min Rad · 1 Umstieg",
    );
    await expect(summary.locator(".sr-only")).not.toContainText(/\d+ min Fuß/);
    await expect(summary.getByRole("button")).toHaveCount(0);
    await expect(page.locator("#result-freshness")).toBeHidden();
    await expect(page.locator("#map-preview-status")).toBeHidden();
    await page.screenshot({ path: info.outputPath("map-summary.png") });
    await page.locator("#map-open-details").scrollIntoViewIfNeeded();
    await expect(page.locator("#map-open-details")).toBeInViewport({
      ratio: 1,
    });
    await page.locator("#map-open-details").click();
    await expect(page.locator("#panel-details")).toBeVisible();
    await page.locator("#result-back").click();
    await page.locator('[data-journey="comparison"]').click();
    await page.locator("#panel-map-toggle").click();
    await expect(summary.locator(".route-choice-arrival .icon")).toHaveCount(1);
    await expect(summary.locator(".route-recommendation")).toHaveCount(0);
    await expect(
      summary.locator('.route-effort-metric[data-kind="walk"]'),
    ).toHaveCount(0);
    await expect(summary.locator(".sr-only")).toContainText("Fahrradvergleich");
    await expect(
      summary.locator('.route-effort-metric[data-kind="bike"]'),
    ).toHaveText("1 h 5 min Rad");
    await expect(
      summary.locator('.route-effort-metric[data-kind="transfer"]'),
    ).toHaveText("0 Umst.");
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.selected.isDirect = false;
      for (const leg of state.selected.legs) leg.kind = "transit";
      view.render(state);
    });
    await expect(
      summary.locator('.route-effort-metric[data-kind="bike"]'),
    ).toHaveCount(0);
    await expect(summary.locator(".route-effort-metric")).toHaveText("0 Umst.");
    await expect(summary.locator(".sr-only")).not.toContainText("0 min Rad");
    const transitCard = page.locator('[data-journey="comparison"]');
    await expect(transitCard.locator(".route-effort-metric")).toHaveText(
      "0 Umst.",
    );
    await expect(transitCard).not.toHaveAccessibleName(/\d+ min Rad/);
  });
}

test("map summary keeps midnight dates and changing status without repeating its timestamp", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.selected.departure = Date.parse("2026-09-11T23:50:00+02:00") / 1000;
    state.selected.arrival = state.selected.departure + 55 * 60;
    view.render(state, 30);
  });
  await page.locator("#panel-map-toggle").click();
  const summary = page.locator("#map-preview-summary");
  await expect(summary.locator(".route-choice-arrival")).toHaveText(
    "12. Sept. 00:45 an",
  );
  await expect(summary.locator(".route-choice-schedule")).toHaveText(
    "Ab 11. Sept. 23:50 · 55 min",
  );
  for (const [updates, message] of [
    [
      { busy: true, message: "Verbindungen optimieren" },
      "Verbindungen optimieren",
    ],
    [
      {
        busy: false,
        staleReason:
          "Zeitlimit erreicht. Bisherige Ergebnisse bleiben erhalten.",
      },
      "Zeitlimit erreicht. Bisherige Ergebnisse bleiben erhalten.",
    ],
    [{ restored: true }, "Zeiten wurden nicht aktualisiert."],
  ] as const) {
    await page.evaluate((updates) => {
      const { state, view } = (window as any).uxPreview;
      Object.assign(state, updates);
      view.render(state, 30);
    }, updates);
    await expect(page.locator("#map-preview-status")).toContainText(message);
    expect(
      (await page.locator("#map-preview-status").boundingBox())!.y,
    ).toBeGreaterThan((await summary.boundingBox())!.y);
  }
  await expect(page.locator("#result-stand")).toContainText("Gespeichert:");
  await expect(page.locator("#map-preview-status")).not.toContainText(
    "Gespeicherter Stand",
  );
});

test("symbol routes preserve bus lines, transfers, stops and older snapshots", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await preview(page);
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    const journey = state.journeys[0];
    const transit = journey.legs.find((leg: any) => leg.kind === "transit");
    transit.mode = "BUS";
    transit.line = "42";
    journey.legs.splice(
      journey.legs.indexOf(transit) + 1,
      0,
      { ...transit, kind: "wait" },
      { ...transit, mode: "REGIONAL_RAIL", line: "RE 1" },
      { ...transit, mode: undefined, line: undefined },
      {
        ...transit,
        kind: "stop",
        from: {
          ...transit.from,
          name: "Zwischenstopp <Marktplatz> mit einem längeren Ortsnamen",
        },
      },
    );
    journey.transfers = 2;
    state.restored = true;
    document.documentElement.style.fontSize = "24px";
    view.render(state);
  });
  const card = page.locator('[data-journey="best"]');
  await expect(card.locator(".route-line")).toHaveText(["42", "RE 1", "ÖPNV"]);
  await expect(card.locator('.route-stage[data-symbol="bus"]')).toHaveCount(1);
  await expect(card.locator('.route-stage[data-symbol="transit"]')).toHaveCount(
    2,
  );
  await expect(
    card.locator('.route-stage[data-symbol="bus"] .icon'),
  ).toHaveCount(1);
  await expect(
    card.locator(".route-stage").filter({ hasText: "RE 1" }).locator(".icon"),
  ).toHaveCount(0);
  await expect(
    card.locator(".route-stage").filter({ hasText: "ÖPNV" }).locator(".icon"),
  ).toHaveCount(1);
  await expect(card.locator(".route-stage")).toHaveCount(7);
  await expect(card.locator(".route-stop-name")).toHaveText(
    "Zwischenstopp <Marktplatz> mit einem längeren Ortsnamen",
  );
  await expect(card.locator(".route-stop-name marktplatz")).toHaveCount(0);
  await expect(
    card.locator('.route-effort-metric[data-kind="transfer"]'),
  ).toHaveText("2 Umst.");
  await expect(card).toHaveAccessibleName(
    /14 min Rad · 2 Umstiege\. Rad → 42 → RE 1 → ÖPNV → Stopp:/,
  );
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("symbol-route-large-text.png"),
  });
  await page.locator('[data-journey="best"]').click();
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await page.locator("#result-back").click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(card).toHaveCSS("border-color", "rgb(23, 26, 28)");
  await expect(page.locator('.route-choice[aria-pressed="true"]')).toHaveCount(
    1,
  );
  await page.locator("#panel-map-toggle").click();
  const mapSummary = page.locator("#map-preview-summary");
  await expect(mapSummary.locator(".route-line")).toHaveText([
    "42",
    "RE 1",
    "ÖPNV",
  ]);
  await expect(mapSummary.locator(".route-stop-name")).toHaveText(
    "Zwischenstopp <Marktplatz> mit einem längeren Ortsnamen",
  );
  await expect(
    mapSummary.locator('.route-effort-metric[data-kind="transfer"]'),
  ).toHaveText("2 Umst.");
  expect(
    await mapSummary.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.locator("#map-open-details").scrollIntoViewIfNeeded();
  await expect(page.locator("#map-open-details")).toBeInViewport({ ratio: 1 });
  await page.screenshot({
    path: info.outputPath("map-summary-large-text.png"),
  });
});

test("same-ID updates retain reading position and keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.locator('[data-journey="selected"]').click();
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await page.locator("#panel-content").evaluate((e) => (e.scrollTop = 160));
  const scroll = await page
    .locator("#panel-content")
    .evaluate((e) => e.scrollTop);
  await page.locator("#adjust-route").focus();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys[1].legs[0].end += 60;
    view.render(state, 30);
  });
  await expect(page.locator("#journey-effort")).toContainText("15 min Rad");
  await expect(page.locator("#adjust-route")).toBeFocused();
  await expect(page.locator("#panel-content")).toHaveJSProperty(
    "scrollTop",
    scroll,
  );
});

test("desktop resize preserves selection and returns to mobile itinerary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.locator('[data-journey="third"]').click();
  await page.locator(".route-choice-row.selected .route-detail-link").click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator("#choices")).toBeVisible();
  await expect(page.locator("#panel-details")).toBeVisible();
  await expect(page.locator("#map")).toHaveJSProperty("inert", false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#choices")).toBeHidden();
  await expect(page.locator("#journey-heading")).toContainText("1 h");
});

for (const [width, height] of [
  [320, 568],
  [844, 390],
  [390, 844],
]) {
  test(`200% text and long places keep content and actions reachable at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await preview(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      const { state, view } = (window as any).uxPreview;
      state.request.origin.name = "München Hauptbahnhof, Ausgang Arnulfstraße";
      state.request.destination.name = "Bahnhofstraße 3a, 82166 Gräfelfing";
      view.render(state, 30);
    });
    await page.locator('[data-journey="selected"]').click();
    await page.locator(".route-choice-row.selected .route-detail-link").click();
    await page.locator("#adjust-route").scrollIntoViewIfNeeded();
    await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
    await page.locator("#result-back").scrollIntoViewIfNeeded();
    await page.locator("#result-back").click();
    const comparison = page.locator('[data-journey="comparison"]');
    // At large text sizes a card can exceed the viewport. Every summary part
    // must remain reachable by scrolling, and the whole card must stay usable.
    for (const selector of [
      ".route-choice-arrival",
      ".route-choice-schedule",
      ".route-outline",
      ".route-effort-label",
      '.route-effort-metric[data-kind="bike"]',
      '.route-effort-metric[data-kind="transfer"]',
    ]) {
      const content = comparison.locator(selector);
      await content.scrollIntoViewIfNeeded();
      // Scroll positions round to pixels; tolerate subpixel clipping at the edge.
      await expect(content).toBeInViewport({ ratio: 0.99 });
    }
    await comparison.focus();
    await comparison.press("Enter");
    await expect(comparison).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
for (const width of [320, 390, 1280]) {
  test(`one start action follows selection and the menu returns focus at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await expect(page.locator("#route-origin")).toHaveText("Start");
    await expect(page.locator("#route-destination")).toHaveText("Ziel");
    await expect(page.locator("#route-start-duration")).toHaveText("55 min");
    await expect(page.locator("#navigation-start")).toHaveAccessibleName(
      "Navigation starten",
    );
    await expect(page.locator(".panel-actions .primary:visible")).toHaveCount(
      1,
    );
    await expect(page.locator(".panel-actions #adjust-route")).toHaveCount(0);
    await page.locator('[data-journey="best"]').click();
    await expect(page.locator("#route-start-duration")).toHaveText("50 min");
    await expect(page.locator("#route-start-arrival")).toContainText("10:50");
    if (width < 900) {
      await expect(page.locator("#navigation-start")).toBeInViewport({
        ratio: 1,
      });
      await expect(page.locator("#route-request-meta")).toBeVisible();
    }
    await page.locator("#route-more").click();
    await expect(page.locator("#route-actions-dialog")).toBeVisible();
    await expect(page.locator("#refresh-route")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#route-more")).toBeFocused();
    await expect(page.locator("#route-actions-dialog")).toBeHidden();
    await page.screenshot({
      path: test.info().outputPath("preview-start.png"),
    });
  });
}

for (const width of [320, 390, 1280]) {
  test(`selection stays in place and only Details opens the itinerary at ${width}`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-09-11T08:00:00Z"));
    await preview(page);
    const first = page.locator('[data-journey="best"]');
    const details = page.locator(
      ".route-choice-row.selected .route-detail-link",
    );
    await expect(page.locator(".route-detail-link:visible")).toHaveCount(1);
    await first.scrollIntoViewIfNeeded();
    const geometry = () =>
      page.locator(".route-choice-row").evaluateAll((rows) =>
        rows.map((row) => {
          const box = row.getBoundingClientRect();
          return { top: box.top, height: box.height };
        }),
      );
    const before = await geometry();
    const scroll = await page
      .locator("#panel-content")
      .evaluate((e) => e.scrollTop);
    await first.click();
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#choices")).toBeVisible();
    expect(await geometry()).toEqual(before);
    await expect(page.locator("#panel-content")).toHaveJSProperty(
      "scrollTop",
      scroll,
    );
    await expect(page.locator("body")).not.toHaveAttribute("data-detail-opens");
    expect((await details.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(first.locator(".route-choice-arrival")).toHaveText("10:50 an");
    await expect(first.locator(".route-choice-schedule")).toHaveText(
      "Ab 10:00 · 50 min",
    );
    expect(
      await first.evaluate((card) => {
        const detail = card
          .parentElement!.querySelector(".route-detail-link")!
          .getBoundingClientRect();
        return [...card.querySelectorAll(".route-effort-metric")].every(
          (metric) => {
            const box = metric.getBoundingClientRect();
            return box.right <= detail.left || box.bottom <= detail.top;
          },
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("minimal-details.png") });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-journey="selected"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#choices")).toBeVisible();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(details).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#journey-heading")).toBeFocused();
    await expect(page.locator("body")).toHaveAttribute(
      "data-detail-opens",
      "1",
    );
    if (width < 900) {
      await expect(page.locator("#choices")).toBeHidden();
      await page.locator("#result-back").click();
      await expect(details).toBeFocused();
    }
  });
}

for (const width of [320, 390, 1280]) {
  test(`open itinerary groups preparation and exposes boarding at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const selected = state.selected;
      const from = selected.origin;
      const station = { ...from, name: "München Pasing – Bahnhofsvorplatz" };
      const next = {
        ...from,
        name: "München Hauptbahnhof, Ausgang Arnulfstraße",
      };
      const end = { ...from, name: "Karlsplatz (Stachus)" };
      let time = Date.parse("2026-10-15T21:40:00Z") / 1000;
      const step = (
        kind: string,
        minutes: number,
        origin: any,
        destination: any,
        extra = {},
      ) => {
        const start = time;
        time += minutes * 60;
        return {
          kind,
          start,
          end: time,
          from: origin,
          to: destination,
          distance: 1000,
          coordinates: [origin, destination],
          ...extra,
        };
      };
      selected.departure = time;
      selected.legs = [
        step("bike", 10, from, station),
        step("fold", 3, station, station),
        step("wait", 2, station, station),
        step("transit", 15, station, next, {
          line: "S6",
          headsign: "Ebersberg",
          platform: "4",
          arrivalPlatform: "2",
          realtime: true,
        }),
        step("walk", 3, next, end),
        step("transit", 5, end, end),
        step("stop", 10, end, end, { stop: { place: end, stayMinutes: 10 } }),
        step("unfold", 3, end, end),
        step("bike", 5, end, selected.destination),
      ];
      selected.arrival = time;
      state.request.time = selected.departure;
      state.queriedAt = selected.departure;
      view.render(state, 30);
    });
    await page.locator(".route-choice-row.selected .route-detail-link").click();
    await expect(page.locator(".detail-step")).toHaveCount(9);
    await expect(
      page
        .locator(".journey-section")
        .filter({ has: page.locator('[data-kind="fold"]') }),
    ).toContainText("S6");
    const transit = page.locator('.detail-step[data-kind="transit"]').first();
    await expect(transit.locator(".detail-heading")).toContainText(
      "23:55 · S6",
    );
    await expect(transit).toContainText("Richtung Ebersberg");
    await expect(transit.locator(".detail-platform")).toHaveText([
      "Gleis / Steig 4",
      "Gleis / Steig 2",
    ]);
    await expect(transit.locator(".detail-arrival")).toContainText(
      "16. Okt. 00:10 · Ausstieg",
    );
    await expect(transit.locator(".detail-source")).toHaveText(
      "Echtzeitdaten zum Zeitpunkt der Abfrage",
    );
    await expect(
      page
        .locator('.detail-step[data-kind="transit"]')
        .last()
        .locator(".detail-platform"),
    ).toHaveCount(0);
    await expect(page.locator('.detail-step[data-kind="stop"]')).toContainText(
      "Geplanter Aufenthalt: 10 min",
    );
    await page.screenshot({ path: info.outputPath("open-itinerary.png") });
    await transit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("boarding-and-exit.png") });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      const { state, view } = (window as any).uxPreview;
      state.restored = true;
      view.render(state, 30);
    });
    await expect(transit.locator(".detail-source")).toHaveText(
      "Gespeicherte Fahrplanangabe",
    );
    expect(
      await page
        .locator("#journey-detail")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("open-itinerary-large-text.png"),
    });
    if (width < 900) {
      await page.locator("#result-back").click();
      await expect(
        page.locator(".route-choice-row.selected .route-detail-link"),
      ).toBeFocused();
    }
  });
}

for (const width of [320, 390, 1280]) {
  test(`transit details show scheduled and delayed times at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const selected = state.selected;
      const start = Date.parse("2026-10-16T10:35:00Z") / 1000;
      const end = Date.parse("2026-10-16T13:09:00Z") / 1000;
      selected.departure = start;
      selected.arrival = end;
      selected.legs = [
        {
          kind: "transit",
          from: { ...selected.origin, name: "München Hbf" },
          to: { ...selected.destination, name: "Mannheim Hauptbahnhof" },
          start,
          end,
          scheduledStart: start - 900,
          scheduledEnd: end - 300,
          line: "ICE 916",
          headsign: "Dortmund Hbf",
          platform: "13",
          arrivalPlatform: "3",
          realtime: true,
          distance: 0,
          coordinates: [selected.origin, selected.destination],
        },
      ];
      state.request.time = start;
      state.queriedAt = start;
      view.render(state, 30);
    });
    await page.locator(".route-choice-row.selected .route-detail-link").click();
    const transit = page.locator('.detail-step[data-kind="transit"]');
    const departureDelay = transit.locator(
      '.detail-delay[data-event="departure"]',
    );
    const arrivalDelay = transit.locator('.detail-delay[data-event="arrival"]');
    await expect(transit.locator(".detail-heading")).toContainText(
      "Ab 12:20 · ICE 916",
    );
    await expect(transit.locator(".detail-arrival strong")).toContainText(
      "15:04 · Ausstieg",
    );
    await expect(departureDelay.locator('[aria-hidden="true"]')).toHaveText(
      "12:35 · +15 min",
    );
    await expect(arrivalDelay.locator('[aria-hidden="true"]')).toHaveText(
      "15:09 · +5 min",
    );
    await expect(departureDelay).toHaveCSS("color", "rgb(180, 35, 50)");
    await expect(transit.locator(".detail-heading")).toHaveCSS(
      "text-decoration-line",
      "none",
    );
    await expect(departureDelay.locator(".sr-only")).toHaveText(
      "Voraussichtlich Abfahrt 12:35, 15 Minuten Verspätung.",
    );
    await expect(transit.locator(".detail-source")).toHaveText(
      "Echtzeitdaten zum Zeitpunkt der Abfrage",
    );
    await transit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("delayed-transit.png") });

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(
      await page
        .locator("#journey-detail")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(
      await transit
        .locator(".detail-delay")
        .evaluateAll((elements) =>
          elements.every(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ),
    ).toBe(true);
    // A visible multiline heading at 200% text does not expose the delay below it.
    await departureDelay.scrollIntoViewIfNeeded();
    await expect(departureDelay).toBeInViewport();
    await page.screenshot({
      path: info.outputPath("delayed-transit-large-text.png"),
    });

    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
      const { state, view } = (window as any).uxPreview;
      const train = state.selected.legs[0];
      train.start = train.scheduledStart + 300;
      state.selected.departure = train.start;
      view.render(state, 30);
    });
    await expect(departureDelay.locator('[aria-hidden="true"]')).toHaveText(
      "12:25 · +5 min",
    );
    await expect(arrivalDelay.locator('[aria-hidden="true"]')).toHaveText(
      "15:09 · +5 min",
    );

    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const train = state.selected.legs[0];
      train.transitReference = {
        tripId: "trip",
        fromId: "from",
        toId: "to",
        scheduledDeparture: train.scheduledStart,
        scheduledArrival: train.scheduledEnd,
      };
      delete train.scheduledEnd;
      state.restored = true;
      view.render(state, 30);
    });
    await expect(transit.locator(".detail-source")).toHaveText(
      "Gespeicherte Fahrplanangabe",
    );
    await expect(arrivalDelay.locator('[aria-hidden="true"]')).toHaveText(
      "15:09 · +5 min",
    );
    await expect(departureDelay.locator(".sr-only")).toHaveText(
      "Gespeicherte Prognose: Abfahrt 12:25, 5 Minuten Verspätung.",
    );

    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      const train = state.selected.legs[0];
      train.start = train.scheduledStart;
      train.end = train.transitReference.scheduledArrival;
      state.selected.departure = train.start;
      state.selected.arrival = train.end;
      state.restored = false;
      view.render(state, 30);
    });
    await expect(transit.locator(".detail-delay")).toHaveCount(0);
    await expect(transit.locator(".detail-heading")).toHaveText(
      "Ab 12:20 · ICE 916",
    );
    await expect(transit.locator(".detail-arrival strong")).toHaveText(
      "15:04 · Ausstieg",
    );
  });
}
