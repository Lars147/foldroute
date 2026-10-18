import { test, expect, type Page } from "@playwright/test";
import { showMap } from "./assertions";
import { mockRasterBasemap } from "./basemap";

const key = "foldroute.mapStyle";

async function example(page: Page) {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/?example=bike-transfer");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await showMap(page);
  await expect(page.locator(".route-marker")).toHaveCount(2);
}

async function picker(page: Page) {
  await page
    .getByRole("button", { name: "Kartenstil wählen", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: "Karte anpassen",
    exact: true,
  });
  await expect(panel).toBeVisible();
  return panel;
}

async function expectMobileSheet(page: Page) {
  const panel = page.getByRole("dialog", {
    name: "Karte anpassen",
    exact: true,
  });
  await expect
    .poll(() =>
      panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          fullWidth:
            Math.abs(bounds.left) <= 1 &&
            Math.abs(bounds.right - innerWidth) <= 1,
          bottomAligned: Math.abs(bounds.bottom - innerHeight) <= 1,
          boundedHeight: bounds.height <= innerHeight * 0.7 + 1,
          noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
        };
      }),
    )
    .toEqual({
      fullWidth: true,
      bottomAligned: true,
      boundedHeight: true,
      noHorizontalOverflow: true,
    });
  await expect(
    panel.getByRole("button", { name: "Kartenstile schließen", exact: true }),
  ).toBeInViewport({ ratio: 1 });
}

test("route map retains its basemap and attribution through connection changes", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await example(page);
  const styles = await mockRasterBasemap(page);
  await page.evaluate(async () => {
    const { mapStyle } = await import("/src/map-style.ts");
    mapStyle.set("liberty");
  });
  await expect.poll(() => styles.length).toBe(1);
  const canvas = page.locator("#map canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const loaded = await canvas.elementHandle();
  for (const offline of [true, false, true, false]) {
    await context.setOffline(offline);
    await expect(canvas).toBeVisible();
    expect(
      await canvas.evaluate(
        (current, previous) => current === previous,
        loaded,
      ),
    ).toBe(true);
    await expect(
      page.locator(
        '#map-label a[href="https://www.openstreetmap.org/copyright"]',
      ),
    ).toBeVisible();
    if (offline)
      await expect(page.locator("#map-error")).toContainText(
        "Neue Bereiche benötigen Internet",
      );
    else await expect(page.locator("#map-error")).toBeHidden();
  }
  expect(styles).toEqual(["https://tiles.openfreemap.org/styles/liberty"]);
});

test("mobile layers slide up smoothly on every opening", async ({ page }) => {
  await page.setViewportSize({ width: 425, height: 812 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await example(page);
  for (let opening = 0; opening < 2; opening++) {
    const motion = await page.evaluate(() => {
      const trigger = document.querySelector<HTMLButtonElement>(
        "#map-style-control button",
      )!;
      const panel = document.getElementById("overview-map-style-panel")!;
      trigger.click();
      const animations = panel.getAnimations();
      const animation = animations.find(
        (animation) =>
          (animation as CSSTransition).transitionProperty === "translate",
      );
      if (!animation) throw new Error("Missing mobile sheet entry animation");
      animations.forEach((animation) => animation.pause());
      const duration = Number(animation.effect!.getTiming().duration);
      const tops = [0, 0.25, 0.5, 1].map((progress) => {
        animation.currentTime = duration * progress;
        return panel.getBoundingClientRect().top;
      });
      const height = panel.getBoundingClientRect().height;
      animations.forEach((animation) => animation.finish());
      return { tops, height, viewportHeight: innerHeight };
    });
    const [start, quarter, halfway, end] = motion.tops;
    expect(start).toBeGreaterThanOrEqual(motion.viewportHeight);
    expect(quarter).toBeLessThan(start);
    expect(halfway).toBeLessThan(quarter);
    expect(end).toBeLessThan(halfway);
    expect(end + motion.height).toBeCloseTo(motion.viewportHeight, 0);
    // Deceleration covers most distance early, then settles without overshoot.
    expect(start - halfway).toBeGreaterThan((start - end) * 0.5);
    await expectMobileSheet(page);
    await expect(
      page.getByRole("radio", { name: "Positron", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#overview-map-style-panel")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Kartenstil wählen", exact: true }),
    ).toBeFocused();
  }
});

for (const { name, width } of [
  { name: "mobile", width: 425 },
  { name: "desktop", width: 1280 },
] as const) {
  for (const close of ["button", "Escape", "outside", "trigger"] as const) {
    test(`${name} layers keep their size while closing via ${close}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await example(page);
      await picker(page);
      const panel = page.locator("#overview-map-style-panel");
      const trigger = page.getByRole("button", {
        name: "Kartenstil wählen",
        exact: true,
      });
      const open = await panel.evaluate((element) => {
        const animations = element.getAnimations();
        const entry = animations.find(
          (animation) =>
            (animation as CSSTransition).transitionProperty === "translate",
        );
        if (!entry) throw new Error("Missing menu entry transition");
        const duration = Number(entry.effect!.getTiming().duration);
        animations.forEach((animation) => animation.finish());
        const bounds = element.getBoundingClientRect();
        element.addEventListener("toggle", function pauseExit(event) {
          if ((event as ToggleEvent).newState !== "closed") return;
          element.getAnimations().forEach((animation) => animation.pause());
          element.setAttribute("data-exit-paused", "true");
          element.removeEventListener("toggle", pauseExit);
        });
        return { width: bounds.width, height: bounds.height, duration };
      });

      if (close === "button") {
        await panel
          .getByRole("button", { name: "Kartenstile schließen", exact: true })
          .click();
      } else if (close === "Escape") {
        await page.keyboard.press("Escape");
      } else if (close === "outside") {
        await page.mouse.click(10, 16);
      } else {
        await trigger.click();
      }
      await expect(panel).toHaveAttribute("data-exit-paused", "true");
      const exit = await panel.evaluate((element) => {
        const animations = element.getAnimations();
        const frames = [0, 0.5, 0.95].map((progress) => {
          animations.forEach((animation) => {
            animation.currentTime =
              Number(animation.effect!.getTiming().duration) * progress;
          });
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            width: bounds.width,
            height: bounds.height,
            direction: style.flexDirection,
            opacity: Number(style.opacity),
          };
        });
        return {
          animationCount: animations.length,
          durations: animations.map((animation) =>
            Number(animation.effect!.getTiming().duration),
          ),
          supportsOverlay: CSS.supports("overlay", "auto"),
          closed: !element.matches(":popover-open"),
          frames,
        };
      });
      expect(exit.closed).toBe(true);
      if (exit.supportsOverlay) {
        expect(exit.animationCount).toBeGreaterThan(0);
        // Full dismissals finish sooner than entry, with all tracks aligned.
        expect(new Set(exit.durations).size).toBe(1);
        expect(exit.durations[0]).toBeLessThan(open.duration);
        for (const frame of exit.frames) {
          expect(Math.abs(frame.width - open.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(frame.height - open.height)).toBeLessThanOrEqual(1);
          expect(frame.direction).toBe("column");
        }
        expect(exit.frames[2].opacity).toBeLessThan(exit.frames[0].opacity);
      } else {
        // Without overlay transitions, native popovers close immediately.
        expect(exit.animationCount).toBe(0);
        await expect(panel).toBeHidden();
      }
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      if (close === "button" || close === "Escape") {
        await expect(trigger).toBeFocused();
      }

      // Reopen before the paused exit finishes, then complete a normal close.
      await trigger.click();
      await expect(panel).toHaveCSS("flex-direction", "column");
      await expect(
        panel.getByRole("radio", { name: "Positron", exact: true }),
      ).toBeFocused();
      const reopened = await panel.evaluate((element) => {
        element.getAnimations().forEach((animation) => animation.finish());
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      });
      expect(reopened).toEqual({ width: open.width, height: open.height });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  }
}

for (const { name, width, reducedMotion } of [
  { name: "reduced motion", width: 425, reducedMotion: "reduce" },
  { name: "desktop with reduced motion", width: 1280, reducedMotion: "reduce" },
  { name: "desktop", width: 1280, reducedMotion: "no-preference" },
] as const) {
  test(`layers respect motion preferences for ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.emulateMedia({ reducedMotion });
    await example(page);
    const animations = await page.evaluate(() => {
      document
        .querySelector<HTMLButtonElement>("#map-style-control button")!
        .click();
      const animations = document
        .getElementById("overview-map-style-panel")!
        .getAnimations();
      animations.forEach((animation) => animation.finish());
      return animations.length;
    });
    if (reducedMotion === "reduce") expect(animations).toBe(0);
    else expect(animations).toBeGreaterThan(0);
    const panel = page.getByRole("dialog", {
      name: "Karte anpassen",
      exact: true,
    });
    await expect(panel).toBeInViewport({ ratio: 1 });
    await panel
      .getByRole("radio", { name: "Straßenkarte", exact: true })
      .check();
    await expect(
      panel.getByRole("radio", { name: "Straßenkarte", exact: true }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    if (reducedMotion === "reduce") {
      expect(
        await page
          .locator("#overview-map-style-panel")
          .evaluate((element) => element.getAnimations().length),
      ).toBe(0);
    }
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`mobile layers open a tile menu and keep the selection visible in ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 425, height: 812 });
    await example(page);
    for (const [width, height] of [
      [320, 568],
      [425, 812],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      const panel = await picker(page);
      await expectMobileSheet(page);
      await expect(
        panel.getByRole("heading", { name: "Kartenstil", exact: true }),
      ).toBeVisible();
      const previews = await panel
        .locator(".map-style-preview")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            };
          }),
        );
      expect(previews).toHaveLength(3);
      expect(
        previews.every(
          (preview) =>
            preview.top === previews[0].top &&
            Math.abs(preview.width - preview.height) <= 1 &&
            preview.width <= 96,
        ),
      ).toBe(true);
      await expect(
        panel.getByRole("radio", { name: "Positron", exact: true }),
      ).toHaveAccessibleDescription("Hell und reduziert");
      await panel
        .getByRole("radio", { name: "Straßenkarte", exact: true })
        .check();
      await expect(panel).toBeVisible();
      await expect(
        panel.getByRole("radio", { name: "Straßenkarte", exact: true }),
      ).toBeChecked();
      await expect(
        panel.locator(".map-style-option").filter({
          has: page.getByRole("radio", { name: "Straßenkarte", exact: true }),
        }),
      ).toHaveCSS("outline-style", "none");
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        colorScheme,
      );
      await page.screenshot({
        path: info.outputPath(`layers-${width}x${height}.png`),
      });
      await panel
        .getByRole("button", { name: "Kartenstile schließen", exact: true })
        .click();
      await expect(panel).toBeHidden();
      const trigger = page.getByRole("button", {
        name: "Kartenstil wählen",
        exact: true,
      });
      await expect(trigger).toBeFocused();
      await picker(page);
      if (width === 425) {
        await trigger.click();
      } else {
        await page.mouse.click(10, 16);
      }
      await expect(panel).toBeHidden();
    }
  });
}

test("open layer menu adapts between desktop and mobile and keeps large text scrollable", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 425, height: 812 });
  await example(page);
  const panel = await picker(page);
  const selected = panel.getByRole("radio", {
    name: "Straßenkarte",
    exact: true,
  });
  await selected.check();
  await selected.focus();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS("width", "320px");
  await expect(panel.locator(".map-style-options")).toHaveCSS(
    "display",
    "flex",
  );
  await expect(selected).toBeChecked();
  await expect(selected).toBeFocused();
  await expect(panel).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 320, height: 568 });
  await expectMobileSheet(page);
  await expect(selected).toBeFocused();
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  for (const name of ["Positron", "Dunkel", "Straßenkarte"]) {
    await panel.getByRole("radio", { name, exact: true }).check();
    await expectMobileSheet(page);
    await expect(panel.getByRole("radio", { name, exact: true })).toBeChecked();
    expect(
      await panel
        .locator(".map-style-copy strong")
        .evaluateAll((elements) =>
          elements.every(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ),
    ).toBe(true);
  }
  await page.screenshot({ path: info.outputPath("layers-large-text.png") });
  await panel
    .getByRole("button", { name: "Kartenstile schließen", exact: true })
    .click();
  await expect(panel).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Kartenstil wählen", exact: true }),
  ).toBeFocused();
});

for (const width of [390, 1280]) {
  test(`map styles preserve the route and camera and persist independently of app appearance at ${width}px`, async ({
    page,
    browserName,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await example(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-map-style",
      "positron",
    );
    const route = page.locator('.leaflet-overlay-pane path[stroke-width="6"]');
    const beforeZoom = await route.evaluateAll((paths) =>
      paths.map((path) => path.getAttribute("d")),
    );
    await page.locator("#map-route").focus();
    // Safari's default keyboard access uses Option-Tab to include buttons.
    const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
    await page.keyboard.press(tab);
    await expect(
      page.locator("#map-style-control button").first(),
    ).toBeFocused();
    await page.keyboard.press(tab);
    await expect(
      page.getByRole("button", { name: "Vergrößern", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    // A zoom gesture has to finish before comparing projected route geometry.
    await expect
      .poll(() =>
        route.evaluateAll((paths) =>
          paths.map((path) => path.getAttribute("d")),
        ),
      )
      .not.toEqual(beforeZoom);
    await expect.poll(() => page.locator(".leaflet-zoom-anim").count()).toBe(0);
    const geometry = await route.evaluateAll((paths) =>
      paths.map((path) => path.getAttribute("d")),
    );
    const selected = await page
      .locator('.route-choice[aria-pressed="true"]')
      .getAttribute("data-journey");
    const panel = await picker(page);
    await expect(
      panel.getByRole("radio", { name: "Dunkel", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    for (const [name, value] of [
      ["Straßenkarte", "liberty"],
      ["Dunkel", "dark"],
      ["Positron", "positron"],
    ]) {
      await panel.getByRole("radio", { name, exact: true }).check();
      await expect(page.locator("html")).toHaveAttribute(
        "data-map-style",
        value,
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(
        await route.evaluateAll((paths) =>
          paths.map((path) => path.getAttribute("d")),
        ),
      ).toEqual(geometry);
      await expect(
        page.locator('.route-choice[aria-pressed="true"]'),
      ).toHaveAttribute("data-journey", selected!);
    }
    await panel
      .getByRole("radio", { name: "Straßenkarte", exact: true })
      .check();
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      "liberty",
    );
    await panel.screenshot({ path: info.outputPath("map-styles.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Kartenstil wählen", exact: true }),
    ).toBeFocused();
    await page.reload();
    await expect(page.locator("#main")).not.toHaveAttribute("inert");
    await showMap(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-map-style",
      "liberty",
    );
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute(
      "data-map-style",
      "liberty",
    );
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`overview credits follow the mobile travel panel in ${colorScheme}`, async ({
    page,
  }, info) => {
    const layoutErrors: string[] = [];
    page.on("pageerror", (error) => {
      if (error.message.includes("ResizeObserver"))
        layoutErrors.push(error.message);
    });
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 425, height: 812 });
    await example(page);
    const credit = page.locator(".map-credit");
    await expect(credit.locator("a")).toHaveCount(2);
    await expect(credit).toHaveText("© OpenMapTiles · © OpenStreetMap");
    const expectMobileCredit = async () => {
      await expect
        .poll(() =>
          credit.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const panel = document
              .getElementById("journey-panel")!
              .getBoundingClientRect();
            const controls = document
              .getElementById("map-controls")!
              .getBoundingClientRect();
            const overlapsControls =
              bounds.top < controls.bottom && bounds.bottom > controls.top;
            const style = getComputedStyle(
              document.getElementById("map-view")!,
            );
            const sidebar =
              style.getPropertyValue("--map-panel-layout").trim() === "side";
            return {
              clearPanel: sidebar
                ? bounds.left >= panel.right + 9
                : Math.abs(panel.top - bounds.bottom - 6) <= 1,
              rightAligned:
                Math.abs(
                  bounds.right -
                    (sidebar
                      ? innerWidth - parseFloat(style.paddingRight) - 10
                      : Math.min(
                          panel.right,
                          overlapsControls ? controls.left - 8 : panel.right,
                        )),
                ) <= 1,
              inViewport:
                bounds.top >= 0 &&
                bounds.left >= 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight,
            };
          }),
        )
        .toEqual({ clearPanel: true, rightAligned: true, inViewport: true });
      for (const link of await credit.locator("a").all())
        await link.click({ trial: true });
    };
    for (const [width, height] of [
      [320, 568],
      [425, 812],
      [844, 390],
    ]) {
      await page.setViewportSize({ width, height });
      await expectMobileCredit();
      if (width === 425) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await expectMobileCredit();
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "";
        });
        await expectMobileCredit();
      }
      await page.screenshot({
        path: info.outputPath(`overview-credits-${width}x${height}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(credit).toHaveCSS("bottom", "12px");
    await expect(credit).toHaveCSS("left", "460px");
    await expect(credit).toHaveCSS("transform", "none");
    await expect(credit).toBeInViewport();
    const sources = page.locator("#panel-details .journey-sources a");
    await expect(sources).toBeVisible();
    await expect(sources).toHaveAttribute(
      "href",
      "https://transitous.org/sources/",
    );
    expect(layoutErrors).toEqual([]);
  });

  test(`map tools form a reachable column without covering the travel panel in ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await example(page);
    for (const [width, height] of [
      [320, 568],
      [390, 844],
      [844, 390],
      [1280, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await showMap(page);
      const tools = [
        page.locator("#map-route"),
        page.locator("#map-style-control button").first(),
        page.locator(".leaflet-control-zoom-in"),
        page.locator(".leaflet-control-zoom-out"),
      ];
      await expect
        .poll(async () => {
          const panel = (await page.locator("#journey-panel").boundingBox())!;
          const bounds = await Promise.all(
            tools.map((tool) => tool.boundingBox()),
          );
          return bounds.every(
            (box) =>
              box &&
              box.width === 48 &&
              box.height === 48 &&
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= width &&
              box.y + box.height <= height &&
              !(
                box.x < panel.x + panel.width &&
                box.x + box.width > panel.x &&
                box.y < panel.y + panel.height &&
                box.y + box.height > panel.y
              ),
          );
        })
        .toBe(true);
      const bounds = await Promise.all(
        tools.map(async (tool) => (await tool.boundingBox())!),
      );
      const group = (await page.locator("#map-controls").boundingBox())!;
      const map = (await page.locator("#map").boundingBox())!;
      expect(bounds.every((box) => box.x === bounds[0].x)).toBe(true);
      expect(map.x + map.width - group.x - group.width).toBe(16);
      expect(bounds[0].y - map.y).toBe(14);
      expect(bounds[1].y - bounds[0].y - 48).toBe(8);
      expect(bounds[2].y - bounds[1].y - 48).toBe(8);
      expect(bounds[3].y - bounds[2].y - 48).toBe(0);
      const panel = await picker(page);
      await expect(
        panel.getByRole("radio", { name: "Dunkel", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await page.screenshot({
        path: info.outputPath(`map-controls-${width}x${height}.png`),
      });
    }
  });
}

test("map style selection supports keyboard and large text on narrow screens", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await example(page);
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  const trigger = page.getByRole("button", {
    name: "Kartenstil wählen",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", {
    name: "Karte anpassen",
    exact: true,
  });
  await expect(
    panel.getByRole("radio", { name: "Positron", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    panel.getByRole("radio", { name: "Straßenkarte", exact: true }),
  ).toBeChecked();
  await expectMobileSheet(page);
  await panel.screenshot({
    path: info.outputPath("map-styles-large-text.png"),
  });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("map style selection synchronizes between tabs and data clearing restores Positron", async ({
  page,
  context,
}) => {
  await example(page);
  const second = await context.newPage();
  await example(second);
  const panel = await picker(page);
  await panel.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await expect(second.locator("html")).toHaveAttribute(
    "data-map-style",
    "dark",
  );
  const other = await picker(second);
  await expect(
    other.getByRole("radio", { name: "Dunkel", exact: true }),
  ).toBeChecked();
  await page.evaluate(() => localStorage.clear());
  await expect(second.locator("html")).toHaveAttribute(
    "data-map-style",
    "positron",
  );
  await expect(
    other.getByRole("radio", { name: "Positron", exact: true }),
  ).toBeChecked();
  await second.close();
});

test("invalid map preference falls back to Positron and blocked storage permits a session choice", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "unknown-style");
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key)
        throw new DOMException("Storage blocked", "SecurityError");
      return original.call(this, name, value);
    };
  }, key);
  await example(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-map-style",
    "positron",
  );
  const panel = await picker(page);
  await panel.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-map-style", "dark");
  await expect(panel.getByRole("status")).toHaveText(
    "Kartenstil gilt nur für diese Sitzung.",
  );
});
