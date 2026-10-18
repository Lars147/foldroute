import { test, expect, type Page } from "@playwright/test";
import { openSettingsSection } from "./assertions";

test.use({ serviceWorkers: "block" });

async function aligned(page: Page) {
  await expect
    .poll(() =>
      page.locator(".app-tabs").evaluate((tabs) => {
        const frame = tabs
          .querySelector(".tab-indicator")!
          .getBoundingClientRect();
        const button = tabs
          .querySelector("button[aria-current]")!
          .getBoundingClientRect();
        return Math.max(
          Math.abs(frame.left - button.left - 4),
          Math.abs(frame.top - button.top - 4),
          Math.abs(frame.width - button.width + 8),
          Math.abs(frame.height - button.height + 8),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}

async function settled(page: Page) {
  await expect
    .poll(() =>
      page
        .locator(".tab-indicator")
        .evaluate((frame) => frame.getAnimations({ subtree: true }).length),
    )
    .toBe(0);
  await aligned(page);
}

async function open(page: Page) {
  await page.goto("/");
  await expect(page.locator(".app-tabs")).toHaveAttribute(
    "data-motion",
    "ready",
  );
  // Finish initial ResizeObserver delivery before sampling a user-triggered glide.
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await settled(page);
}

for (const width of [390, 1280])
  for (const colorScheme of ["light", "dark"] as const)
    test(`main selection glides behind fixed icons and labels at ${width} in ${colorScheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
      await open(page);
      const motion = await page.evaluate(async () => {
        const frame = document.querySelector<HTMLElement>(".tab-indicator")!;
        const button = document.getElementById("tab-settings")!;
        const start = frame.getBoundingClientRect().toJSON();
        const originals = [
          ...document.querySelectorAll<HTMLElement>(
            ".app-tabs button .app-tab-content",
          ),
        ];
        const originalBounds = originals.map((node) =>
          node.getBoundingClientRect().toJSON(),
        );
        button.click();
        const immediate = {
          current: button.getAttribute("aria-current"),
          settings: !document.getElementById("settings-view")!.hidden,
        };
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const animations = frame.getAnimations({ subtree: true });
        if (!animations.length)
          throw new Error("Missing main tab selection motion");
        animations.forEach((animation) => animation.pause());
        const positions = [0, 0.25, 0.5, 0.95, 1].map((progress) => {
          animations.forEach((animation) => {
            animation.currentTime =
              Number(animation.effect!.getTiming().duration) * progress;
          });
          const copyGap = Math.max(
            ...[...frame.querySelectorAll<HTMLElement>("[data-tab]")].flatMap(
              (copy) => {
                const original = document.querySelector(
                  `#${copy.dataset.tab} .app-tab-content`,
                )!;
                return [".icon", ".app-tab-label"].flatMap((selector) => {
                  const a = original
                    .querySelector(selector)!
                    .getBoundingClientRect();
                  const b = copy
                    .querySelector(selector)!
                    .getBoundingClientRect();
                  return [
                    Math.abs(a.left - b.left),
                    Math.abs(a.top - b.top),
                    Math.abs(a.width - b.width),
                    Math.abs(a.height - b.height),
                  ];
                });
              },
            ),
          );
          const originalGap = Math.max(
            ...originals.flatMap((node, index) => {
              const bounds = node.getBoundingClientRect();
              const before = originalBounds[index];
              return [
                Math.abs(bounds.left - before.left),
                Math.abs(bounds.top - before.top),
                Math.abs(bounds.width - before.width),
                Math.abs(bounds.height - before.height),
              ];
            }),
          );
          return {
            ...frame.getBoundingClientRect().toJSON(),
            copyGap,
            originalGap,
          };
        });
        const luminance = (value: string) =>
          value
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .reduce((sum, value, index) => {
              value /= 255;
              return (
                sum +
                (value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][index]
              );
            }, 0);
        const bg = luminance(getComputedStyle(frame).backgroundColor);
        const fg = luminance(
          getComputedStyle(frame.querySelector(".app-tab-label")!).color,
        );
        const contrast = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
        const target = button.getBoundingClientRect().toJSON();
        animations.forEach((animation) => animation.finish());
        return { start, target, positions, immediate, contrast };
      });
      expect(motion.immediate).toEqual({ current: "page", settings: true });
      expect(motion.contrast).toBeGreaterThanOrEqual(4.5);
      expect(motion.positions[0].left).toBeCloseTo(motion.start.left, 0);
      for (const [index, position] of motion.positions.entries()) {
        expect(position.copyGap).toBeLessThanOrEqual(1);
        expect(position.originalGap).toBeLessThanOrEqual(1);
        expect(position.left).toBeGreaterThanOrEqual(motion.start.left - 1);
        expect(position.left).toBeLessThanOrEqual(motion.target.left + 5);
        if (index > 0)
          expect(position.left).toBeGreaterThanOrEqual(
            motion.positions[index - 1].left,
          );
      }
      expect(motion.positions[2].left).toBeGreaterThan(motion.start.left + 1);
      expect(motion.positions[2].left).toBeLessThan(motion.target.left + 3);
      if (width >= 900) {
        const endWidth = motion.target.width - 8;
        expect(endWidth).toBeGreaterThan(motion.start.width + 1);
        expect(motion.positions[2].width).toBeGreaterThan(motion.start.width);
        expect(motion.positions[2].width).toBeLessThan(endWidth);
      }
      await settled(page);
      await expect(page.locator(".app-tabs").getByRole("button")).toHaveText([
        "Route",
        "Verlauf",
        "Einstellungen",
      ]);
      await expect(page.locator(".tab-indicator")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      await expect(page.locator(".tab-indicator")).toHaveCSS(
        "pointer-events",
        "none",
      );
      await page.screenshot({
        path: test.info().outputPath(`main-tabs-${colorScheme}-${width}.png`),
      });
    });

test("main tabs preserve keyboard focus and only animate successful navigation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await page.locator("#tab-settings").focus();
  await page.keyboard.press("Enter");
  await settled(page);
  await expect(page.locator("#tab-settings")).toBeFocused();
  await openSettingsSection(page, "options");
  await page.locator("#maxWalkingMinutes").fill("1000");
  await page.locator("#tab-route").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-settings")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("#maxWalkingMinutes")).toBeFocused();
  await settled(page);
  await page.locator("#maxWalkingMinutes").fill("3");
  await page.locator("#tab-route").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#tab-route")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("#tab-route")).toBeFocused();
  await settled(page);
});

test("main tabs resize with large text and safe area, then restore without a glide", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await page.locator("#tab-settings").click();
  await settled(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addStyleTag({
    content:
      ":root { font-size: 32px; --tabs: calc(max(64px, 4rem) + 34px); } .app-tabs { padding-bottom: 34px; }",
  });
  await settled(page);
  const geometry = await page.locator(".app-tabs").evaluate((tabs) => {
    const frame = tabs.querySelector(".tab-indicator")!.getBoundingClientRect();
    return {
      height: tabs.getBoundingClientRect().height,
      bottom: tabs.getBoundingClientRect().bottom - frame.bottom,
      fits: [...tabs.querySelectorAll("button .app-tab-content")].every(
        (content) => {
          const box = content.getBoundingClientRect();
          const target = content.closest("button")!.getBoundingClientRect();
          return (
            box.left >= target.left + 4 &&
            box.right <= target.right - 4 &&
            box.top >= target.top + 4 &&
            box.bottom <= target.bottom - 4
          );
        },
      ),
    };
  });
  expect(geometry.height).toBeGreaterThanOrEqual(162);
  expect(geometry.bottom).toBeCloseTo(38, 0);
  expect(geometry.fits).toBe(true);
  await page
    .locator(".app-tabs")
    .evaluate((tabs: HTMLElement) => (tabs.hidden = true));
  await expect(page.locator(".app-tabs")).not.toHaveAttribute(
    "data-motion",
    "ready",
  );
  await page.evaluate(() => document.getElementById("tab-history")!.click());
  await page
    .locator(".app-tabs")
    .evaluate((tabs: HTMLElement) => (tabs.hidden = false));
  await expect(page.locator(".app-tabs")).toHaveAttribute(
    "data-motion",
    "ready",
  );
  await settled(page);
});

for (const unsupported of [false, true])
  test(`main tabs work without motion and clean up an interrupted glide (unsupported: ${unsupported})`, async ({
    page,
  }) => {
    if (unsupported)
      await page.addInitScript(() =>
        Object.defineProperty(Element.prototype, "animate", {
          value: undefined,
          configurable: true,
        }),
      );
    await page.emulateMedia({
      reducedMotion: unsupported ? "no-preference" : "reduce",
    });
    await open(page);
    await page.locator("#tab-history").click();
    await settled(page);
    if (!unsupported) {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        document.getElementById("tab-settings")!.click();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const animations = document
          .querySelector(".tab-indicator")!
          .getAnimations({ subtree: true });
        if (!animations.length)
          throw new Error("Missing interruptible tab glide");
        animations.forEach((animation) => {
          animation.pause();
          animation.currentTime = 40;
        });
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await settled(page);
      expect(
        await page
          .locator(".tab-indicator")
          .evaluate((frame) =>
            [frame, frame.firstElementChild!].map(
              (node) => (node as HTMLElement).style.translate,
            ),
          ),
      ).toEqual(["", ""]);
    }
  });
