import { test, expect, type Page } from "./test";
import { componentDocument } from "./component-document";
import { setup, plan } from "./planner-fixture";
import { showMap } from "./assertions";
import { waitForAppReady } from "./app-fixture";

async function expectUniqueIds(page: Page) {
  expect(
    await page.locator("[id]").evaluateAll((elements) => {
      const counts = new Map<string, number>();
      for (const element of elements)
        counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
      return [...counts].filter(([, count]) => count > 1);
    }),
  ).toEqual([]);
}

for (const mode of ["live", "example"] as const) {
  test(`${mode} root unmount releases its DOM and presentation before mounting again`, async ({
    page,
  }) => {
    await componentDocument(page, '<div id="root-fixture"></div>');
    const cycles = await page.evaluate(async (mode) => {
      const { mountRootCycles } = await import(
        "/tests/browser/root-lifecycle-fixture.ts"
      );
      return mountRootCycles(mode);
    }, mode);
    expect(cycles).toEqual([
      {
        mounted: { registered: true, main: 1, map: 1, sheet: 1 },
        disposals: 1,
        remaining: 0,
      },
      {
        mounted: { registered: true, main: 1, map: 1, sheet: 1 },
        disposals: 2,
        remaining: 0,
      },
    ]);
  });

  test(`${mode} root keeps one map instance while sheet content changes ownership at 899 and 900 px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 899, height: 844 });
    if (mode === "live") {
      await setup(page);
      await plan(page);
    } else {
      await page.route("https://api.transitous.org/**", (route) =>
        route.abort(),
      );
      await page.route("https://tiles.openfreemap.org/**", (route) =>
        route.abort(),
      );
      await page.goto("/?example=bike-transfer");
      await waitForAppReady(page);
    }
    await showMap(page);
    const map = page.locator("#map");
    const pane = map.locator(":scope > .leaflet-map-pane");
    await expect(pane).toHaveCount(1);
    const originalMap = await map.elementHandle();
    const originalPane = await pane.elementHandle();
    const sheet = page.locator("#alternatives-dialog");

    for (let cycle = 0; cycle < 2; cycle++) {
      await page.locator("#map-open-details").click();
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute("data-mode", "detail");
      await expect(sheet.locator("#panel-details")).toBeVisible();
      await expectUniqueIds(page);
      await page.setViewportSize({ width: 900, height: 844 });
      await expect(sheet).toBeHidden();
      await expect(page.locator("#panel-details")).toBeVisible();
      await expect(sheet.locator("#panel-details")).toHaveCount(0);
      await expectUniqueIds(page);
      await page.setViewportSize({ width: 899, height: 844 });
      await expect(sheet).toBeHidden();
      await expect(map).toBeVisible();
      await expectUniqueIds(page);
      expect(
        await map.evaluate(
          (element, original) => element === original,
          originalMap,
        ),
      ).toBe(true);
      expect(
        await pane.evaluate(
          (element, original) => element === original,
          originalPane,
        ),
      ).toBe(true);
    }
  });
}
