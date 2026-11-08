import { test, expect, type Page } from "./test";
import { expectMotionSettled } from "./assertions";
import { mountNavigationFixture } from "./navigation-layout-fixture";
import { route, setup, savedProgress } from "./navigation-fixture";
import type { Coordinate } from "../../src/model";

async function expectVisibleGeometry(page: Page, points: Coordinate[]) {
  await expectMotionSettled(page.locator("#navigation-panel"));
  await expect
    .poll(async () =>
      page.evaluate((points) => {
        const map = document.getElementById("navigation-map")!;
        if (!map.dataset.center || !map.dataset.zoom) return false;
        const center = JSON.parse(map.dataset.center) as number[];
        const resolution = 156543.03392804097 / 2 ** Number(map.dataset.zoom);
        const bounds = map.getBoundingClientRect();
        const top = document
          .getElementById("navigation-top")!
          .getBoundingClientRect().bottom;
        const bottom = document
          .getElementById("navigation-panel")!
          .getBoundingClientRect().top;
        const overlays = [
          ...document.querySelectorAll<HTMLElement>(
            ".navigation-map-controls, #navigation-gps-status, #navigation-undo, #navigation-auto-complete",
          ),
        ]
          .filter((element) => !element.hidden)
          .map((element) => element.getBoundingClientRect());
        return points.every((point) => {
          const x = (point.longitude * 20037508.342789244) / 180;
          const y =
            Math.log(Math.tan(Math.PI / 4 + (point.latitude * Math.PI) / 360)) *
            6378137;
          const pixel = {
            x: bounds.left + bounds.width / 2 + (x - center[0]) / resolution,
            y: bounds.top + bounds.height / 2 - (y - center[1]) / resolution,
          };
          return (
            pixel.x >= bounds.left + 10 &&
            pixel.x <= bounds.right - 10 &&
            pixel.y > top &&
            pixel.y < bottom &&
            overlays.every(
              (rect) =>
                !rect.width ||
                !rect.height ||
                pixel.x < rect.left ||
                pixel.x > rect.right ||
                pixel.y < rect.top ||
                pixel.y > rect.bottom,
            )
          );
        });
      }, points),
    )
    .toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`section preview frames geometry and restores live navigation at ${width} (${theme})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      const journey = route(true);
      await setup(page, true, true, {}, journey);
      const tabs = page.getByRole("tab");
      const map = page.locator("#navigation-map");
      const center = page.locator("#navigation-center");
      const activeIcon = await center.locator("svg").innerHTML();
      const neutral = await page
        .locator("#navigation-audio")
        .evaluate((button) => {
          const style = getComputedStyle(button);
          return { background: style.backgroundColor, color: style.color };
        });
      const brand = await tabs
        .nth(0)
        .locator(".navigation-phase-symbol")
        .evaluate((symbol) => {
          const style = getComputedStyle(symbol);
          return { background: style.backgroundColor, color: style.color };
        });
      const expectButton = async (following: boolean) => {
        const colors = following ? neutral : brand;
        const label = following
          ? "Navigation zentrieren"
          : "Zurück zum Standort";
        await expect(center).toHaveAttribute(
          "data-following",
          String(following),
        );
        await expect(center).not.toHaveAttribute("aria-pressed");
        await expect(center).toHaveAccessibleName(label);
        await expect(center).toHaveAttribute("title", label);
        await expect(center).toHaveCSS("background-color", colors.background);
        await expect(center).toHaveCSS("color", colors.color);
      };
      await expectButton(true);
      const progress = await savedProgress(page);
      for (const index of [1, 2, 3, 4, 6]) {
        await tabs.nth(index).click();
        await expect(map).toHaveAttribute("data-following", "false");
        await expectButton(false);
        await expectVisibleGeometry(page, journey.legs[index].coordinates);
      }
      expect(await center.locator("svg").innerHTML()).not.toBe(activeIcon);
      expect(await savedProgress(page)).toEqual(progress);
      await page.evaluate(() => window.navProbe.push(48, 11.0001));
      await expect(tabs.nth(6)).toHaveAttribute("aria-selected", "true");
      await expectVisibleGeometry(page, journey.legs[6].coordinates);
      await center.click();
      await expect(map).toHaveAttribute("data-following", "true");
      await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
      await expectButton(true);
      expect(await center.locator("svg").innerHTML()).toBe(activeIcon);
      await tabs.nth(3).click();
      await tabs.nth(0).click();
      await expect(map).toHaveAttribute("data-following", "true");
      await map.press("ArrowRight");
      await expectButton(false);
      await tabs.nth(0).click();
      await expectButton(true);
      await tabs.nth(0).focus();
      await page.keyboard.press("End");
      await expectVisibleGeometry(page, journey.legs[6].coordinates);
      if (width < 900) await page.locator("#navigation-details-toggle").click();
      await expectVisibleGeometry(page, journey.legs[6].coordinates);
      await page.setViewportSize({ width, height: 740 });
      await expectVisibleGeometry(page, journey.legs[6].coordinates);
    });
  }
}

test("preview stays pinned across progress and uses updated geometry without GPS", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = route(true);
  journey.legs.forEach((leg, index) => {
    leg.navigationId = `camera-${index}`;
  });
  await mountNavigationFixture(page, 0, { journey });
  const tabs = page.getByRole("tab");
  const map = page.locator("#navigation-map");
  await tabs.nth(1).click();
  for (const index of [1, 2]) {
    await page.evaluate(
      (index) => (window as any).navigationFixture.showLeg(index),
      index,
    );
    await expect(tabs.nth(index)).toHaveAttribute("aria-current", "step");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(map).toHaveAttribute("data-following", "false");
    await expectVisibleGeometry(page, journey.legs[1].coordinates);
  }
  // A previous section uses current journey geometry even when its ID is retained.
  const nextPoint = { latitude: 48.02, longitude: 11.03 };
  await page.evaluate((point) => {
    const { session, view } = (window as any).navigationFixture;
    const next = structuredClone(session.engine.journey);
    next.legs[1].from = next.legs[1].to = point;
    next.legs[1].coordinates = [point];
    session.engine.applyJourney(next);
    view.render();
  }, nextPoint);
  await expectVisibleGeometry(page, [nextPoint]);
  const previewCenter = await map.getAttribute("data-center");
  await page.locator("#navigation-center").click();
  await expect(map).not.toHaveAttribute("data-center", previewCenter!);
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(map).toHaveAttribute("data-following", "true");
});

test("current tab follows location during an attached wait leg", async ({
  page,
}) => {
  const journey = route(true);
  const wait = {
    ...structuredClone(journey.legs[1]),
    kind: "wait" as const,
    start: journey.legs[1].end,
    end: journey.legs[2].start,
  };
  journey.legs.splice(2, 0, wait);
  await mountNavigationFixture(page, 2, { journey });
  const current = page.getByRole("tab", { name: /^S1 nach/ });
  await expect(current).toHaveAttribute("aria-current", "step");
  await page.getByRole("tab").last().click();
  await current.click();
  await expect(page.locator("#navigation-map")).toHaveAttribute(
    "data-following",
    "true",
  );
});

test("transit preview includes destination when line geometry has only one point", async ({
  page,
}) => {
  const journey = route(true);
  journey.legs[2].to = {
    ...journey.legs[2].to,
    latitude: 48.15,
    longitude: 11.2,
  };
  journey.legs[2].coordinates = [journey.legs[2].from];
  await mountNavigationFixture(page, 0, { journey });
  await page.getByRole("tab", { name: /^S1 nach/ }).click();
  await expectVisibleGeometry(page, [journey.legs[2].from, journey.legs[2].to]);
});
