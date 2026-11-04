import { test, expect } from "./test";
import {
  setup,
  route,
  now,
  a,
  complete,
  savedProgress,
} from "./navigation-fixture";

for (const repeated of [false, true]) {
  test(`point elevator keeps visible and spoken guidance through GPS changes (repeated=${repeated})`, async ({
    page,
  }) => {
    const journey = route();
    const next = { ...journey.legs[0], kind: "walk" as const, start: now + 30 };
    journey.legs = [
      {
        ...next,
        to: a,
        end: now + 30,
        start: now,
        distance: 0,
        coordinates: repeated ? [a, a] : [a],
        maneuvers: [
          {
            direction: "ELEVATOR",
            streetName: "",
            distance: 0,
            coordinates: [a],
          },
        ],
      },
      next,
    ];
    await setup(page, false, false, {}, journey);
    let replans = 0;
    await page.route("**/api/v6/plan?*", (request) => {
      replans++;
      return request.abort();
    });
    await page.locator("#route-more").click();
    await page.locator("#navigation-start").click();
    const instruction = page.locator("#navigation-instruction");
    await expect(instruction).toHaveText("Aufzug nehmen");
    for (const accuracy of [10, 10, 10, 70, 500]) {
      await page.clock.runFor(3000);
      await page.evaluate(
        (accuracy) => window.navProbe.push(48, 11, 90, accuracy),
        accuracy,
      );
      await expect(instruction).toHaveText("Aufzug nehmen");
      await expect(page.locator("#navigation-arrow")).toHaveText("↕");
    }
    await expect(page.locator("#navigation-gps-status")).toHaveText(
      "GPS ungenau",
    );
    await page.evaluate(() => window.navProbe.fail(2));
    await expect(instruction).toHaveText("Aufzug nehmen");
    await expect(page.locator("#navigation-gps-status")).toHaveText("Kein GPS");
    await page.clock.runFor(70000);
    await expect(instruction).toHaveText("Aufzug nehmen");
    expect((await savedProgress(page))!.legIndex).toBe(0);
    await page.locator("#navigation-audio").click();
    await page.locator("#navigation-audio").click();
    expect(await page.evaluate(() => window.testSpeech.spoken.at(-1))).toBe(
      "Aufzug nehmen",
    );
    expect(replans).toBe(0);
    await page.evaluate(() => window.navProbe.push(48, 11));
    await complete(page);
    await expect(instruction).toHaveText("Links abbiegen auf Zweite Straße");
    expect((await savedProgress(page))!.legIndex).toBe(1);
    expect(replans).toBe(0);
  });
}
