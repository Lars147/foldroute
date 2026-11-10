import { test, expect } from "./test";
import {
  now,
  c,
  d,
  setup,
  stationJourney,
  savedProgress,
} from "./navigation-fixture";

for (const speed of [4, null, 1.1])
  test(`boarding recovery requires transit movement (speed=${speed})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const journey = stationJourney();
    const train = journey.legs[2];
    train.coordinates = [
      c,
      { ...c, latitude: 48.012 },
      { ...d, latitude: 48.012 },
      d,
    ];
    train.transitStops = train.coordinates.map((point, i) => ({
      ...point,
      name: `Halt ${i}`,
      detail: "",
      scheduledArrival: now + 300 + i * 100,
    }));
    await setup(page, true, true, {}, journey);
    await page.evaluate(() => {
      window.navProbe.silent = true;
      window.navProbe.hide(true);
    });
    await page.clock.fastForward(370000);
    await page.evaluate(() => window.navProbe.hide(false));
    await page.evaluate(
      (speed) => window.navProbe.push(48.008, 11.002, 0, 10, 0, speed),
      speed,
    );
    expect((await savedProgress(page))?.legIndex).toBe(0);
    if (speed === 1.1) {
      await page.clock.runFor(19000);
      await page.evaluate(() =>
        window.navProbe.push(48.008 + 20.9 / 111195, 11.002, 0, 10, 0, 1.1),
      );
      expect((await savedProgress(page))?.legIndex).toBe(0);
      await expect(page.locator("#navigation-instruction")).not.toContainText(
        "S1 Richtung",
      );
      return;
    }
    // Keep a previously opened modal over navigation while GPS recovers.
    await page.evaluate(() =>
      (
        document.getElementById("navigation-alternative") as HTMLDialogElement
      ).showModal(),
    );
    await expect(page.locator("#navigation-alternative")).toBeVisible();
    await page.clock.runFor(5000);
    await page.evaluate(
      (speed) => window.navProbe.push(48.0086, 11.002, 0, 10, 0, speed),
      speed,
    );
    await expect
      .poll(async () => (await savedProgress(page))?.legIndex)
      .toBe(2);
    await expect(page.locator("#navigation-instruction")).toContainText("S1");
    await expect(
      page
        .getByRole("article", { name: "Navigationshinweise" })
        .getByText("Fahrt mit S1 erkannt", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#navigation-disruption")).not.toContainText(
      "liegt zurück",
    );
    await expect(page.locator("#navigation-confirm")).toBeHidden();
    await expect(page.locator("#navigation-alternative")).toBeHidden();
  });
