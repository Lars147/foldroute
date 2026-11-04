import { test, expect } from "./test";

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("sheet transitions are interruptible and preserve history and focus", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?example=bike-transfer");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  const started = await page.locator("#map-open-details").evaluate((button) => {
    (button as HTMLButtonElement).click();
    return document.getElementById("alternatives-dialog")!.getAnimations()
      .length;
  });
  expect(started).toBeGreaterThan(0);
  await expect(page.locator("#alternatives-title")).toBeFocused();
  // Close during the entrance, then restore the same overlay through history.
  await page
    .locator("#alternatives-close")
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#map-open-details")).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => !!history.state?.exampleView?.sheet))
    .toBe(false);
  await page.goForward();
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await expect(page.locator("#alternatives-title")).toBeFocused();
  await page.goBack();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expect(page.locator("#map-open-details")).toBeFocused();
  await expect
    .poll(() =>
      page
        .locator("#alternatives-dialog")
        .evaluate((dialog) => dialog.getAnimations().length),
    )
    .toBe(0);
  expect(errors).toEqual([]);
});

test("changing Reduced Motion ends the sheet transition", async ({ page }) => {
  await page.goto("/?example=bike-transfer");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  const started = await page.locator("#map-open-details").evaluate((button) => {
    (button as HTMLButtonElement).click();
    const animations = document
      .getElementById("alternatives-dialog")!
      .getAnimations();
    for (const animation of animations) animation.pause();
    return animations.length;
  });
  expect(started).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page
        .locator("#alternatives-dialog")
        .evaluate((dialog) => dialog.getAnimations().length),
    )
    .toBe(0);
  await page.locator("#alternatives-close").click();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await page.locator("#map-open-details").click();
  expect(
    await page
      .locator("#alternatives-dialog")
      .evaluate((dialog) => dialog.getAnimations().length),
  ).toBe(0);
  await page.locator("#alternatives-close").click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const resumed = await page.locator("#map-open-details").evaluate((button) => {
    (button as HTMLButtonElement).click();
    return document.getElementById("alternatives-dialog")!.getAnimations()
      .length;
  });
  expect(resumed).toBeGreaterThan(0);
  await expect(page.locator("#alternatives-title")).toBeFocused();
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
      const previous = marker.getAnimations({ subtree: true });
      document.getElementById(id)!.click();
      // Each change must reach the observer before the next navigation action.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const current = marker.getAnimations({ subtree: true });
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
    for (const animation of marker.getAnimations({ subtree: true }))
      animation.finish();
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
            const button = document
              .querySelector("#tab-settings")!
              .getBoundingClientRect();
            const inset = innerWidth < 900 ? 0 : 4;
            return Math.max(
              Math.abs(marker.left - button.left - inset),
              Math.abs(marker.top - button.top - inset),
              Math.abs(marker.width - button.width + inset * 2),
              Math.abs(marker.height - button.height + inset * 2),
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
  await page.locator("#map-open-details").click();
  await expect(page.locator("#alternatives-title")).toBeFocused();
  await page.locator("#alternatives-close").click();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await page.goForward();
  await expect(page.locator("#alternatives-title")).toBeFocused();
  expect(errors).toEqual([]);
});
