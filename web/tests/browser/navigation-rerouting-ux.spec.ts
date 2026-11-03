import { test, expect } from "./test";
import { setup } from "./navigation-fixture";

for (const multimodal of [false, true]) {
  test(`deviation replaces street guidance and preserves transit=${multimodal}`, async ({
    page,
  }) => {
    await setup(page, multimodal);
    await page.evaluate(async () => {
      const { ApiClient } = await import("/src/transitous.ts");
      (window as any).streetRequests = [];
      ApiClient.prototype.batch = async function (
        request: any,
        _settings: any,
        variant: any,
      ) {
        (window as any).streetRequests.push(variant);
        await new Promise<void>((resolve) => {
          (window as any).releaseStreet = resolve;
        });
        return {
          journeys: [
            {
              id: "repaired",
              origin: request.origin,
              destination: request.destination,
              departure: request.time,
              arrival: request.time + 120,
              transfers: 0,
              isDirect: true,
              legs: [
                {
                  kind: "bike",
                  from: request.origin,
                  to: request.destination,
                  start: request.time,
                  end: request.time + 120,
                  distance: 200,
                  coordinates: [request.origin, request.destination],
                },
              ],
            },
          ],
          issues: [],
          stop: false,
          rejected: false,
        };
      };
    });
    for (const seconds of [1, 3, 6]) {
      await page.clock.runFor(
        seconds === 1 ? 1000 : seconds === 3 ? 2000 : 3000,
      );
      await page.evaluate(
        (seconds) =>
          (window as any).navProbe.push(48.0004, 11 + seconds * 0.0001),
        seconds,
      );
    }
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Route wird angepasst …",
    );
    await expect(page.locator("#navigation-distance")).toBeEmpty();
    await expect(page.locator("#navigation-map")).toHaveAttribute(
      "data-position-matched",
      "false",
    );
    expect(await page.evaluate(() => (window as any).streetRequests)).toEqual([
      { direct: true, directMode: "BIKE", pre: "BIKE", post: "BIKE" },
    ]);
    await page.evaluate(() => (window as any).releaseStreet());
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Nach Bahnhof",
    );
    await expect(page.locator("#navigation-distance")).not.toBeEmpty();
    await expect(page.locator("#navigation-alternative")).toBeHidden();
    expect(
      await page.evaluate(() => (window as any).streetRequests.length),
    ).toBe(1);
  });
}
