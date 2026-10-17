import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("route transitions are interruptible and preserve real history and focus", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?example=bike-transfer");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  const started = await page
    .locator(".route-detail-link")
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      return document.getElementById("panel-details")!.getAnimations().length;
    });
  expect(started).toBeGreaterThan(0);
  await expect(page.locator("#journey-heading")).toBeFocused();
  // Switch again while the previous entrance is still running.
  await page
    .locator("#panel-map-toggle")
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "detail",
  );
  await expect(page.locator("#journey-heading")).toBeFocused();
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  await expect(page.locator(".route-detail-link")).toBeFocused();
  await expect
    .poll(() =>
      page
        .locator("#journey-panel")
        .evaluate((panel) => panel.getAnimations({ subtree: true }).length),
    )
    .toBe(0);
  expect(errors).toEqual([]);
});

test("changing Reduced Motion ends current motion and restores inline styles", async ({
  page,
}) => {
  await page.goto("/?example=bike-transfer");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  const started = await page
    .locator(".route-detail-link")
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      const animations = document
        .getElementById("panel-details")!
        .getAnimations();
      // A paused animation cannot finish naturally and hide a missing abort.
      for (const animation of animations) animation.pause();
      return animations.length;
    });
  expect(started).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page.locator("#panel-details").evaluate((panel) => ({
        count: panel.getAnimations().length,
        translate: (panel as HTMLElement).style.translate,
        opacity: (panel as HTMLElement).style.opacity,
      })),
    )
    .toEqual({ count: 0, translate: "", opacity: "" });
  await page.locator("#panel-map-toggle").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  const count = await page
    .locator("#map-preview-summary")
    .evaluate((summary) => summary.getAnimations().length);
  expect(count).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goBack();
  await page.goBack();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  const resumed = await page
    .locator(".route-detail-link")
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      return document.getElementById("panel-details")!.getAnimations().length;
    });
  expect(resumed).toBeGreaterThan(0);
  await expect(page.locator("#journey-heading")).toBeFocused();
});

test("rapid main navigation keeps the indicator aligned after resizing", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".app-tabs")).toHaveAttribute(
    "data-motion",
    "ready",
  );
  await page.evaluate(async () => {
    // Let the initial ResizeObserver notifications finish before interrupting motion.
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  for (const [index, id] of [
    "tab-history",
    "tab-settings",
    "tab-route",
    "tab-settings",
  ].entries()) {
    const transition = await page.evaluate(async (id) => {
      const marker = document.querySelector<HTMLElement>(".tab-indicator")!;
      const previous = marker.getAnimations();
      document.getElementById(id)!.click();
      // Each change must reach the observer before the next navigation action.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const current = marker.getAnimations();
      for (const animation of current) {
        animation.pause();
        animation.currentTime = 40;
      }
      return {
        previous: previous.length,
        cancelled: previous.every(
          (animation) => animation.playState === "idle",
        ),
        current: current.length,
      };
    }, id);
    if (index > 0) expect(transition.previous).toBeGreaterThan(0);
    expect(transition.cancelled).toBe(true);
    expect(transition.current).toBeGreaterThan(0);
  }
  await page.locator(".tab-indicator").evaluate((marker) => {
    for (const animation of marker.getAnimations()) animation.finish();
  });
  await expect(page.locator("#settings-view")).toBeVisible();
  await expect(page.locator("#tab-settings")).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const width of [320, 1200]) {
    await page.setViewportSize({ width, height: 844 });
    for (const fontSize of ["16px", "24px", "32px"]) {
      await page.evaluate((value) => {
        document.documentElement.style.fontSize = value;
      }, fontSize);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const marker = document
              .querySelector(".tab-indicator")!
              .getBoundingClientRect();
            const icon = document
              .querySelector("#tab-settings .icon")!
              .getBoundingClientRect();
            return Math.abs(
              marker.left + marker.width / 2 - icon.left - icon.width / 2,
            );
          }),
        )
        .toBeLessThan(1);
    }
  }
});

test("dialog exit never delays Escape or the next navigation action", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#tab-settings").click();
  await page.locator("#settings-data summary").click();
  await page.locator("#clear-data").click();
  await expect(page.locator("#delete-data-dialog")).toHaveAttribute("open");
  await page.keyboard.press("Escape");
  await expect(page.locator("#delete-data-dialog")).not.toHaveAttribute("open");
  // Reopening during the painted exit must also retain native modal semantics.
  await page.locator("#clear-data").click();
  await expect(page.locator("#delete-data-dialog")).toHaveAttribute("open");
  await page.keyboard.press("Escape");
  await expect(page.locator("#delete-data-dialog")).not.toHaveAttribute("open");
  await page.locator("#tab-route").click();
  await expect(page.locator("#search-view")).toBeVisible();
  await expect(page.locator("#destination")).toBeEnabled();
});

test("Reduced Motion applies to dialogs, disclosure chevrons and navigation from first load", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.locator("#tab-settings").click();
  await page.locator("#settings-data summary").click();
  await page.locator("#clear-data").click();
  await expect(page.locator("#delete-data-dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
    ),
  ).toBe(0);
  await page.keyboard.press("Escape");
  await page.locator("#tab-route").click();
  await page.locator("#destination").fill("Berlin");
  await expect(page.locator("#destination")).toBeFocused();
  await expect(page.locator(".search-focus-back")).toBeVisible();
});

test("disabled actions retain their visual state during disclosure motion", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#tab-settings").click();
  const opacity = await page.locator("#settings-data").evaluate((detail) => {
    const button = document.getElementById("delete-saved")!;
    const before = Number(getComputedStyle(button).opacity);
    return new Promise<{
      before: number;
      during: number;
      end: number;
      count: number;
    }>((resolve) => {
      // setupMotion handles toggle in document's capture phase, before this listener.
      detail.addEventListener(
        "toggle",
        () => {
          const animations = button.getAnimations();
          for (const animation of animations) {
            animation.pause();
            animation.currentTime =
              Number(animation.effect!.getTiming().duration) / 2;
          }
          const frames = animations.flatMap((animation) =>
            (animation.effect as KeyframeEffect)
              .getKeyframes()
              .filter((frame) => frame.opacity !== undefined),
          );
          const during = Number(getComputedStyle(button).opacity);
          const end = Number(frames.at(-1)?.opacity);
          for (const animation of animations) animation.finish();
          resolve({ before, during, end, count: animations.length });
        },
        { once: true },
      );
      detail.querySelector<HTMLElement>("summary")!.click();
    });
  });
  expect(opacity.count).toBeGreaterThan(0);
  expect(opacity.before).toBeLessThanOrEqual(0.5);
  expect(opacity.during).toBeLessThanOrEqual(opacity.before);
  expect(opacity.end).toBeCloseTo(opacity.before);
  await expect(page.locator("#delete-saved")).toBeDisabled();
});

test("the app remains usable without the Web Animations API", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "animate", {
      value: undefined,
      configurable: true,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?example=bike-transfer");
  await page.locator(".route-detail-link").click();
  await expect(page.locator("#journey-heading")).toBeFocused();
  await page.locator("#panel-map-toggle").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await page.goBack();
  await expect(page.locator("#journey-heading")).toBeFocused();
  expect(errors).toEqual([]);
});
