import { test, expect } from "./test";
import { expectMotionSettled } from "./assertions";
import {
  now,
  c,
  d,
  e,
  f,
  route,
  stationJourney,
  setup,
  complete,
  expectTabVisible,
  expectCurrentTabAligned,
  expectMobileCredit,
  savedActive,
  savedProgress,
} from "./navigation-fixture";

for (const width of [390, 1280]) {
  test(`navigation omits the arrival footer and keeps compact current sections at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route();
    journey.legs.push({
      kind: "walk",
      from: c,
      to: d,
      start: now + 60,
      end: now + 180,
      distance: 200,
      coordinates: [c, d],
    });
    journey.destination = d;
    journey.arrival = now + 180;
    await setup(page, false, true, {}, journey);
    if (width < 900) {
      await expect(page.locator("#navigation-summary-arrival")).toHaveCount(0);
      await expect(page.locator("#navigation-summary-label")).toBeVisible();
      await expect(page.locator("#navigation-summary-label")).toHaveText(
        "Reisedetails",
      );
    }
    await expect(page.locator("#navigation-summary-arrival")).toHaveCount(0);
    await expect(
      page.locator("#navigation-details-toggle"),
    ).not.toHaveAttribute("aria-describedby", /navigation-summary-arrival/);
    await expect(page.locator("#navigation-remaining")).toBeHidden();
    await expect(page.locator("#navigation-remaining")).toBeEmpty();
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-summary-arrival")).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Gesamte Reise" }),
    ).toHaveCount(0);
    const details = page.locator("#navigation-section-content");
    await expect(details).toHaveText("Geplant: 1 min · 370 m");
    await expect(page.locator("#navigation-stage")).toHaveClass("sr-only");
    await expect(page.locator("#navigation-complete")).toBeVisible();
    const walk = page.getByRole("tab", { name: /^Zu Fuß nach Ausstieg/ });
    const progress = await savedProgress(page);
    const spoken = await page.evaluate(() => [
      ...(window as any).navProbe.spoken,
    ]);
    await walk.click();
    await expect(details).toContainText("Zu Fuß bis Ausstieg");
    await expect(details).toContainText("Von Bahnhof");
    await expect(details).toContainText("12:01 – 12:03");
    await expect(page.locator("#navigation-summary-arrival")).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toBeHidden();
    expect(await savedProgress(page)).toEqual(progress);
    expect(await page.evaluate(() => (window as any).navProbe.spoken)).toEqual(
      spoken,
    );
    // The selected preview becomes current through real position updates.
    await page.clock.runFor(10000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.002));
    await page.clock.runFor(12000);
    await page.evaluate(() => (window as any).navProbe.push(48.002, 11.002, 0));
    await expect(walk).toHaveAttribute("aria-selected", "true");
    await expect(walk).toHaveAttribute("aria-current", "step");
    await expect(details).toHaveText("Geplant: 2 min · 200 m");
    await expect(page.locator("#navigation-complete")).toBeVisible();
    await expect(
      page.locator("#navigation-view").getByText(/^Am Ziel /),
    ).toHaveCount(0);
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({
      path: info.outputPath("compact-current-section.png"),
    });
  });

  test(`missed arrival target stays visible outside the details at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route();
    journey.legs[0].end = journey.arrival = now + 180;
    await setup(
      page,
      false,
      true,
      { timing: "arrive", time: now + 120 },
      journey,
    );
    const warning = "Gewünschte Ankunft 12:02 wird nicht erreicht.";
    if (width < 900) {
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(page.locator("#navigation-summary-arrival")).toHaveCount(0);
      await expect(page.locator("#navigation-alert-summary")).toHaveText(
        warning,
      );
      await expect(page.locator("#navigation-alert-summary")).toBeVisible();
      await page.locator("#navigation-alert-open").click();
    }
    await expect(page.locator("#navigation-arrival-warning")).toHaveText(
      warning,
    );
    await expect(page.locator("#navigation-arrival-warning")).toBeVisible();
    await expect(page.locator("#navigation-summary-arrival")).toHaveCount(0);
    await expectMotionSettled(page.locator("#navigation-panel"));
    await page.screenshot({
      path: info.outputPath("missed-arrival-target.png"),
    });
  });

  test(`departure hides repeated stop names and keeps other boarding places at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route(true);
    journey.legs[0].to = { ...c, name: "Zugang", stopId: "entrance" };
    await setup(page, true, true, {}, journey);
    await expect(page.locator("#navigation-context-detail")).toHaveText(
      "Abfahrt 12:05 · Bahnhof · Gleis 4",
    );
    await expect(page.locator("#navigation-context-status")).toBeEmpty();
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await complete(page);
    await expect(page.locator("#navigation-detail")).toHaveText("Bahnhof");
    await expect(page.locator("#navigation-context-detail")).toHaveText(
      "Abfahrt 12:05 · Gleis 4",
    );
    await page.getByRole("tab", { name: /^S1 nach/ }).click();
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await expect(
      page.locator("#navigation-section-content .detail-source"),
    ).toHaveCount(0);
  });
}

for (const width of [320, 390, 1280])
  test(`section tabs preview details independently of live navigation at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true, true, {}, stationJourney());
    const tabs = page.getByRole("tab");
    const fold = tabs.nth(1),
      train = tabs.nth(2),
      unfold = tabs.nth(3),
      lastBike = tabs.nth(6);
    await expect(tabs).toHaveCount(7);
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await expect(tabs.nth(0)).toHaveAttribute("aria-current", "step");
    const currentBorder = await tabs
      .nth(0)
      .locator(".navigation-phase-symbol")
      .evaluate((symbol) => getComputedStyle(symbol).borderTopColor);
    const instruction = await page
      .locator("#navigation-instruction")
      .innerText();
    const spoken = await page.evaluate(() => [
      ...(window as any).navProbe.spoken,
    ]);
    const progress = await savedProgress(page);
    await train.click();
    if (width < 900) {
      await expect(page.locator("#navigation-details")).toBeHidden();
      await page.locator("#navigation-details-toggle").click();
    }
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(0)).toHaveAttribute("aria-current", "step");
    await expect(tabs.nth(0).locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      currentBorder,
    );
    await expect(train.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#navigation-stage")).toHaveText(
      "S1 · Abschnitt 3 von 7",
    );
    const detail = page.locator("#navigation-section-content");
    await expect(page.locator("#navigation-transit-status")).toBeEmpty();
    await expect(detail.locator(".detail-source")).toHaveCount(0);
    await expect(page.locator("#navigation-stage")).toHaveClass("sr-only");
    await expect(
      detail.locator('[data-kind="fold"], [data-kind="unfold"]'),
    ).toHaveCount(0);
    await expect(detail).toContainText("Richtung Altstadt");
    await expect(detail).toContainText("Bahnhof");
    await expect(detail).toContainText("Ausstieg");
    await expect(detail).toContainText("Gleis / Steig 4");
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await page
      .locator("#navigation-complete")
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("#navigation-confirm")).not.toBeVisible();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      instruction,
    );
    expect(await savedProgress(page)).toEqual(progress);
    expect(await page.evaluate(() => (window as any).navProbe.spoken)).toEqual(
      spoken,
    );
    await train.click();
    await expect(page.getByRole("tabpanel")).toBeVisible();

    // Actual folding gets its own current marker while the train preview stays open.
    await page.clock.runFor(10000);
    await page.evaluate(() => (window as any).navProbe.push(48, 11.002));
    await page.clock.runFor(12000);
    await page.evaluate(() => (window as any).navProbe.push(48.002, 11.002, 0));
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    await expect(fold).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expect(fold.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      currentBorder,
    );
    await expect(tabs.nth(0).locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await fold.click();
    await expect(detail).toContainText("Falten");
    await expect(detail).toContainText("Bahnhof");
    await expect(detail.locator('[data-kind="transit"]')).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toHaveText(
      "Rad gefaltet",
    );
    await complete(page);
    await expect(train).toHaveAttribute("aria-current", "step");
    await expect(train).toHaveAttribute("aria-selected", "true");
    await expectCurrentTabAligned(page);
    await expect(page.locator("#navigation-complete")).toHaveText(
      "Ausgestiegen",
    );

    await lastBike.click();
    await expect(detail).toContainText("Rad bis Ziel");
    await expect(detail).toContainText("169 m");
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await page.evaluate(() =>
      setInterval(() => (window as any).navProbe.push(48.003, 11.004), 10000),
    );
    // Exercise each periodic GPS sample without rendering ten minutes of frames.
    for (let i = 0; i < 60; i++) await page.clock.fastForward(10000);
    await expect(unfold).toHaveAttribute("aria-current", "step");
    await expect(lastBike).toHaveAttribute("aria-selected", "true");
    await expect(lastBike).toBeFocused();
    await expectCurrentTabAligned(page);
    await expect(unfold.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      currentBorder,
    );
    await expect(lastBike.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(detail).toContainText("Rad bis Ziel");
    if (width < 900) {
      await page.locator("#navigation-details-toggle").click();
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(unfold).toHaveAttribute("aria-selected", "false");
      await expect(lastBike).toHaveAttribute("aria-selected", "true");
      await expectTabVisible(page);
    }
    await unfold.click();
    await expect(unfold).toBeFocused();
    if (width < 900) {
      await expect(page.locator("#navigation-details")).toBeHidden();
      await expect(
        page.locator("#navigation-section-preview-title"),
      ).toHaveText("Entfalten");
      await page.locator("#navigation-details-toggle").click();
    }
    await expect(detail).toContainText("Entfalten");
    await expect(detail.locator('[data-kind="walk"]')).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toHaveText(
      "Rad entfaltet",
    );
    await tabs.nth(4).click();
    await expect(detail).toContainText("Zu Fuß bis Café");
    await expect(detail.locator('[data-kind="unfold"]')).toHaveCount(0);
    await expect(page.locator("#navigation-complete")).toBeHidden();
  });

for (const width of [320, 390])
  test(`section tabs align current progress on resume and stop at the natural end at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const journey = route(true);
    journey.legs = journey.legs.slice(0, 5);
    journey.legs[4].kind = "bike";
    journey.destination = e;
    journey.arrival = journey.legs.at(-1)!.end;
    await setup(page, true, true, {}, journey);
    const tabs = page.getByRole("tab");
    const strip = page.locator("#navigation-phases");
    await expectCurrentTabAligned(page);
    expect(await strip.evaluate((element) => element.scrollLeft)).toBe(0);
    await complete(page);
    await complete(page);
    await expect(tabs.nth(2)).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);

    await tabs.last().click();
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#navigation-details")).toBeHidden();
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "false");
    await expect(tabs.nth(2)).toHaveAttribute("aria-current", "step");
    await expectTabVisible(page);

    await expect.poll(() => savedProgress(page)).toMatchObject({ legIndex: 2 });
    await page.reload();
    await page.locator("#navigation-resume").click();
    await expect(tabs.nth(2)).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);
    await complete(page);
    await complete(page);
    await expect(tabs.last()).toHaveAttribute("aria-current", "step");
    await expectCurrentTabAligned(page);
    await expect
      .poll(() =>
        strip.evaluate((element) =>
          Math.abs(
            element.getBoundingClientRect().right -
              element.lastElementChild!.getBoundingClientRect().right -
              parseFloat(getComputedStyle(element).paddingRight),
          ),
        ),
      )
      .toBeLessThanOrEqual(1);
  });

test("section tabs support keyboard navigation, collapsed summary order and resume", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setup(page, true);
  const tabs = page.getByRole("tab");
  await expectMotionSettled(page.locator("#navigation-panel"));
  await expect(page.locator("#navigation-details")).toBeHidden();
  const summary = await page.locator("#navigation-summary").boundingBox();
  const strip = await page.getByRole("tablist").boundingBox();
  expect(strip!.y).toBeGreaterThanOrEqual(summary!.y + summary!.height);
  const tabSizes = await tabs.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }),
  );
  expect(
    tabSizes.every((bounds) => bounds.width >= 48 && bounds.height >= 48),
    JSON.stringify(tabSizes),
  ).toBe(true);
  await expect(tabs.nth(0)).toHaveAttribute("tabindex", "0");
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(page.locator("#navigation-section-preview-title")).toHaveText(
    "Falten",
  );
  await expect(page.locator("#navigation-section-detail")).toHaveAttribute(
    "aria-labelledby",
    (await tabs.nth(1).getAttribute("id")) as string,
  );
  for (const [key, index] of [
    ["End", 6],
    ["ArrowRight", 0],
    ["ArrowLeft", 6],
    ["Home", 0],
    ["ArrowRight", 1],
    ["End", 6],
  ] as const) {
    await page.keyboard.press(key);
    await expect(tabs.nth(index)).toBeFocused();
    await expect(tabs.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#navigation-details")).toBeHidden();
    await expect(page.locator("#navigation-details-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expectTabVisible(page);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(tabs.nth(6)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(6)).toBeFocused();
  await expectTabVisible(page);
  await page.locator("#navigation-details-toggle").press("ArrowUp");
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(tabs.nth(6)).toHaveAttribute("aria-selected", "true");
  await expectTabVisible(page);
  await tabs.nth(6).focus();
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await page.keyboard.press("End");
  await expect(tabs.nth(6)).toBeFocused();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await expect(page.locator("#navigation-details-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await tabs.nth(6).focus();
  await page.keyboard.press("Shift+Tab");
  // WebKit can skip native buttons in its default keyboard focus order.
  if (
    await page
      .locator("#navigation-complete")
      .evaluate((element) => element === document.activeElement)
  )
    await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("tabpanel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#navigation-details-toggle")).toBeFocused();

  await tabs.nth(1).click();
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.reload();
  await page.locator("#navigation-resume").click();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#navigation-details")).toBeHidden();
});

test("section tabs present folding and unfolding as five peer sections", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = route(true);
  journey.legs = journey.legs.slice(0, 5);
  journey.legs[4].kind = "bike";
  journey.destination = e;
  journey.arrival = journey.legs.at(-1)!.end;
  await setup(page, true, true, {}, journey);
  const tabs = page.getByRole("tab");
  const detail = page.locator("#navigation-section-content");
  await expect(tabs).toHaveCount(5);
  await expect(tabs).toHaveText(["Rad", "Falten", "S1", "Entfalten", "Rad"]);
  await expect(
    tabs.locator('.navigation-phase-symbol[aria-hidden="true"]'),
  ).toHaveCount(5);
  await expect(tabs.nth(0).locator('[data-icon="bike"] svg')).toBeVisible();
  await expect(tabs.nth(1).locator('[data-icon="fold"] svg')).toBeVisible();
  await expect(tabs.nth(2).locator('[data-icon="transit"] svg')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("five-tabs-collapsed.png"),
  });
  await tabs.nth(1).click();
  await expect(page.locator("#navigation-details")).toBeHidden();
  await expect(page.locator("#navigation-section-preview-title")).toHaveText(
    "Falten",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(detail.locator('[data-kind="fold"]')).toBeVisible();
  await expect(detail.locator('[data-kind="transit"]')).toHaveCount(0);
  await expect(page.locator("#navigation-stage")).toHaveText(
    "Falten · Abschnitt 2 von 5",
  );
  await expect(page.locator("#navigation-complete")).toBeHidden();
  await tabs.nth(2).click();
  await expect(
    detail.locator('[data-kind="fold"], [data-kind="unfold"]'),
  ).toHaveCount(0);
  await tabs.nth(3).click();
  await expect(tabs.nth(3).locator('[data-icon="unfold"] svg')).toBeVisible();
  await expect(detail.locator('[data-kind="unfold"]')).toBeVisible();
  await expect(detail.locator('[data-kind="bike"]')).toHaveCount(0);
  await expect(page.locator("#navigation-stage")).toHaveText(
    "Entfalten · Abschnitt 4 von 5",
  );
  await tabs.nth(4).click();
  await expect(detail.locator('[data-kind="unfold"]')).toHaveCount(0);
  await expect(detail).toContainText("Rad bis Café");
});

test("section tabs keep separate train details", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = route(true);
  const second = {
    ...structuredClone(journey.legs[2]),
    from: d,
    to: f,
    line: "U3",
    headsign: "Fürstenried West",
    platform: "1",
    arrivalPlatform: "8",
    realtime: false,
    start: now + 900,
    end: now + 1020,
    transitReference: undefined,
  };
  journey.legs = [
    ...journey.legs.slice(0, 3),
    second,
    ...journey.legs
      .slice(3)
      .map((leg) => ({ ...leg, start: leg.start + 420, end: leg.end + 420 })),
  ];
  journey.arrival = journey.legs.at(-1)!.end;
  await setup(page, true, true, {}, journey);
  await page.getByRole("tab", { name: /^U3 nach/ }).click();
  await page.locator("#navigation-details-toggle").click();
  const details = page.locator("#navigation-section-content");
  await expect(details).toContainText("Richtung Fürstenried West");
  await expect(details).toContainText("Gleis / Steig 8");
  await expect(page.locator("#navigation-transit-status")).toHaveText(
    "U3 · Aktualisierung nicht verfügbar",
  );
  await expect(details).not.toContainText("Altstadt");
  await page.getByRole("tab", { name: /^S1 nach/ }).click();
  await expect(details).toContainText("Richtung Altstadt");
  await expect(details).not.toContainText("Fürstenried West");
});

for (const mode of ["BUS", "COACH"])
  test(`section tabs retain the line label alongside the bus symbol for ${mode}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const journey = route(true);
    journey.legs[2].mode = mode;
    journey.legs[2].line = mode === "BUS" ? "52" : "X35";
    await setup(page, true, true, {}, journey);
    const tab = page.getByRole("tab", {
      name: new RegExp(`^${journey.legs[2].line} nach`),
    });
    await expect(tab).toHaveText(journey.legs[2].line!);
    await expect(tab.locator('[data-icon="bus"] svg')).toBeVisible();
    await tab.click();
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-section-content")).toContainText(
      journey.legs[2].line!,
    );
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
  });

for (const colorScheme of ["light", "dark"] as const)
  test(`section tabs retain focus and scrolling through live updates (${colorScheme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme });
    await setup(page, true);
    await page.evaluate(
      () => (document.documentElement.style.fontSize = "24px"),
    );
    await page.locator("#navigation-details-toggle").click();
    const current = page.getByRole("tab", { name: /^Rad nach Bahnhof/ });
    const train = page.getByRole("tab", { name: /^S1 nach/ });
    const activeColor = await current.evaluate(
      (tab) => getComputedStyle(tab).color,
    );
    const inactiveColor = await train.evaluate(
      (tab) => getComputedStyle(tab).color,
    );
    expect(activeColor).not.toBe(inactiveColor);
    await train.click();
    await expect(train).toBeFocused();
    await expect(train).toHaveCSS("color", activeColor);
    await expect(train).toHaveCSS("font-weight", "650");
    await expect(train).toHaveCSS("border-bottom-color", activeColor);
    await expect(current).toHaveAttribute("aria-current", "step");
    await expect(current).toHaveCSS("color", inactiveColor);
    await expect(current).toHaveCSS("font-weight", "500");
    await expect(current).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    const currentSymbol = current.locator(".navigation-phase-symbol");
    const brand = await currentSymbol.evaluate((symbol) => {
      const style = getComputedStyle(symbol);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect(brand.foreground).not.toBe(brand.background);
    await expect(train.locator(".navigation-phase-symbol")).not.toHaveCSS(
      "background-color",
      brand.background,
    );
    await expect(train.locator(".navigation-phase-symbol")).toHaveCSS(
      "border-top-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.locator("#navigation-end")).toBeVisible();
    await expectMobileCredit(page);
    const scroll = await page.evaluate(() => {
      const details = document.getElementById("navigation-details")!;
      details.scrollTop = 45;
      return {
        details: details.scrollTop,
        tabs: document.getElementById("navigation-phases")!.scrollLeft,
      };
    });
    await page.clock.fastForward(61000);
    await expect(train).toBeFocused();
    await expect(train).toHaveAttribute("aria-selected", "true");
    expect(
      await page.locator("#navigation-details").evaluate((e) => e.scrollTop),
    ).toBe(scroll.details);
    expect(
      await page.locator("#navigation-phases").evaluate((e) => e.scrollLeft),
    ).toBe(scroll.tabs);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await expect(page.locator("#navigation-network-status")).toContainText(
      "Offline",
    );
    await expect(train).toBeFocused();
    await expect(page.locator("#navigation-section-content")).toContainText(
      "S1",
    );
    await page.screenshot({
      path: test.info().outputPath(`section-tabs-${colorScheme}.png`),
    });
  });

test("following restores the current section zoom after progressing with a manual camera", async ({
  page,
}) => {
  await setup(page, true);
  const map = page.locator("#navigation-map");
  // Keyboard interactions are ignored until OpenLayers has rendered a frame.
  await expect(map.locator("canvas").first()).toBeVisible();
  await map.press("-");
  await page.clock.runFor(400);
  await complete(page); // Fold retains the cycling default.
  await expect(map).toHaveAttribute("data-zoom", "16");
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-zoom", "17");
  await map.press("-");
  await page.clock.runFor(400);
  await complete(page); // Transit changes its default while following is paused.
  await expect(map).toHaveAttribute("data-zoom", "16");
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-zoom", "15");
  await map.press("-");
  await page.clock.runFor(400);
  await complete(page); // Unfold.
  await complete(page); // Walk.
  await expect(map).toHaveAttribute("data-zoom", "14");
  await page.locator("#navigation-center").click();
  await expect(map).toHaveAttribute("data-zoom", "18");
  await page.clock.runFor(1000);
  await expect(map).toHaveAttribute("data-zoom", "18");
});
