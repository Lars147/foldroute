import { test, expect, type Page } from "./test";
import { mountNavigationFixture } from "./navigation-layout-fixture";
import { a, now, route } from "./navigation-fixture";

async function position(
  page: Page,
  seconds: number,
  latitude = 48,
  accuracy = 10,
) {
  await page.clock.setFixedTime(new Date((now + seconds) * 1000));
  await page.evaluate(
    ({ latitude, accuracy }) => {
      (window as any).navigationFixture.session.updateLocation(
        {
          latitude,
          longitude: 11.002,
          accuracy,
          timestamp: Date.now(),
        },
        "current",
      );
    },
    { latitude, accuracy },
  );
}

for (const width of [390, 1280])
  for (const kind of ["bike", "walk"] as const)
    test(`remaining ${kind} values follow GPS and preserve details at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const journey = route(true);
      const leg = journey.legs[0];
      leg.kind = kind;
      leg.end = now + 180;
      if (kind === "walk") delete leg.maneuvers;
      await mountNavigationFixture(page, 0, { journey });
      const preview = page.locator("#navigation-section-preview-meta");
      const summary = page.locator(".navigation-section-summary");
      const toggle = page.locator("#navigation-details-toggle");
      const panel = page.locator("#navigation-section-detail");
      const current = page.getByRole("tab").first();
      if (width < 900) await expect(preview).toHaveText("Noch 3 min · 371 m");
      await position(page, 20);
      if (width < 900) {
        await expect(preview).toHaveText("Noch 2 min · 222 m");
        await expect(toggle).toHaveAccessibleDescription(/Noch 2 min · 222 m/);
        await toggle.click();
      }
      await expect(summary).toHaveText("Noch 2 min · 222 m");
      const original = await summary.elementHandle();
      await panel.focus();
      await position(page, 40, 48.0015);
      await expect(summary).toHaveText("Noch 1 min · 56 m");
      expect(
        await summary.evaluate((node, previous) => node === previous, original),
      ).toBe(true);
      await expect(panel).toBeFocused();
      await position(page, 60, 48.0015);
      await expect(summary).toHaveText("Noch 1 min · 56 m");
      await position(page, 80, 48.0018, 500);
      await expect(summary).toHaveText("Noch 1 min · 56 m");
      await page.clock.setFixedTime(new Date((now + 100) * 1000));
      await page.evaluate(() =>
        (window as any).navigationFixture.session.updateLocation(),
      );
      await expect(summary).toHaveText("Noch 1 min · 56 m");
      await page.getByRole("tab").nth(1).click();
      await expect(summary).toHaveCount(0);
      await current.click();
      await expect(summary).toHaveText("Noch 1 min · 56 m");
      if (width < 900) {
        await toggle.click();
        await expect(preview).toHaveText("Noch 1 min · 56 m");
      }
    });

for (const kind of ["bike", "walk"] as const)
  test(`point elevator retains planned ${kind} values as time passes`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const journey = route();
    journey.legs[0] = {
      ...journey.legs[0],
      kind,
      to: a,
      distance: 0,
      coordinates: [a],
      maneuvers: [
        {
          direction: "ELEVATOR",
          distance: 0,
          coordinates: [a],
          streetName: "",
        },
      ],
    };
    await mountNavigationFixture(page, 0, { journey });
    await expect(page.locator("#navigation-section-preview-meta")).toHaveText(
      "1 min · 0 m",
    );
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator(".navigation-section-summary")).toHaveText(
      "Geplant: 1 min · 0 m",
    );
    await position(page, 120, 48, 500);
    await expect(page.locator(".navigation-section-summary")).toHaveText(
      "Geplant: 1 min · 0 m",
    );
    await page.locator("#navigation-details-toggle").click();
    await expect(page.locator("#navigation-section-preview-meta")).toHaveText(
      "1 min · 0 m",
    );
  });

test("waiting grouped with a bike section retains planned movement values", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const journey = route();
  journey.legs.unshift({
    kind: "wait",
    from: a,
    to: a,
    start: now - 60,
    end: now,
    distance: 0,
    coordinates: [a],
  });
  await mountNavigationFixture(page, 0, { journey });
  await expect(page.locator("#navigation-section-preview-meta")).toHaveText(
    "1 min · 370 m",
  );
  await page.locator("#navigation-details-toggle").click();
  await expect(page.locator(".navigation-section-summary")).toHaveCount(0);
});
