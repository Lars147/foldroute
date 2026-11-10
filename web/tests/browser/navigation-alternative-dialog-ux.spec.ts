import { test, expect, type Page } from "./test";
import { now } from "./navigation-fixture";
import { mountNavigationFixture } from "./navigation-layout-fixture";

test("mobile alternative slides down without changing layout during closing", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await prepare(page);
  await page.locator("#navigation-alert-open").click();
  const dialog = page.locator("#navigation-alternative");
  await expect(dialog).toHaveCSS("opacity", "1");
  const frames = await dialog.evaluate(async (element) => {
    const read = () => ({
      top: element.getBoundingClientRect().top,
      width: element.getBoundingClientRect().width,
      headerWidth: element.querySelector("header")!.getBoundingClientRect()
        .width,
      height: element.getBoundingClientRect().height,
      direction: getComputedStyle(element).flexDirection,
      position: getComputedStyle(element).position,
      visible: getComputedStyle(element).display !== "none",
    });
    const samples = [read()];
    document.getElementById("navigation-alternative-close")!.click();
    for (let i = 0; i < 24; i++) {
      samples.push(read());
      await new Promise(requestAnimationFrame);
    }
    return samples;
  });
  for (const frame of frames.filter((frame) => frame.visible)) {
    expect(frame.direction).toBe("column");
    expect(frame.position).toBe("fixed");
    expect(frame.width).toBeCloseTo(frames[0].width, 0);
    expect(frame.headerWidth).toBeCloseTo(frames[0].headerWidth, 0);
    expect(frame.height).toBeCloseTo(frames[0].height, 0);
  }
  const paintedExit = frames.slice(1).filter((frame) => frame.visible);
  if (paintedExit.length > 2) {
    expect(Math.max(...paintedExit.map((frame) => frame.top))).toBeGreaterThan(
      frames[0].top + frames[0].height * 0.8,
    );
  }
  await expect(dialog).toBeHidden();
});

async function prepare(
  page: Page,
  width = 390,
  theme: "light" | "dark" = "dark",
) {
  await page.setViewportSize({ width, height: 844 });
  await mountNavigationFixture(page, 2, { theme });
  await page.evaluate(() => {
    const { session, view, setLocation } = (window as any).navigationFixture;
    setLocation("current");
    session.disruption = { id: "dialog-risk", message: "Anschluss gefährdet." };
    session.alternative = {
      id: "proposal-1",
      sourceId: session.engine.leg.navigationId,
      issueId: "dialog-risk",
      createdAt: Date.now() / 1000,
      settings: session.settings,
      journey: structuredClone(session.engine.journey),
      legIndex: session.engine.progress.legIndex,
    };
    view.render();
  });
}

for (const width of [390, 1280])
  for (const theme of ["light", "dark"] as const)
    test(`alternative dialog separates decisions at ${width} (${theme})`, async ({
      page,
    }, info) => {
      await prepare(page, width, theme);
      const dialog = page.getByRole("dialog", {
        name: "Neue Verbindungen",
        exact: true,
      });
      const trigger = page.getByRole("button", {
        name: "Neue Verbindungen ansehen",
        exact: true,
      });
      await expect(dialog).toBeHidden();
      await expect(trigger).toHaveClass(/(^|\s)primary(\s|$)/);
      await expect(
        page.locator("#navigation-panel button.primary:visible"),
      ).toHaveCount(1);
      await expect(page.locator("#navigation-retry")).toBeHidden();
      await trigger.click();
      await expect(dialog).toBeVisible();
      await expect(page.locator("#navigation-alternative-title")).toBeFocused();
      await expect(dialog.locator("#navigation-accept")).toBeEnabled();
      await expect(dialog).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: info.outputPath("alternative-dialog.png"),
      });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.locator("#navigation-alternative-close").click();
      await expect(trigger).toBeVisible();
      await trigger.click();
      await page.locator("#navigation-dismiss").click();
      await expect(dialog).toBeHidden();
      expect(
        await page.evaluate(
          () => (window as any).navigationFixture.session.alternative,
        ),
      ).toBeUndefined();
    });

test("dialog displays expired, replaced and withdrawn proposals without losing navigation", async ({
  page,
}) => {
  await prepare(page);
  await page
    .getByRole("button", { name: "Neue Verbindungen ansehen", exact: true })
    .click();
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    session.alternative.createdAt -= 121;
    view.render();
  });
  await expect(page.locator("#navigation-accept")).toHaveText(
    "Vorschläge aktualisieren",
  );
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    session.alternative = {
      ...session.alternative,
      id: "proposal-2",
      createdAt: Date.now() / 1000,
    };
    view.render();
  });
  await expect(page.locator("#navigation-alternative-status")).toContainText(
    "aktualisiert",
  );
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    session.alternative = undefined;
    view.render();
  });
  await expect(page.locator("#navigation-alternative")).toBeVisible();
  await expect(page.locator("#navigation-accept")).toBeDisabled();
  const retry = page.getByRole("button", {
    name: "Erneut suchen",
    exact: true,
  });
  await expect(retry).toBeVisible();
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({ json: { direct: [], itineraries: [] } }),
  );
  const requested = page.waitForRequest("**/api/v6/plan?*");
  await retry.click();
  await requested;
  await expect(page.locator("#navigation-alternative-status")).toContainText(
    "Keine passende Route gefunden",
  );
  await expect(retry).toBeEnabled();
  await page.locator("#navigation-alternative-close").click();
  await expect(page.locator("#navigation-instruction")).toBeFocused();
});

test("successful acceptance closes dialog and restores visible focus", async ({
  page,
}) => {
  await prepare(page);
  await page
    .getByRole("button", { name: "Neue Verbindungen ansehen", exact: true })
    .click();
  await page.locator("#navigation-accept").click();
  await expect(page.locator("#navigation-alternative")).toBeHidden();
  await expect(page.locator("#navigation-instruction")).toBeFocused();
  await expect(page.locator("#navigation-view")).toBeVisible();
});

for (const [width, height] of [
  [320, 480],
  [320, 568],
  [568, 320],
])
  test(`GPS recovery actions remain reachable by manual scrolling at ${width}x${height}`, async ({
    page,
  }) => {
    await prepare(page, width);
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      const { session, view } = (window as any).navigationFixture;
      (window as any).navigationFixture.showLeg(0);
      session.alternative.sourceId = session.engine.leg.navigationId;
      session.alternative.legIndex = 0;
      session.alternative.createdAt -= 121;
      session.updateLocation(undefined);
      view.render();
    });
    await page.locator("#navigation-alert-open").click();
    await page.locator("#navigation-accept").click();
    const content = page.locator(
      "#navigation-alternative .alternative-content",
    );
    const bounds = (await content.boundingBox())!;
    expect(bounds.height).toBeGreaterThan(0);
    await expect(page.locator("#navigation-alternative-close")).toBeInViewport({
      ratio: 1,
    });
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + Math.min(20, bounds.height / 2),
    );
    await page.mouse.wheel(0, 3000);
    await expect(page.locator("#navigation-dismiss")).toBeInViewport({
      ratio: 1,
    });
    const button = (await page.locator("#navigation-dismiss").boundingBox())!;
    expect(button.y + button.height).toBeLessThanOrEqual(
      bounds.y + bounds.height + 1,
    );
    await page.locator("#navigation-dismiss").click();
    await expect(page.locator("#navigation-alternative")).toBeHidden();
  });

test("choosing a second alternative preserves navigation until acceptance and restores camera", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    const second = structuredClone(session.alternative);
    second.id = "second-proposal";
    second.journey.id = "second-route";
    session.alternatives.push(second);
    view.render();
  });
  await page.getByRole("tab", { name: /^Falten nach/ }).click();
  await page.locator("#navigation-alert-open").click();
  await expect(
    page.locator("#navigation-alternative .route-choice"),
  ).toHaveCount(2);
  await page
    .locator('#navigation-alternative [data-journey="second-proposal"]')
    .click();
  await expect(
    page.locator("#navigation-alternative-status"),
  ).not.toContainText("aktualisiert");
  expect(
    await page.evaluate(
      () => (window as any).navigationFixture.session.engine.journey.id,
    ),
  ).not.toBe("second-route");
  await page
    .locator('#navigation-alternative [data-detail-journey="second-proposal"]')
    .click();
  await expect(page.locator("#navigation-alternative-title")).toHaveText(
    "Reiseablauf",
  );
  await page.getByRole("button", { name: "Zurück zu Verbindungen" }).click();
  await expect(
    page.locator('#navigation-alternative [data-journey="second-proposal"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await page.locator("#navigation-accept").click();
  expect(
    await page.evaluate(
      () => (window as any).navigationFixture.session.engine.journey.id,
    ),
  ).toBe("second-route");
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "true",
  );
});

for (const [reason, message] of [
  ["permission-denied", "Standortzugriff verweigert."],
  ["timeout", "Standortanfrage abgelaufen."],
] as const)
  test(`GPS ${reason} error and help are visible inside the dialog`, async ({
    page,
  }) => {
    await prepare(page);
    await page.evaluate(() => {
      const { session, view } = (window as any).navigationFixture;
      (window as any).navigationFixture.showLeg(0);
      session.alternative.sourceId = session.engine.leg.navigationId;
      session.alternative.legIndex = 0;
      session.alternative.createdAt -= 121;
      session.updateLocation(undefined);
      view.render();
    });
    await page.locator("#navigation-alert-open").click();
    await page.locator("#navigation-accept").click();
    await page.evaluate(
      async ({ reason, message }) => {
        const { LocationError } = await import("/src/live-location.ts");
        const { session, view } = (window as any).navigationFixture;
        session.locationError = new LocationError(reason, message);
        view.render();
      },
      { reason, message },
    );
    await expect(page.locator("#navigation-alternative-status")).toHaveText(
      message,
    );
    await expect(
      page.locator("#navigation-alternative .location-help"),
    ).toBeVisible();
  });

test("unreliable street progress clears stale values even with a current off-route fix", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountNavigationFixture(page, 0);
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    session.disruption = { id: "street-risk", message: "Anschluss gefährdet." };
    view.render();
  });
  await expect(page.locator("#navigation-complete")).toHaveClass(/secondary/);
  await expect(page.locator("#navigation-retry")).toHaveClass(/primary/);
  await expect(page.locator("#navigation-section-preview-meta")).toHaveText(
    "Reststrecke wird geprüft",
  );
  await expect(page.locator("#navigation-gps-status")).toContainText(
    "Kein GPS",
  );
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    session.fix = {
      latitude: 48.5,
      longitude: 11.5,
      accuracy: 10,
      timestamp: Date.now(),
    };
    session.fixQuality = "current";
    session.engine.routeState = "deviated";
    view.render();
  });
  await expect(page.locator("#navigation-section-preview-meta")).toHaveText(
    "Reststrecke wird geprüft",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator("#navigation-section-content")).toHaveText(
    "Reststrecke wird geprüft",
  );
});

test("resolved disruption removes retry and restores focus after timetable refresh", async ({
  page,
}) => {
  await prepare(page);
  await page
    .getByRole("button", { name: "Neue Verbindungen ansehen", exact: true })
    .click();
  await page.evaluate(() => {
    const { session, view } = (window as any).navigationFixture;
    session.alternative = undefined;
    view.render();
  });
  const retry = page.getByRole("button", {
    name: "Erneut suchen",
    exact: true,
  });
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.route("**/api/v6/trip?*", (route) =>
    route.fulfill({
      json: {
        legs: [
          {
            from: {
              stopId: "A",
              scheduledDeparture: new Date((now + 300) * 1000).toISOString(),
              departure: new Date((now + 300) * 1000).toISOString(),
            },
            to: {
              stopId: "D",
              scheduledArrival: new Date((now + 600) * 1000).toISOString(),
              arrival: new Date((now + 600) * 1000).toISOString(),
            },
            realTime: true,
          },
        ],
      },
    }),
  );
  await page.evaluate(async () => {
    await (window as any).navigationFixture.session.refresh("foreground");
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).navigationFixture.session.disruption),
    )
    .toBeUndefined();
  await expect(page.locator("#navigation-alternative")).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(page.locator("#navigation-accept")).toBeDisabled();
  await expect(page.locator("#navigation-alternative-status")).toContainText(
    "Störung liegt nicht mehr vor",
  );
  await expect(page.locator("#navigation-alternative-close")).toBeFocused();
  await page.locator("#navigation-alternative-close").click();
  await expect(page.locator("#navigation-instruction")).toBeFocused();
});
