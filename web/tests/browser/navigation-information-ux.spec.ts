import { expect, test } from "./test";
import { previewNavigation } from "./navigation-preview";

test("compact continue belongs to the selected running stop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previewNavigation(page, 5);
  const fold = page.getByRole("tab", { name: /^Falten nach/ });
  const complete = page.locator("#navigation-complete");
  await fold.click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(fold).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-section-preview-title")).toHaveText(
    "Falten",
  );
  await expect(complete).toBeHidden();
  const before = await page.evaluate(
    () => (window as any).navigationPreview.session.engine.progress,
  );
  await complete.evaluate((button: HTMLButtonElement) => button.click());
  expect(
    await page.evaluate(
      () => (window as any).navigationPreview.session.engine.progress,
    ),
  ).toEqual(before);
  await page.locator('[role="tab"][aria-current="step"]').click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(complete).toBeVisible();
  await expect(complete).toHaveText("Weiterfahren");
  await complete.click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Auf Weiterfahrt warten",
  );
  await expect(page.locator("#navigation-confirm")).toBeHidden();
});

for (const width of [320, 390])
  test(`collapsing details preserves folding and exit only belongs to the selected train at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await previewNavigation(page);
    const fold = page.getByRole("tab", { name: /^Falten nach/ });
    const train = page.getByRole("tab", { name: /^S1 nach/ });
    const toggle = page.locator("#navigation-details-toggle");
    const complete = page.locator("#navigation-complete");
    const content = page.locator("#navigation-section-content");
    const before = await page.evaluate(
      () => (window as any).navigationPreview.session.engine.progress,
    );
    await fold.click();
    await toggle.click();
    await expect(content).toContainText("Falten");
    const stripLeft = await page
      .getByRole("tablist")
      .evaluate((strip) => strip.scrollLeft);
    await toggle.click();
    await expect(page.locator("#navigation-details")).toBeHidden();
    await expect(fold).toHaveAttribute("aria-selected", "true");
    await expect(train).toHaveAttribute("aria-selected", "false");
    await expect(train).toHaveAttribute("aria-current", "step");
    expect(
      await page.getByRole("tablist").evaluate((strip) => strip.scrollLeft),
    ).toBeCloseTo(stripLeft, 0);
    await expect(page.locator("#navigation-section-preview")).toHaveText(
      "Falten2 minBahnhof",
    );
    await expect(toggle).toHaveAccessibleDescription("Falten 2 min Bahnhof");
    await expect(page.locator("#navigation-stations-preview")).toBeHidden();
    await expect(complete).toBeHidden();
    await complete.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#navigation-confirm")).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as any).navigationPreview.session.engine.progress,
      ),
    ).toEqual(before);
    await toggle.click();
    await expect(fold).toHaveAttribute("aria-selected", "true");
    await expect(content).toContainText("Falten");
    await expect(page.locator("#navigation-section-preview")).toBeHidden();
    const grip = (await page.locator(".navigation-grip").boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 1);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 50, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("#navigation-details")).toBeHidden();
    await expect(fold).toHaveAttribute("aria-selected", "true");
    await expect(complete).toBeHidden();
    await toggle.press("ArrowUp");
    await expect(content).toBeVisible();
    await expect(content).toContainText("Falten");
    await train.click();
    await toggle.click();
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#navigation-stations-preview")).toContainText(
      "Stadtmitte",
    );
    await expect(complete).toHaveText("Ausgestiegen");
    await complete.click();
    await expect(page.locator("#navigation-confirm-message")).toContainText(
      "S1 Richtung Altstadt",
    );
    await page.locator("#navigation-confirm-no").click();
    expect(
      await page.evaluate(
        () => (window as any).navigationPreview.session.engine.progress,
      ),
    ).toEqual(before);
  });

for (const [width, theme] of [
  [320, "light"],
  [390, "dark"],
] as const)
  test(`compact summaries stay with the selected section at ${width}px in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await previewNavigation(page);
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const sections = [
      { index: 0, title: "Rad", place: "Bahnhof", meta: "1 min · 370 m" },
      { index: 1, title: "Falten", place: "Bahnhof", meta: "2 min" },
      { index: 3, title: "Entfalten", place: "Ausstieg", meta: "3 min" },
      { index: 4, title: "Zu Fuß", place: "Café", meta: "1 min · 34 m" },
      { index: 5, title: "Zwischenziel", place: "Café", meta: "1 min" },
      { index: 6, title: "Rad", place: "Ziel", meta: "2 min · 169 m" },
    ];
    for (const section of sections) {
      const tab = page.getByRole("tab").nth(section.index);
      await tab.click();
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(page.locator("#navigation-details-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(
        page.locator("#navigation-section-preview-title"),
      ).toHaveText(section.title);
      await expect(page.locator("#navigation-section-preview-meta")).toHaveText(
        section.meta,
      );
      await expect(
        page.locator("#navigation-section-preview-place"),
      ).toHaveText(section.place);
      await expect(
        page.locator("#navigation-details-toggle"),
      ).toHaveAccessibleDescription(
        `${section.title} ${section.meta} ${section.place}`,
      );
      await expect(page.locator("#navigation-section-preview")).toBeInViewport({
        ratio: 1,
      });
      await expect(page.locator("#navigation-stations-preview")).toBeHidden();
      await expect(page.locator("#navigation-complete")).toBeHidden();
      await page.evaluate(() =>
        (window as any).navigationPreview.setLocation("current"),
      );
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#navigation-instruction")).toHaveText(
        "S1 Richtung Altstadt",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
  });

for (const [width, height] of [
  [320, 568],
  [844, 390],
] as const)
  for (const [index, label] of [
    [0, "Abschnitt fertig"],
    [1, "Rad gefaltet"],
    [3, "Rad entfaltet"],
    [4, "Abschnitt fertig"],
    [5, "Weiterfahren"],
  ] as const)
    test(`the selected running section keeps its compact action on leg ${index} at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await previewNavigation(page, index);
      const complete = page.locator("#navigation-complete");
      await expect(complete).toHaveText(label);
      await expect(complete).toBeInViewport({ ratio: 1 });
      await expect(page.locator("#navigation-quick-actions")).toContainText(
        label,
      );
      await page.locator("#navigation-details-toggle").click();
      await expect(complete).toHaveText(label);
      await expect(complete).toBeInViewport({ ratio: 1 });
    });

test("another selected train uses its own compact itinerary without the running train's progress", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previewNavigation(page);
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationPreview;
    const journey = session.engine.journey;
    session.engine.leg.transitStatus = { updatedAt: Date.now() / 1000 };
    const departure = journey.legs.at(-1).end + 600;
    journey.legs.push({
      ...session.engine.leg,
      navigationId: "preview-second-train",
      line: "S2",
      headsign: "Anderes Ziel",
      from: { ...session.engine.leg.from, name: "Umstieg" },
      to: { ...session.engine.leg.to, name: "Anderer Ausstieg" },
      start: departure,
      end: departure + 300,
      transitStops: undefined,
      transitStatus: { updatedAt: Date.now() / 1000, failure: "network" },
    });
    journey.arrival = departure + 300;
    view.render();
  });
  const second = page.getByRole("tab", { name: /^S2 nach/ });
  await second.click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-section-preview-title")).toHaveText(
    "S2 Richtung Anderes Ziel",
  );
  await expect(page.locator("#navigation-section-preview-meta")).toContainText(
    "Umstieg · Ab",
  );
  await expect(page.locator("#navigation-section-preview-place")).toContainText(
    "Anderer Ausstieg · An",
  );
  await expect(page.locator("#navigation-stations-preview")).toBeHidden();
  await expect(page.locator("#navigation-complete")).toBeHidden();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "S1 Richtung Altstadt",
  );
  await expect(page.locator("#navigation-alert-summary")).toContainText(
    "S2 · Abruf fehlgeschlagen",
  );
  await page.locator("#navigation-alert-open").click();
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-transit-status")).toBeInViewport({
    ratio: 1,
  });
});

for (const width of [320, 390])
  test(`long transit details reopen at the current stop without interrupting manual scrolling at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install({ time: new Date("2026-10-21T07:18:00Z") });
    await page.route("https://tiles.openfreemap.org/**", (route) =>
      route.abort(),
    );
    await page.goto(
      "/preview/navigation-scene.html?theme=dark&state=scroll-ride",
    );
    const details = page.locator("#navigation-details");
    const toggle = page.locator("#navigation-details-toggle");
    const current = page.locator(
      '#navigation-stations-detail [data-index="20"]',
    );
    const next = page.locator('#navigation-stations-detail [data-index="21"]');
    const train = page.getByRole("tab", { name: /^S8 nach/ });
    const currentOffset = () =>
      current.evaluate((row) => {
        const details = document.getElementById("navigation-details")!;
        return (
          row.getBoundingClientRect().top -
          details.getBoundingClientRect().top -
          details.clientTop
        );
      });
    await expect(details).toBeVisible();
    await page.clock.runFor(2200);
    await expect(
      page.locator("#navigation-stations-detail .navigation-station"),
    ).toHaveCount(41);
    await expect(current).toContainText("Hauptbahnhof");
    await expect(next).toHaveAttribute("aria-current", "step");
    await expect(current).toBeInViewport();
    await expect(next).toBeInViewport();
    expect(await currentOffset()).toBeCloseTo(16, 0);
    await details.evaluate(
      (element) => (element.scrollTop = element.scrollHeight),
    );
    await expect(
      page.locator('#navigation-stations-detail [data-exit="true"]'),
    ).toBeInViewport();
    const scrolled = await details.evaluate((element) => element.scrollTop);
    await page.clock.runFor(3000);
    expect(await details.evaluate((element) => element.scrollTop)).toBeCloseTo(
      scrolled,
      0,
    );
    await toggle.click();
    await toggle.click();
    expect(await currentOffset()).toBeCloseTo(16, 0);
    await expect(next).toBeInViewport();
    await details.evaluate(
      (element) => (element.scrollTop = element.scrollHeight),
    );
    await train.click();
    expect(await currentOffset()).toBeCloseTo(16, 0);
    await page.screenshot({
      path: info.outputPath("navigation-current-stops.png"),
    });
  });

for (const [width, height] of [
  [320, 568],
  [390, 844],
  [844, 390],
])
  test(`station flow stays above the menu and action when expanded at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await previewNavigation(page);
    const tabs = page.locator("#navigation-phases-slot");
    const action = page.locator("#navigation-quick-actions");
    const preview = await page
      .locator("#navigation-stations-preview")
      .boundingBox();
    const beforeTabs = (await tabs.boundingBox())!;
    const beforeAction = (await action.boundingBox())!;
    expect(preview!.y + preview!.height).toBeLessThanOrEqual(beforeTabs.y + 1);
    expect(beforeTabs.y + beforeTabs.height).toBeLessThanOrEqual(
      beforeAction.y + 1,
    );
    await page.locator("#navigation-details-toggle").click();
    const details = page.locator("#navigation-details");
    const expanded = (await details.boundingBox())!;
    const afterTabs = (await tabs.boundingBox())!;
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(afterTabs.y + 1);
    if (height >= 568) {
      expect(afterTabs.y).toBeCloseTo(beforeTabs.y, 0);
      expect((await action.boundingBox())!.y).toBeCloseTo(beforeAction.y, 0);
    }
    await expect(page.locator("#navigation-complete")).toBeInViewport();
    await details.evaluate(
      (element) => (element.scrollTop = element.scrollHeight),
    );
    expect((await tabs.boundingBox())!.y).toBeCloseTo(afterTabs.y, 0);
    await expect(page.locator("#navigation-complete")).toBeInViewport();
    await page.screenshot({
      path: info.outputPath("stable-navigation-footer.png"),
    });
  });

test("compact station gap names only the omitted stops that are served", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await previewNavigation(page);
  const gap = page.locator(
    "#navigation-stations-preview .navigation-station-gap",
  );
  await expect(gap).toHaveText("1 Zwischenhalt");
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationPreview;
    session.engine.leg.transitStops[2].cancelled = true;
    view.render();
  });
  await expect(gap).toHaveCount(0);
});

test("panel resizes continuously while menu, action and centered grip stay anchored", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await previewNavigation(page);
  await page.locator("#navigation-panel").evaluate((panel) => {
    for (const animation of panel.getAnimations()) animation.finish();
  });
  const samples = await page.evaluate(() => {
    const panel = document.getElementById("navigation-panel")!;
    const menu = document.getElementById("navigation-phases-slot")!;
    const action = document.getElementById("navigation-complete")!;
    const toggle = document.getElementById("navigation-details-toggle")!;
    const initialMenuTop = menu.getBoundingClientRect().top;
    const initialActionTop = action.getBoundingClientRect().top;
    const samples = [];
    // Reverse mid-transition to verify continuity from the visible height.
    for (let i = 0; i < 4; i++) {
      const beforeHeight = panel.getBoundingClientRect().height;
      toggle.click();
      const animations = panel.getAnimations();
      for (const animation of animations) animation.pause();
      for (const time of [0, 80, 160, 240]) {
        for (const animation of animations) animation.currentTime = time;
        const panelBox = panel.getBoundingClientRect();
        const menuBox = menu.getBoundingClientRect();
        const actionBox = action.getBoundingClientRect();
        const gripBox = document
          .querySelector(".navigation-grip")!
          .getBoundingClientRect();
        samples.push({
          opening: i % 2 === 0,
          time,
          beforeHeight,
          height: panelBox.height,
          menuShift: Math.abs(menuBox.top - initialMenuTop),
          actionShift: Math.abs(actionBox.top - initialActionTop),
          gripOffset: Math.abs(
            gripBox.left +
              gripBox.width / 2 -
              (panelBox.left + panelBox.width / 2),
          ),
          visible: actionBox.bottom <= innerHeight && menuBox.top >= 0,
          animations: animations.length,
        });
      }
    }
    for (const animation of panel.getAnimations()) animation.finish();
    return samples;
  });
  let previousHeight = 0;
  for (const sample of samples) {
    if (sample.time === 0)
      expect(Math.abs(sample.height - sample.beforeHeight)).toBeLessThan(1);
    else if (sample.opening)
      expect(sample.height).toBeGreaterThan(previousHeight);
    else expect(sample.height).toBeLessThan(previousHeight);
    previousHeight = sample.height;
    expect(sample.menuShift).toBeLessThan(1);
    expect(sample.actionShift).toBeLessThan(1);
    expect(sample.gripOffset).toBeLessThan(1);
    expect(sample.visible).toBe(true);
    expect(sample.animations).toBeGreaterThan(0);
  }
  await expect
    .poll(() =>
      page
        .locator("#navigation-panel")
        .evaluate((panel) => panel.getAnimations().length),
    )
    .toBe(0);
});

for (const legIndex of [0, 2])
  test(`centered grip remains draggable and end button stays independent on leg ${legIndex}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await previewNavigation(page, legIndex);
    const grip = (await page.locator(".navigation-grip").boundingBox())!;
    const panel = (await page.locator("#navigation-panel").boundingBox())!;
    expect(grip.x + grip.width / 2).toBeCloseTo(panel.x + panel.width / 2, 0);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y - 45, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("#navigation-details-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.locator("#navigation-details-toggle").press("Escape");
    await page.locator("#navigation-end").click();
    await expect(page.locator("#navigation-confirm")).toBeVisible();
    await expect(page.locator("#navigation-details-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

for (const width of [320, 390, 1280])
  for (const colorScheme of ["light", "dark"] as const)
    test(`transit information appears once at ${width}px in ${colorScheme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await previewNavigation(page);
      await page.evaluate(() => {
        const { session, view } = (window as any).navigationPreview;
        const leg = session.engine.leg;
        leg.to.name = leg.transitStops.at(-1).name = "Pasing";
        leg.transitStops[1].name = "Rosenheimer Platz";
        leg.arrivalPlatform = "5";
        leg.distance = 11200;
        leg.transitStatus = { updatedAt: Date.now() / 1000 };
        view.render();
      });
      const navigation = page.locator("#navigation-view");
      const exit = page.locator(
        '.navigation-stations:visible [data-exit="true"]',
      );
      const assertSingleRail = async () => {
        await expect(
          navigation
            .getByText("Pasing", { exact: true })
            .filter({ visible: true }),
        ).toHaveCount(1);
        await expect(
          navigation
            .getByText("Rosenheimer Platz", { exact: true })
            .filter({ visible: true }),
        ).toHaveCount(1);
        await expect(exit).toContainText("Ausstieg in 3 Halten · Gleis 5");
        await expect(exit.locator("time")).toHaveText("12:10");
        await expect(page.locator("#navigation-distance")).toBeEmpty();
        await expect(page.locator("#navigation-detail")).toBeEmpty();
        await expect(page.locator("#navigation-context-title")).toBeHidden();
        await expect(page.locator("#navigation-context-detail")).toBeHidden();
      };
      await assertSingleRail();
      await expect(page.locator("#navigation-gps-status")).toBeVisible();
      await expect(page.locator("#navigation-context")).toBeHidden();
      if (width < 900)
        await page
          .getByRole("button", { name: "Reisedetails öffnen", exact: true })
          .click();
      await assertSingleRail();
      await expect(page.locator("#navigation-section-content")).toBeEmpty();
      await expect(page.locator("#navigation-transit-status")).toBeHidden();
      await expect(
        page.locator("#navigation-stations-announcement"),
      ).toContainText("Nächster Halt: Rosenheimer Platz");
      await expect(
        page.locator("#navigation-stations-announcement"),
      ).toContainText("Ausstieg Pasing");
      if (width < 900)
        await page
          .getByRole("button", { name: "Reisedetails schließen", exact: true })
          .click();
      await page.screenshot({
        path: info.outputPath("transit-information.png"),
      });
    });

test("next stop and exit share one row and estimated arrival still needs confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await previewNavigation(page);
  await page.clock.setFixedTime(new Date("2026-10-06T10:08:30Z"));
  await page.evaluate(() => (window as any).navigationPreview.view.render());
  const rail = page.locator("#navigation-stations-preview");
  await expect(rail.locator('[data-exit="true"]')).toHaveCount(1);
  await expect(rail.locator('[aria-current="step"]')).toHaveAttribute(
    "data-exit",
    "true",
  );
  await expect(rail).toContainText("Ausstieg am nächsten Halt");
  await page.clock.setFixedTime(new Date("2026-10-06T10:10:01Z"));
  await page.evaluate(() => (window as any).navigationPreview.view.render());
  await expect(page.locator("#navigation-context-status")).toHaveText(
    "Ausstieg laut Fahrzeiten erreicht",
  );
  await expect(page.locator("#navigation-complete")).toHaveText("Ausgestiegen");
  await expect(page.locator("#navigation-complete")).toBeInViewport();
  await page.locator("#navigation-complete").click();
  await expect(page.locator("#navigation-confirm")).toBeVisible();
  await page.locator("#navigation-confirm-no").click();
  await expect(page.locator("#navigation-instruction")).toContainText(
    "S1 Richtung",
  );
});

test("missing station data uses one exit summary without a stop count", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await previewNavigation(page);
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationPreview;
    session.engine.leg.to.name = "Pasing";
    session.engine.leg.arrivalPlatform = "5";
    session.engine.leg.transitStops = [];
    view.render();
  });
  await expect(page.locator("#navigation-stations-preview")).toBeHidden();
  await expect(page.locator("#navigation-context-title")).toHaveText("Pasing");
  await expect(page.locator("#navigation-context-detail")).toHaveText(
    "Ausstieg 12:10 · Gleis 5",
  );
  await expect(page.locator("#navigation-context-status")).toHaveText(
    "Stationsdaten nicht verfügbar",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-context-detail")).not.toContainText(
    "Halte",
  );
  await expect(page.locator("#navigation-section-content")).toBeEmpty();
});

test("waiting before boarding retains the selected train details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await previewNavigation(page);
  await page.clock.setFixedTime(new Date("2026-10-06T10:04:00Z"));
  await page.evaluate(async () => {
    const { NavigationEngine } = await import("/src/navigation-engine.ts");
    const { session, view } = (window as any).navigationPreview;
    const journey = session.engine.journey;
    const train = journey.legs[2];
    journey.legs.splice(2, 0, {
      kind: "wait",
      navigationId: "boarding-wait",
      from: train.from,
      to: train.from,
      start: train.start - 60,
      end: train.start,
      distance: 0,
      coordinates: [train.from],
    });
    session.engine = new NavigationEngine(journey, {
      legIndex: 2,
      maneuverIndex: 0,
      meters: 0,
      confirmedStops: [],
    });
    view.render();
  });
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Auf Weiterfahrt warten",
  );
  await expect(page.locator("#navigation-context-title")).toHaveText(
    "S1 · in 1 Min.",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-section-content")).toContainText(
    "Richtung Altstadt",
  );
});

test("local S8 preview shows the real compact navigation without success or audio notices", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date("2026-10-21T07:18:00Z") });
  await page.goto("/preview/navigation-scene.html?theme=dark");
  await page.clock.runFor(2000);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "S8 Richtung Herrsching",
  );
  await expect(page.locator("#navigation-alert")).toBeHidden();
  await expect(page.locator("#navigation-context")).toBeHidden();
  await expect(
    page.locator('#navigation-stations-preview [data-exit="true"]'),
  ).toContainText("PasingAusstieg in 10 Halten · Gleis 5");
  await page.screenshot({ path: info.outputPath("s8-navigation.png") });
  await page
    .locator("#navigation-panel")
    .screenshot({ path: info.outputPath("s8-panel-compact.png") });
  await page.goto("/preview/navigation-scene.html?theme=light&state=estimated");
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-locate")).toBeHidden();
  await expect(page.locator("#navigation-location-status")).toContainText(
    "Standort wird automatisch erneut angefragt.",
  );
  await expect(page.locator("#navigation-complete")).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("s8-navigation-expanded.png"),
  });
  await page.locator("#navigation-location").scrollIntoViewIfNeeded();
  await expect(page.locator("#navigation-complete")).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("s8-navigation-automatic-location.png"),
  });
  await page
    .locator("#navigation-panel")
    .screenshot({ path: info.outputPath("s8-panel-expanded.png") });
});
