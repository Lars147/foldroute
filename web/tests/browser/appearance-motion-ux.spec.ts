import { test, expect, type Page } from "./test";
import { expectMotionSettled } from "./assertions";

const indicator = ".appearance-indicator";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({
    reducedMotion: "no-preference",
    colorScheme: "light",
  });
});

async function expectAligned(page: Page) {
  await expect
    .poll(() =>
      page.locator(".appearance-segments").evaluate((segments) => {
        const frame = segments
          .querySelector(".appearance-indicator")!
          .getBoundingClientRect();
        const target = segments
          .querySelector("input:checked")!
          .nextElementSibling!.getBoundingClientRect();
        return Math.max(
          Math.abs(frame.left - target.left),
          Math.abs(frame.top - target.top),
          Math.abs(frame.width - target.width),
          Math.abs(frame.height - target.height),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function open(page: Page) {
  await page.goto("/");
  await page.locator("#tab-settings").click();
  await expect(page.locator(".appearance-segments")).toHaveAttribute(
    "data-motion",
    "ready",
  );
  await expectMotionSettled(page.locator("#app-settings"));
  await expectAligned(page);
}

for (const { width, fontSize, axis } of [
  { width: 1280, fontSize: 16, axis: "left" },
  { width: 320, fontSize: 32, axis: "top" },
] as const) {
  test(`appearance frame glides without overshoot on the ${axis} axis and preserves keyboard focus`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.addStyleTag({ content: `html { font-size: ${fontSize}px; }` });
    await page.locator(".appearance-segments").scrollIntoViewIfNeeded();
    await expectAligned(page);
    const motion = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLElement>(
        ".appearance-indicator",
      )!;
      const input = document.querySelector<HTMLInputElement>(
        'input[name="appearance"][value="dark"]',
      )!;
      const start = frame.getBoundingClientRect().toJSON();
      input.click();
      const immediate = {
        checked: input.checked,
        theme: document.documentElement.dataset.theme,
      };
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const animations = frame.getAnimations({ subtree: true });
      if (!animations.length)
        throw new Error("Missing appearance frame motion");
      animations.forEach((animation) => animation.pause());
      const positions = [0, 0.25, 0.5, 0.95, 1].map((progress) => {
        animations.forEach((animation) => {
          animation.currentTime =
            Number(animation.effect!.getTiming().duration) * progress;
        });
        const textGap = Math.max(
          ...[...frame.querySelectorAll<HTMLElement>("[data-value]")].map(
            (copy) => {
              const original = document
                .querySelector<HTMLInputElement>(
                  `input[name="appearance"][value="${copy.dataset.value}"]`,
                )!
                .nextElementSibling!.getBoundingClientRect();
              const bounds = copy.getBoundingClientRect();
              return Math.max(
                Math.abs(bounds.left - original.left),
                Math.abs(bounds.top - original.top),
                Math.abs(bounds.width - original.width),
                Math.abs(bounds.height - original.height),
              );
            },
          ),
        );
        return { ...frame.getBoundingClientRect().toJSON(), textGap };
      });
      const luminance = (value: string) =>
        value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .reduce((sum, channel, index) => {
            channel /= 255;
            const linear =
              channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            return sum + linear * [0.2126, 0.7152, 0.0722][index];
          }, 0);
      const background = luminance(getComputedStyle(frame).backgroundColor);
      const foreground = luminance(
        getComputedStyle(frame.querySelector("[data-value]")!).color,
      );
      const contrast =
        (Math.max(background, foreground) + 0.05) /
        (Math.min(background, foreground) + 0.05);
      const target = input.nextElementSibling!.getBoundingClientRect().toJSON();
      animations.forEach((animation) => animation.finish());
      return { start, target, positions, immediate, contrast };
    });
    expect(motion.immediate).toEqual({ checked: true, theme: "dark" });
    expect(motion.contrast).toBeGreaterThanOrEqual(4.5);
    const start = motion.start[axis];
    const end = motion.target[axis];
    expect(end - start).toBeGreaterThan(20);
    expect(motion.positions[0][axis]).toBeCloseTo(start, 0);
    for (const [index, position] of motion.positions.entries()) {
      expect(position.textGap).toBeLessThanOrEqual(1);
      expect(position[axis]).toBeGreaterThanOrEqual(start - 1);
      expect(position[axis]).toBeLessThanOrEqual(end + 1);
      if (index > 0)
        expect(position[axis]).toBeGreaterThanOrEqual(
          motion.positions[index - 1][axis],
        );
    }
    expect(motion.positions[2][axis]).toBeGreaterThan(start + 1);
    expect(motion.positions[2][axis]).toBeLessThan(end - 0.1);
    await expectAligned(page);
    const dark = page.getByRole("radio", { name: "Dunkel", exact: true });
    await dark.focus();
    await dark.press("ArrowLeft");
    const light = page.getByRole("radio", { name: "Hell", exact: true });
    await expect(light).toBeChecked();
    await expect(light).toBeFocused();
    await expect(light.locator("..").locator("span")).toHaveCSS(
      "text-decoration-line",
      "underline",
    );
    await expectAligned(page);
    await expect(page.locator(`${indicator} [data-value="light"]`)).toHaveCSS(
      "text-decoration-line",
      "underline",
    );
    await expect(page.locator(indicator)).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(indicator)).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.getByRole("radio")).toHaveCount(3);
    await dark.check();
    await expect(dark.locator("..").locator("span")).toHaveCSS(
      "text-decoration-line",
      "none",
    );
  });
}

test("rapid appearance changes continue from the visible frame even when the palette stays the same", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  const changes = await page.evaluate(async () => {
    const frame = document.querySelector<HTMLElement>(".appearance-indicator")!;
    const results = [];
    for (const value of ["dark", "light", "system", "dark"]) {
      const previous = frame.getAnimations({ subtree: true });
      const before = frame.getBoundingClientRect().left;
      document
        .querySelector<HTMLInputElement>(
          `input[name="appearance"][value="${value}"]`,
        )!
        .click();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const current = frame.getAnimations({ subtree: true });
      if (!current.length) throw new Error("Missing replacement frame motion");
      current.forEach((animation) => {
        animation.pause();
        animation.currentTime = 0;
      });
      const after = frame.getBoundingClientRect().left;
      results.push({
        gap: Math.abs(after - before),
        cancelled: previous.every(
          (animation) => animation.playState === "idle",
        ),
        theme: document.documentElement.dataset.theme,
      });
      current.forEach((animation) => (animation.currentTime = 40));
    }
    frame
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.finish());
    return results;
  });
  for (const change of changes) {
    expect(change.gap).toBeLessThanOrEqual(1);
    expect(change.cancelled).toBe(true);
  }
  expect(changes.map((change) => change.theme)).toEqual([
    "dark",
    "light",
    "dark",
    "dark",
  ]);
  await expectAligned(page);
});

test("stored appearance, reopening and resizing place the frame without entry motion", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("foldroute.appearance", "dark"),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  for (let opening = 0; opening < 2; opening++) {
    const animations = await page.evaluate(async () => {
      document.getElementById("tab-settings")!.click();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return document
        .querySelector(".appearance-indicator")!
        .getAnimations({ subtree: true }).length;
    });
    expect(animations).toBe(0);
    await expectAligned(page);
    await page.locator("#tab-route").click();
  }
  await page.locator("#tab-settings").click();
  await page.getByRole("radio", { name: "Hell", exact: true }).check();
  await page.locator(indicator).evaluate((frame) => {
    frame
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.pause());
  });
  await page.setViewportSize({ width: 320, height: 852 });
  await page.addStyleTag({ content: "html { font-size: 32px; }" });
  await expectAligned(page);
  await expectMotionSettled(page.locator(indicator));
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectAligned(page);
  await expectMotionSettled(page.locator(indicator));
});

test("Reduced Motion positions the frame immediately and cancels an active glide", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await expectAligned(page);
  await expectMotionSettled(page.locator(indicator));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    )
    .toBe(false);
  // Let WebKit deliver the media-query change to existing listeners before input.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  const count = await page.evaluate(async () => {
    document
      .querySelector<HTMLInputElement>(
        'input[name="appearance"][value="light"]',
      )!
      .click();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const animations = document
      .querySelector(".appearance-indicator")!
      .getAnimations({ subtree: true });
    animations.forEach((animation) => {
      animation.pause();
      animation.currentTime = 40;
    });
    return animations.length;
  });
  expect(count).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectMotionSettled(page.locator(indicator));
  await expectAligned(page);
  expect(
    await page
      .locator(indicator)
      .evaluate((frame) =>
        [frame, frame.querySelector(".appearance-indicator-labels")!].map(
          (element) => (element as HTMLElement).style.translate,
        ),
      ),
  ).toEqual(["", ""]);
});

test("appearance frame follows external preference changes and works without Web Animations", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "animate", {
      value: undefined,
      configurable: true,
    });
  });
  await open(page);
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await expectAligned(page);
  const peer = await context.newPage();
  await peer.goto("/");
  await peer.evaluate(() =>
    localStorage.setItem("foldroute.appearance", "light"),
  );
  await expect(
    page.getByRole("radio", { name: "Hell", exact: true }),
  ).toBeChecked();
  await expectAligned(page);
  await peer.evaluate(() => localStorage.removeItem("foldroute.appearance"));
  await expect(
    page.getByRole("radio", { name: "System", exact: true }),
  ).toBeChecked();
  await expectAligned(page);
  await expectMotionSettled(page.locator(indicator));
  await peer.close();
});
