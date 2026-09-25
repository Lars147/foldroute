import { resizeOverview, toggleSelectedDetails } from "./assertions";
import { test, expect, type Page } from "@playwright/test";

async function preview(page: Page) {
  // Isolate the component: the application entrypoint would create a second
  // JourneyView with competing resize/focus observers on these same elements.
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'import "/src/style.css"; import { icon } from "/src/ui.ts"; document.querySelectorAll("[data-icon]").forEach(element => element.append(icon(element.dataset.icon)));',
    }),
  );
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/src/journey-view.ts";
    const { JourneyView } = await import(path);
    const from = { name: "Start", detail: "", latitude: 48, longitude: 11 };
    const to = { ...from, name: "Ziel", latitude: 48.1 };
    const departure = Date.parse("2026-09-11T08:00:00Z") / 1000;
    const makeJourney = (id: string, duration: number, direct = false) => ({
      id,
      origin: from,
      destination: to,
      departure,
      arrival: departure + duration * 60,
      transfers: direct ? 0 : 1,
      isDirect: direct,
      legs: (direct
        ? [["bike", duration]]
        : [
            ["bike", 10],
            ["fold", 2],
            ["transit", duration - 20],
            ["unfold", 2],
            ["bike", 4],
            ["walk", 2],
          ]
      ).map(([kind, minutes]) => ({
        kind,
        from,
        to,
        start: departure,
        end: departure + Number(minutes) * 60,
        distance: 1000,
        coordinates: [from, to],
      })),
    });
    const journeys = [
      makeJourney("best", 50),
      makeJourney("selected", 55),
      makeJourney("third", 60),
      makeJourney("comparison", 65, true),
    ];
    const state = {
      journeys,
      selected: journeys[1],
      request: {
        origin: from,
        destination: to,
        timing: "now",
        time: departure,
      },
      queriedAt: departure,
      busy: false,
      locating: false,
      message: "",
      issues: [],
      restored: false,
    };
    const view = new JourneyView((id: string) => {
      state.selected = journeys.find((j) => j.id === id)!;
      view.render(state, 30);
    });
    view.onDetailsOpened = () => {
      document.body.dataset.detailOpens = String(
        Number(document.body.dataset.detailOpens ?? 0) + 1,
      );
    };
    (window as any).uxPreview = { state, view };
    document.body.dataset.view = "map";
    document.getElementById("search-view")!.hidden = true;
    document.getElementById("map-view")!.hidden = false;
    view.render(state, 30);
  });
}

test("choices compare movement effort, preserve focus and update unchanged journey IDs", async ({
  page,
}) => {
  await preview(page);
  await expect(page.locator(".route-choice")).toHaveCount(4);
  await expect(page.locator(".route-choice-effort").first()).toHaveText(
    "14 min Rad · 2 min Fuß · 1 Umstieg",
  );
  await expect(page.locator(".route-choice-effort").last()).toHaveText(
    "1 h 5 min Rad · 0 min Fuß · 0 Umstiege",
  );
  await expect(
    page.locator(".route-choice").last().locator(".icon"),
  ).toHaveAttribute("aria-hidden", "true");
  await page.locator('[data-journey="selected"]').focus();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys[1].legs[0].end += 60;
    view.render(state, 30);
  });
  await expect(
    page.locator('[data-journey="selected"] .route-choice-effort'),
  ).toContainText("15 min Rad");
  await expect(page.locator('[data-journey="selected"]')).toBeFocused();
});

test("opening details is intentional and a better connection stays explicitly selectable", async ({
  page,
}) => {
  await preview(page);
  await expect(page.locator("#better-connection")).toHaveCount(0);
  await page.evaluate(() => (window as any).uxPreview.view.setSize("expanded"));
  expect(
    await page.locator("body").getAttribute("data-detail-opens"),
  ).toBeNull();
  await toggleSelectedDetails(page);
  await expect(page.locator("body")).toHaveAttribute("data-detail-opens", "1");
  await page.locator('[data-journey="best"]').focus();
  await page.locator('[data-journey="best"]').press("Enter");
  await expect(page.locator('[data-journey="best"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#better-connection")).toHaveCount(0);
  await expect(page.locator('[data-journey="best"]')).toBeFocused();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.selected = state.journeys[1];
    state.journeys[1].arrival = state.journeys[0].arrival;
    view.render(state, 30);
  });
  await expect(page.locator("#better-connection")).toHaveCount(0);
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 844, height: 360 },
]) {
  test(`large text keeps four choices and actions reachable ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await preview(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const button of await page.locator(".route-choice").all()) {
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    for (const id of ["adjust-route", "close-route"]) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("full-height panel can reveal the map without losing its route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 360 });
  await preview(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const panel = page.locator("#journey-panel");
  await expect(panel).toHaveClass(/panel-full-height/);
  await expect(page.locator("#map-location")).toHaveJSProperty("inert", true);
  const toggle = page.locator("#panel-map-toggle");
  await toggle.click();
  await expect(panel).toHaveClass(/panel-map-only/);
  await expect(page.locator("#map-location")).toHaveJSProperty("inert", false);
  await expect(page.locator("#map-location")).toBeInViewport();
  await expect(toggle).toHaveAccessibleName("Reise anzeigen");
  await toggle.click();
  await expect(panel).not.toHaveClass(/panel-map-only/);
  await expect(page.locator(".route-choice")).toHaveCount(4);
  await expect(page.locator('[data-journey="selected"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

for (const width of [320, 390, 1280]) {
  test(`tools and actions stay fixed while route content scrolls at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await preview(page);
    await resizeOverview(page);
    const content = page.locator("#panel-content");
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.issues = ["Hinweis zur Verbindung. ".repeat(100)];
      view.render(state, 30);
    });
    await expect
      .poll(() => content.evaluate((e) => e.scrollHeight > e.clientHeight))
      .toBe(true);
    const header = await page.locator(".panel-tools").boundingBox();
    const actions = await page.locator(".panel-actions").boundingBox();
    await content.evaluate((e) => (e.scrollTop = 80));
    await expect.poll(() => content.evaluate((e) => e.scrollTop)).toBe(80);
    expect(await page.locator(".panel-tools").boundingBox()).toEqual(header);
    expect(await page.locator(".panel-actions").boundingBox()).toEqual(actions);
    await page.locator(".route-choice[aria-pressed=true]").focus();
    await page.keyboard.press("ArrowRight");
    expect(await content.evaluate((e) => e.scrollTop)).toBe(80);
    expect(await page.locator(".panel-tools").boundingBox()).toEqual(header);
    await content.evaluate((e) => (e.scrollTop = e.scrollHeight));
    expect(await page.locator(".panel-tools").boundingBox()).toEqual(header);
    await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: test.info().outputPath("fixed-tools.png"),
    });
  });
}

for (const width of [320, 390]) {
  test(`dragging changes visible panel heights at ${width}`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize({ width, height: 760 });
    await preview(page);
    const panel = page.locator("#journey-panel");
    const panelHeight = async () => (await panel.boundingBox())!.height;
    const drag = async (dy: number) => {
      const box = (await page.locator("#panel-handle").boundingBox())!;
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      if (browserName === "chromium") {
        const session = await page.context().newCDPSession(page);
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let i = 1; i <= 5; i++)
          await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y + (dy * i) / 5 }],
          });
        await session.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await session.detach();
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + dy, { steps: 5 });
        await page.mouse.up();
      }
    };
    await expect(page.locator(".route-choice").nth(1)).toBeInViewport({
      ratio: 1,
    });
    const normal = await panelHeight();
    await drag(65);
    await expect(panel).toHaveAttribute("data-size", "collapsed");
    await expect.poll(panelHeight).toBeLessThan(normal - 20);
    const collapsed = await panelHeight();
    await expect(page.locator(".route-choice").first()).toBeInViewport({
      ratio: 1,
    });
    await drag(-65);
    await expect(panel).toHaveAttribute("data-size", "normal");
    await expect.poll(panelHeight).toBe(normal);
    await drag(-65);
    await expect(panel).toHaveAttribute("data-size", "expanded");
    await expect.poll(panelHeight).toBeGreaterThan(normal + 20);
    await drag(65);
    await expect.poll(panelHeight).toBe(normal);
    const cancelHandle = (await page.locator("#panel-handle").boundingBox())!;
    const x = cancelHandle.x + cancelHandle.width / 2;
    const y = cancelHandle.y + cancelHandle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page
      .locator("#panel-handle")
      .dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.move(x, y + 65);
    await page.mouse.up();
    expect(await panelHeight()).toBe(normal);
    expect(collapsed).toBeLessThan(normal);
    await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 360 },
  { width: 1280, height: 900 },
]) {
  test(`route accordion keeps its header and toggles inline at ${viewport.width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await preview(page);
    const panel = page.locator("#journey-panel");
    const arrow = page.locator('[data-route-detail="best"]');
    await arrow.scrollIntoViewIfNeeded();
    const before = await arrow.boundingBox();
    const height = (await panel.boundingBox())!.height;
    await arrow.click();
    await expect(arrow).toHaveAttribute("aria-expanded", "true");
    await expect(arrow.locator("span")).toHaveCSS(
      "transform",
      "matrix(-1, 0, 0, -1, 0, 0)",
    );
    await expect(arrow).toBeFocused();
    await expect(arrow).toBeInViewport({ ratio: 1 });
    const arrowBounds = (await arrow.boundingBox())!;
    const panelBounds = (await panel.boundingBox())!;
    expect(arrowBounds.x + arrowBounds.width).toBeLessThanOrEqual(
      panelBounds.x + panelBounds.width,
    );
    expect(
      await page
        .locator("#panel-content")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(page.locator("#panel-summary, #fold-line")).toHaveCount(0);
    await expect(
      page.locator('[data-journey="best"] .route-outline'),
    ).toBeHidden();
    await expect(
      page.locator("#panel-details .journey-distance"),
    ).toContainText("km Rad");

    expect(
      await page
        .locator("#panel-details")
        .evaluate((e) =>
          e.previousElementSibling
            ?.querySelector("[data-journey]")
            ?.getAttribute("data-journey"),
        ),
    ).toBe("best");
    expect(Math.abs((await arrow.boundingBox())!.y - before!.y)).toBeLessThan(
      2,
    );
    expect((await panel.boundingBox())!.height).toBe(height);
    await expect(panel).toHaveAttribute("data-size", "normal");
    await page.screenshot({ path: info.outputPath("accordion-open.png") });
    await arrow.click();
    await expect(arrow).toHaveAttribute("aria-expanded", "false");
    await expect(arrow.locator("span")).toHaveCSS("transform", "none");
    await expect(page.locator("#panel-details")).toBeHidden();
    await expect(
      page.locator('[data-journey="best"] .route-outline'),
    ).toBeVisible();
    await expect(page.locator('[data-journey="best"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(arrow).toBeFocused();
    await expect(page.locator("#panel-size, #back-to-choices")).toHaveCount(0);
    expect(await page.locator("button button").count()).toBe(0);
  });
}

test("accordion switches, preserves updated details and resets for selection or new planning", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(page);
  await page.locator('[data-route-detail="best"]').click();
  await page.locator('[data-route-detail="selected"]').click();
  await expect(
    page.locator('.route-details-button[aria-expanded="true"]'),
  ).toHaveCount(1);
  await expect(page.locator('[data-route-detail="selected"]')).toBeFocused();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.journeys[1].legs[0].to.name = "Aktualisierter Bahnhof";
    view.render(state, 30);
  });
  await expect(page.locator("#panel-details")).toContainText(
    "Aktualisierter Bahnhof",
  );
  await page.locator("#panel-handle").press("End");
  await page.locator("#panel-handle").press("Home");
  await expect(page.locator('[data-route-detail="selected"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator('[data-journey="best"]').click();
  await expect(page.locator("#panel-details")).toBeHidden();
  await page.locator('[data-route-detail="comparison"]').click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    state.busy = true;
    view.render(state, 30);
  });
  await expect(page.locator("#panel-details")).toBeHidden();
});

for (const width of [900, 1280, 1479]) {
  test(`desktop sidebar fills available height at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1200 });
    await preview(page);
    const panel = page.locator("#journey-panel");
    const map = (await page.locator("#map-view").boundingBox())!;
    const bounds = (await panel.boundingBox())!;
    expect(bounds.width).toBe(420);
    expect(bounds.x - map.x).toBe(20);
    expect(bounds.y - map.y).toBe(20);
    expect(map.height - bounds.height).toBe(40);
    await expect(page.locator("#panel-handle")).toBeHidden();
    await expect(page.locator(".route-choice").last()).toBeInViewport({
      ratio: 1,
    });
    const actions = (await page.locator(".panel-actions").boundingBox())!;
    expect(bounds.y + bounds.height - actions.y - actions.height).toBe(16);
    await page.locator('[data-route-detail="best"]').click();
    expect(await panel.boundingBox()).toEqual(bounds);
    await page.evaluate(() => {
      const { state, view } = (window as any).uxPreview;
      state.issues = ["Längerer Hinweis. ".repeat(500)];
      view.render(state);
    });
    const content = page.locator("#panel-content");
    await expect
      .poll(() => content.evaluate((e) => e.scrollHeight > e.clientHeight))
      .toBe(true);
    await content.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
    expect(await page.locator(".panel-actions").boundingBox()).toEqual(actions);
    expect(await panel.boundingBox()).toEqual(bounds);
    await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
    await content.evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath("desktop-full-height.png") });
  });
}

test("sidebar breakpoint preserves mobile size, selection and disclosure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 899, height: 986 });
  await preview(page);
  await page.locator("#panel-handle").press("Home");
  await page.locator('[data-route-detail="best"]').click();
  await page.locator("#panel-handle").focus();
  await page.setViewportSize({ width: 900, height: 986 });
  await expect(page.locator("#panel-handle")).toBeHidden();
  await expect(page.locator('[data-journey="best"]')).toBeFocused();
  await expect(page.locator("#panel-details")).toBeVisible();
  await page.evaluate(() => {
    const { state, view } = (window as any).uxPreview;
    view.setSize("expanded", true);
    state.message = "Verbindungen optimieren …";
    view.render(state);
  });
  await expect(page.locator("#status")).toBeVisible();
  await page.setViewportSize({ width: 899, height: 986 });
  await expect(page.locator("#panel-handle")).toBeVisible();
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-size",
    "collapsed",
  );
  await expect(page.locator('[data-route-detail="best"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator("#panel-handle").press("ArrowUp");
  await expect(page.locator("#journey-panel")).toHaveAttribute(
    "data-size",
    "normal",
  );
});

test("very short desktop sidebar keeps all actions reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 280 });
  await preview(page);
  await page.addStyleTag({ content: ":root { font-size: 32px; }" });
  const panel = page.locator("#journey-panel");
  await expect(panel).toHaveClass(/panel-scroll-all/);
  await panel.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(page.locator("#adjust-route")).toBeInViewport({ ratio: 1 });
  await panel.evaluate((e) => {
    e.scrollTop = 0;
  });
  await expect(page.locator("#close-route")).toBeInViewport({ ratio: 1 });
});

test("opening details preserves focus moved before the next frame", async ({
  page,
}) => {
  await preview(page);
  await page.evaluate(async () => {
    document
      .querySelector<HTMLButtonElement>('[data-route-detail="best"]')!
      .click();
    document.getElementById("adjust-route")!.focus();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  await expect(page.locator("#adjust-route")).toBeFocused();
  await expect(page.locator("#panel-details")).toBeVisible();
});
