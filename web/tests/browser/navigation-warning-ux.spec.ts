import { expect, test, type Page } from "./test";
import { previewNavigation } from "./navigation-preview";

async function longTrip(page: Page) {
  await previewNavigation(page);
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationPreview;
    const leg = session.engine.leg;
    leg.transitStatus = { updatedAt: Date.now() / 1000 };
    const first = leg.transitStops[0];
    const last = leg.transitStops.at(-1);
    leg.transitStops = Array.from({ length: 41 }, (_, index) => {
      const fraction = index / 40;
      return {
        ...first,
        name: `Haltestelle ${index + 1}`,
        stopId: `warning-preview-${index}`,
        latitude: first.latitude + (last.latitude - first.latitude) * fraction,
        longitude:
          first.longitude + (last.longitude - first.longitude) * fraction,
        arrival: leg.start + (leg.end - leg.start) * fraction,
        departure: leg.start + (leg.end - leg.start) * fraction,
      };
    });
    view.render();
  });
  await page.locator("#navigation-details-toggle").click();
  await expect(
    page.locator("#navigation-stations-detail .navigation-station"),
  ).toHaveCount(41);
}

for (const [width, height, theme] of [
  [320, 568, "light"],
  [390, 844, "dark"],
] as const) {
  test(`incoming warning stays pinned while long details scroll at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await longTrip(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const alert = page.locator("#navigation-alert");
    const details = page.locator("#navigation-details");
    const toggle = page.locator("#navigation-details-toggle");
    await expect(alert).toBeHidden();
    await details.evaluate((element) => {
      element.scrollTop = 450;
    });
    const before = await details.evaluate((element) => element.scrollTop);
    await page.evaluate(() => {
      const { session, view } = (window as any).navigationPreview;
      session.engine.leg.transitStatus = {
        updatedAt: Date.now() / 1000,
        cancelled: true,
        cancellationReason: "trip",
      };
      session.disruption = {
        id: "warning-test-cancelled",
        message: "S1: Fahrt fällt aus.",
      };
      view.render();
    });
    await expect(alert).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#navigation-alert-summary")).toContainText(
      "fällt aus",
    );
    expect(await details.evaluate((element) => element.scrollTop)).toBeCloseTo(
      before,
      0,
    );
    await expect(page.locator("#navigation-disruption")).toBeEmpty();
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await expect(page.locator("#navigation-alert-open")).toBeHidden();
    const header = (await page.locator("#navigation-summary").boundingBox())!;
    const pinned = (await alert.boundingBox())!;
    expect(pinned.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    for (const position of [0, 600, Number.MAX_SAFE_INTEGER]) {
      await details.evaluate((element, position) => {
        element.scrollTop = position;
      }, position);
      await expect(alert).toBeInViewport({ ratio: 1 });
      expect((await alert.boundingBox())!.y).toBeCloseTo(pinned.y, 0);
    }
    await expect(page.locator("#navigation-complete")).toBeInViewport({
      ratio: 1,
    });
    await toggle.click();
    await expect(details).toBeHidden();
    await expect(alert).toBeInViewport({ ratio: 1 });
    await toggle.click();
    await expect(alert).toBeInViewport({ ratio: 1 });
    await details.evaluate((element) => {
      element.scrollTop = 450;
    });
    const beforeResolved = await details.evaluate(
      (element) => element.scrollTop,
    );
    await page.evaluate(() => {
      const { session, view } = (window as any).navigationPreview;
      session.engine.leg.transitStatus = { updatedAt: Date.now() / 1000 };
      session.disruption = undefined;
      view.render();
    });
    await expect(alert).toBeHidden();
    expect(await details.evaluate((element) => element.scrollTop)).toBeCloseTo(
      beforeResolved,
      0,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  });
}

test("warning details keep a separately selected section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previewNavigation(page);
  const fold = page.getByRole("tab", { name: /^Falten nach/ });
  await fold.click();
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationPreview;
    session.engine.leg.transitStatus = {
      updatedAt: Date.now() / 1000,
      failure: "network",
    };
    view.render();
  });
  await expect(page.locator("#navigation-alert-summary")).toContainText(
    "Abruf fehlgeschlagen",
  );
  await page.locator("#navigation-alert-open").click();
  await expect(fold).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-section-content")).toContainText(
    "Falten",
  );
  await expect(
    page.locator("#navigation-current-transit-status"),
  ).toContainText("Abruf fehlgeschlagen");
  await expect(
    page.locator("#navigation-current-transit-status"),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.locator("#navigation-current-transit-status"),
  ).toBeFocused();
});

test("section tabs preserve compact and expanded states in the long S8 preview", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-21T07:18:00Z") });
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto(
    "/preview/navigation-scene.html?theme=dark&state=scroll-warning",
  );
  const fold = page.getByRole("tab", { name: /^Falten nach/ });
  const train = page.getByRole("tab", { name: /^S8 nach/ });
  const toggle = page.locator("#navigation-details-toggle");
  const details = page.locator("#navigation-details");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(page.locator("#navigation-section-content")).toContainText(
    "Falten",
  );
  await toggle.click();
  await expect(details).toBeHidden();
  await expect(train).toHaveAttribute("aria-selected", "false");
  await expect(fold).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-section-preview")).toHaveText(
    "Falten3 minOstbahnhof",
  );
  await expect(page.locator("#navigation-stations-preview")).toBeHidden();
  await expect(page.locator("#navigation-alert")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#navigation-complete")).toBeHidden();
  await page.clock.runFor(2000);
  await expect(fold).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: info.outputPath("compact-fold-selection.png"),
  });
  await train.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(details).toBeHidden();
  await expect(train).toHaveAttribute("aria-selected", "true");
  await expect(train).toBeFocused();
  await expect(page.locator("#navigation-stations-preview")).toContainText(
    "Hauptbahnhof",
  );
  await expect(page.locator("#navigation-stations-preview")).toContainText(
    "Testhalt 16",
  );
  await expect(page.locator("#navigation-complete")).toHaveText("Ausgestiegen");
  await train.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(details).toBeHidden();
  await page.screenshot({
    path: info.outputPath("compact-s8-tab-selection.png"),
  });
  await fold.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(details).toBeHidden();
  await expect(page.locator("#navigation-section-preview-title")).toHaveText(
    "Falten",
  );
  await toggle.press("ArrowUp");
  await expect(fold).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-section-content")).toContainText(
    "Falten",
  );
  await expect(page.locator("#navigation-complete")).toBeHidden();
  await train.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(details).toBeVisible();
  await expect(
    page.locator('#navigation-stations-detail [data-index="21"]'),
  ).toBeInViewport();
  await toggle.click();
  await expect(train).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-stations-preview")).toContainText(
    "Hauptbahnhof",
  );
  await expect(page.locator("#navigation-stations-preview")).toContainText(
    "Testhalt 16",
  );
  await expect(page.locator("#navigation-complete")).toHaveText("Ausgestiegen");
});

for (const width of [320, 390])
  test(`cancellation notices distinguish trip, endpoints and unknown causes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await previewNavigation(page);
    for (const [reason, message] of [
      ["trip", "Fahrt fällt aus"],
      ["boarding", "Halt in Bahnhof entfällt"],
      ["alighting", "Halt in Ausstieg entfällt"],
      ["both-stops", "Halte in Bahnhof und Ausstieg entfallen"],
      [undefined, "Verbindung nicht nutzbar"],
    ] as const) {
      await page.evaluate(async (cancellationReason) => {
        const { transitDisruption } = await import("/src/transit-refresh.ts");
        const { session, view } = (window as any).navigationPreview;
        session.engine.leg.transitStatus = {
          updatedAt: Date.now() / 1000,
          cancelled: true,
          cancellationReason,
        };
        session.disruption = transitDisruption(
          session.engine.journey,
          session.engine.progress.legIndex,
          Date.now() / 1000,
        );
        view.render();
      }, reason);
      await expect(page.locator("#navigation-alert-summary")).toHaveText(
        `S1: ${message}.`,
      );
      await expect(page.locator("#navigation-alert")).toBeInViewport({
        ratio: 1,
      });
      await expect(
        page.locator("#navigation-stations-announcement"),
      ).toBeEmpty();
      await expect(page.locator("#navigation-alert-open")).toBeHidden();
      await page.locator("#navigation-details-toggle").click();
      await expect(page.locator("#navigation-disruption")).toBeEmpty();
      await expect(page.locator("#navigation-transit-status")).toBeEmpty();
      expect(
        (await page.locator("#navigation-panel").innerText()).split(
          `S1: ${message}.`,
        ),
      ).toHaveLength(2);
      if (reason !== "trip")
        await expect(page.locator("#navigation-view")).not.toContainText(
          "Fahrt fällt aus",
        );
      await page.locator("#navigation-details-toggle").click();
    }
    await page.evaluate(() => {
      const { session, view } = (window as any).navigationPreview;
      session.engine.leg.transitStatus = { updatedAt: Date.now() / 1000 };
      session.disruption = undefined;
      view.render();
    });
    await expect(page.locator("#navigation-alert")).toBeHidden();
  });

for (const width of [320, 390, 1280])
  test(`boarding cancellation appears once in the selected section at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install({ time: new Date("2026-10-21T07:18:00Z") });
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      route.abort(),
    );
    await page.goto("/preview/navigation-scene.html?state=boarding-cancelled");
    const message = "S8: Halt in Ostbahnhof entfällt.";
    const toggle = page.locator("#navigation-details-toggle");
    const fold = page.getByRole("tab", { name: /^Falten nach/ });
    const train = page.getByRole("tab", { name: /^S8 nach/ });
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "S8 Richtung Herrsching",
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Geplante Abfahrt",
    );
    await expect(fold).toHaveAttribute("aria-selected", "true");
    if (width < 900) await toggle.click();
    for (const section of [fold, train, fold]) {
      await section.click();
      await page.clock.runFor(2000);
      expect(
        (await page.locator("#navigation-panel").innerText()).split(message),
      ).toHaveLength(2);
      if (width < 900) {
        await expect(page.locator("#navigation-alert-summary")).toHaveText(
          message,
        );
        await expect(page.locator("#navigation-alert-open")).toBeHidden();
        await expect(page.locator("#navigation-disruption")).toBeEmpty();
        await expect(page.locator("#navigation-transit-status")).toBeEmpty();
        await expect(
          page.locator("#navigation-current-transit-status"),
        ).toBeEmpty();
      } else {
        await expect(page.locator("#navigation-disruption")).toHaveText(
          message,
        );
      }
    }
    await page.screenshot({
      path: info.outputPath("boarding-warning-once.png"),
    });
    if (width < 900) {
      await toggle.click();
      expect(
        (await page.locator("#navigation-panel").innerText()).split(message),
      ).toHaveLength(2);
    }
    await expect(page.locator("#navigation-view")).not.toContainText(
      "Fahrt fällt aus",
    );
  });

test("a cancellation is counted once while separate offline details stay reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previewNavigation(page);
  await page.evaluate(async () => {
    const { transitDisruption } = await import("/src/transit-refresh.ts");
    const { session, view } = (window as any).navigationPreview;
    session.engine.leg.transitStatus = {
      updatedAt: Date.now() / 1000,
      cancelled: true,
      cancellationReason: "trip",
    };
    session.disruption = transitDisruption(
      session.engine.journey,
      session.engine.progress.legIndex,
      Date.now() / 1000,
    );
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    view.render();
  });
  await expect(page.locator("#navigation-alert-summary")).toHaveText(
    "S1: Fahrt fällt aus.",
  );
  await expect(page.locator("#navigation-alert-open")).toHaveText(
    "2 Hinweise ansehen",
  );
  await page.locator("#navigation-alert-open").click();
  await expect(page.locator("#navigation-network-status")).toBeInViewport({
    ratio: 1,
  });
  await expect(page.locator("#navigation-network-status")).toBeFocused();
  await expect(page.locator("#navigation-network-status")).toContainText(
    "Neue Routen und Fahrtdaten benötigen Internet",
  );
  expect(
    (await page.locator("#navigation-panel").innerText()).split(
      "S1: Fahrt fällt aus.",
    ),
  ).toHaveLength(2);
});

for (const theme of ["dark", "light"])
  for (const [state, message] of [
    ["scroll-warning", "S8: Fahrt fällt aus."],
    ["scroll-exit-cancelled", "S8: Halt in Pasing entfällt."],
  ]) {
    test(`local ${state} preview keeps its warning while scrolling in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.clock.install({ time: new Date("2026-10-21T07:18:00Z") });
      await page.route("https://tiles.openfreemap.org/**", (route) =>
        route.abort(),
      );
      await page.goto(
        `/preview/navigation-scene.html?theme=${theme}&state=${state}`,
      );
      await page.clock.runFor(2000);
      await expect(
        page.locator("#navigation-stations-detail .navigation-station"),
      ).toHaveCount(41);
      await expect(page.locator("#navigation-alert-summary")).toContainText(
        message,
      );
      await expect
        .poll(() =>
          page
            .locator("#navigation-details")
            .evaluate((element) => element.clientHeight),
        )
        .toBeGreaterThan(200);
      const alert = page.locator("#navigation-alert");
      const top = (await alert.boundingBox())!.y;
      await page.locator("#navigation-details").evaluate((element) => {
        element.scrollTop = 600;
      });
      await page.clock.runFor(2000);
      await expect(alert).toBeInViewport({ ratio: 1 });
      expect((await alert.boundingBox())!.y).toBeCloseTo(top, 0);
      await page.screenshot({
        path: info.outputPath(`sticky-warning-${theme}.png`),
      });
      await expect(page.locator("#navigation-alert-open")).toBeHidden();
      expect(
        (await page.locator("#navigation-panel").innerText()).split(message),
      ).toHaveLength(2);
    });
  }
