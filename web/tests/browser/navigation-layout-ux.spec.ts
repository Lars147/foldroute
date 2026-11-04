import { expect, test } from "./test";
import { mountNavigationFixture } from "./navigation-layout-fixture";
import { stationRail } from "./navigation-fixture";

for (const theme of ["light", "dark"] as const)
  for (const layout of [
    { width: 390, height: 844, top: 59, font: 16 },
    { width: 430, height: 932, top: 62, font: 32 },
    { width: 320, height: 568, top: 0, font: 16 },
    { width: 844, height: 390, top: 0, font: 16 },
  ])
    test(`standalone navigation has no artificial status bar shading at ${layout.width}px in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({
        width: layout.width,
        height: layout.height,
      });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await mountNavigationFixture(page, 0, { theme });
      await page.addStyleTag({
        content: `:root { --safe-top: ${layout.top}px; font-size: ${layout.font}px; }`,
      });
      await page.evaluate(() => {
        document.body.dataset.navigation = "active";
        (window as any).navigationFixture.view.render();
      });
      const statusBar = page.locator(".navigation-status-bar");
      const guidance = page.locator("#navigation-guidance");
      const initial = await guidance.boundingBox();
      await expect(statusBar).toHaveCount(0);
      await page.evaluate(() => {
        document.documentElement.dataset.standalone = "";
      });
      expect(await guidance.boundingBox()).toEqual(initial);
      expect(await page.locator("#navigation-map").boundingBox()).toEqual({
        x: 0,
        y: 0,
        width: layout.width,
        height: layout.height,
      });
      await expect
        .poll(
          async () =>
            (await page.locator(".navigation-map-controls").boundingBox())!.y,
        )
        .toBeGreaterThanOrEqual(initial!.y + initial!.height + 7);
      const shading = await page.evaluate(() => {
        const style = getComputedStyle(document.body, "::before");
        return {
          background: style.backgroundColor,
          image: style.backgroundImage,
          filter: style.backdropFilter,
        };
      });
      expect(shading).toEqual({
        background: "rgba(0, 0, 0, 0)",
        image: "none",
        filter: "none",
      });
      await page.screenshot({
        path: info.outputPath("unshaded-status-bar.png"),
      });
      await page.setViewportSize({ width: 1280, height: 844 });
      await expect(statusBar).toHaveCount(0);
      await page.setViewportSize({
        width: layout.width,
        height: layout.height,
      });
      await page.evaluate(() => {
        (window as any).navigationFixture.view.hide();
        delete document.body.dataset.navigation;
      });
      await expect(statusBar).toHaveCount(0);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.body, "::before").backgroundImage,
        ),
      ).toBe("none");
    });

for (const colorScheme of ["light", "dark"] as const)
  for (const width of [320, 390, 1280])
    test(`prepared GPS badge fits at ${width}px in ${colorScheme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await mountNavigationFixture(page);
      if (width < 900) await page.locator("#navigation-details-toggle").click();
      await page.evaluate(() =>
        (window as any).navigationFixture.setLocation("inaccurate"),
      );
      const status = page.locator("#navigation-gps-status");
      const primary = page.locator("#navigation-gps-primary");
      const secondary = page.locator("#navigation-gps-estimate");
      await expect(status).toHaveText("GPS ungenau Kartenposition geschätzt");
      await expect(primary).toHaveText("GPS ungenau");
      await expect(primary).toHaveCSS("font-size", "14px");
      await expect(primary).toHaveCSS("font-weight", "600");
      await expect(primary).toHaveCSS("color", "rgb(23, 26, 28)");
      await expect(secondary).toHaveText("Kartenposition geschätzt");
      await expect(secondary).toHaveCSS("font-size", "12px");
      await expect(secondary).toHaveCSS("font-weight", "400");
      await expect(secondary).toHaveCSS("color", "rgb(23, 26, 28)");
      await expect(status).toHaveCSS("background-color", "rgb(255, 212, 59)");
      await expect(status).toHaveAttribute("role", "status");
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(status).toHaveAttribute("aria-atomic", "true");
      const checkBounds = async (estimated: boolean) => {
        const bounds = await status.evaluate((element) => {
          const badge = element.getBoundingClientRect();
          const main = element.querySelector("strong")!.getBoundingClientRect();
          const detail = element.querySelector("span")!.getBoundingClientRect();
          const controls = document
            .querySelector(".navigation-map-controls")!
            .getBoundingClientRect();
          return {
            primaryBottom: main.bottom,
            secondaryTop: detail.top,
            right: badge.right,
            controlsLeft: controls.left,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        if (estimated)
          expect(bounds.secondaryTop).toBeGreaterThan(bounds.primaryBottom);
        expect(bounds.right).toBeLessThan(bounds.controlsLeft);
        expect(bounds.overflow).toBe(false);
      };
      await checkBounds(true);
      await page.evaluate(() =>
        (window as any).navigationFixture.setLocation("missing"),
      );
      await expect(status).toHaveText("Kein GPS Kartenposition geschätzt");
      await checkBounds(true);
      if (width === 320) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await checkBounds(true);
      }
      await page.screenshot({ path: info.outputPath("gps-estimate.png") });
      await page.evaluate(() => (window as any).navigationFixture.showLeg(3));
      await expect(status).toHaveText("Kein GPS");
      await expect(secondary).toBeHidden();
      await expect(secondary).toBeEmpty();
      await expect(status).toHaveCSS("background-color", "rgb(255, 212, 59)");
      await checkBounds(false);
      await page.evaluate(() =>
        (window as any).navigationFixture.setLocation("current"),
      );
      await expect(status).toBeHidden();
      await expect(primary).toBeEmpty();
      await expect(secondary).toBeEmpty();
    });

for (const [width, height] of [
  [320, 844],
  [390, 844],
  [844, 390],
  [1280, 844],
]) {
  test(`prepared departure, stations and GPS status fit at ${width}x${height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({
      reducedMotion: "reduce",
      colorScheme: width === 320 ? "dark" : "light",
    });
    await mountNavigationFixture(page, 0);
    await expect(page.locator("#navigation-context-title")).toHaveText(
      "S1 · in 5 Min.",
    );
    await expect(page.locator("#navigation-context-detail")).toContainText(
      "Abfahrt 12:05",
    );
    await page.clock.setFixedTime(new Date(Date.parse("2026-10-06T10:05:02Z")));
    await page.evaluate(() => {
      (window as any).navigationFixture.showLeg(2);
    });
    const selector =
      width < 900
        ? "#navigation-stations-preview"
        : "#navigation-stations-detail";
    const rail = page.locator(selector);
    await expect(rail).toBeVisible();
    await expect(
      page.locator("#navigation-stations-announcement"),
    ).toContainText("Nächster Halt: Stadtmitte");
    await expect(
      page.locator('.navigation-stations[data-active="true"]:visible'),
    ).toContainText("Ausstieg in 3 Halten");
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "Kein GPS Kartenposition geschätzt",
    );
    await expect
      .poll(async () => (await stationRail(page, selector)).rows.length)
      .toBe(width < 900 ? 3 : 4);
    for (const row of (await stationRail(page, selector)).rows) {
      expect(row.width).toBe(4);
      expect(row.dotX).toBeCloseTo(row.lineX, 2);
    }
    if (width < 900) {
      await expect(rail.locator(".navigation-station-name")).toHaveText([
        "Bahnhof",
        "Stadtmitte",
        "Ausstieg",
      ]);
      await page.locator("#navigation-details-toggle").click();
    }
    // A second prepared instant covers passed rows in both renderers without
    // replaying several minutes of train/map animation at every viewport.
    await page.clock.setFixedTime(new Date("2026-10-06T10:08:30Z"));
    await page.evaluate(() => (window as any).navigationFixture.view.render());
    await expect(
      page.locator("#navigation-stations-announcement"),
    ).toContainText("Nächster Halt: Ausstieg");
    await expect(
      page.locator('.navigation-stations[data-active="true"]:visible'),
    ).toContainText("Ausstieg am nächsten Halt");
    await expect(
      page.locator("#navigation-stations-detail .navigation-station"),
    ).toHaveCount(4);
    await expect(
      page.locator("#navigation-stations-detail [data-state=passed]"),
    ).toHaveCount(3);
    await expect(page.locator("#navigation-stations-detail")).toContainText(
      "Passiert",
    );
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    const badge = (await page.locator("#navigation-gps-status").boundingBox())!;
    const controls = (await page
      .locator(".navigation-map-controls")
      .boundingBox())!;
    expect(badge.x + badge.width).toBeLessThan(controls.x);
    if (width >= 900)
      await page.locator("#navigation-end").scrollIntoViewIfNeeded();
    await expect(page.locator("#navigation-end")).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("prepared-stations.png") });
    if (width === 320) {
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      await expect(
        page.locator(
          '.navigation-stations:visible [data-exit="true"] .navigation-station-name',
        ),
      ).toBeVisible();
      await expect(page.locator("#navigation-end")).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("prepared-stations-large-text.png"),
      });
    }
  });
}

test("compact rail clips departing rows and finishes a normal transition", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({
    reducedMotion: "no-preference",
    colorScheme: "dark",
  });
  await mountNavigationFixture(page);
  await page.evaluate(async () => {
    const { NavigationStations } = await import("/src/navigation-stations.ts");
    const { session, view } = (window as any).navigationFixture;
    view.hide();
    document.getElementById("navigation-stations-preview")!.remove();
    const panel = document.createElement("article");
    panel.className = "navigation-panel";
    const list = document.createElement("ol");
    list.id = "navigation-stations-preview";
    list.className = "navigation-stations";
    panel.append(list);
    document.getElementById("main")!.append(panel);
    const rail = new NavigationStations(list, true);
    rail.update(session.engine.leg, 0);
    rail.update(session.engine.leg, 1);
    list
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.pause());
  });
  const rail = page.locator("#navigation-stations-preview");
  await expect(rail).toHaveAttribute("data-shifting", "true");
  await expect(rail.locator("[data-leaving]")).toHaveCount(2);
  await expect(
    rail.locator('[data-leaving]:not([aria-hidden="true"])'),
  ).toHaveCount(0);
  await expect(rail).toHaveCSS("overflow-y", "hidden");
  await rail.evaluate((list) =>
    list
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.finish()),
  );
  await expect(rail.locator("[data-leaving]")).toHaveCount(0);
  await expect(rail).toHaveAttribute("data-continuation", "true");
});
