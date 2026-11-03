import { expect, test } from "./test";
import { mountNavigationFixture } from "./navigation-layout-fixture";
import { route, completionButton } from "./navigation-fixture";

for (const width of [390, 1280]) {
  for (const kind of ["bike", "walk"] as const)
    test(`${kind} completion follows target proximity at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const journey = route(true);
      journey.legs[0].kind = kind;
      await mountNavigationFixture(page, 0, { journey });
      const quick = page.locator("#navigation-complete");
      const manual = page.locator("#navigation-complete-manually");
      await expect(quick).toBeHidden();
      await expect(manual).toBeHidden();
      if (width >= 900)
        await expect(page.locator("#navigation-more-actions")).toBeVisible();
      await quick.evaluate((button: HTMLButtonElement) => button.click());
      expect(
        await page.evaluate(
          () =>
            (window as any).navigationFixture.session.engine.progress.legIndex,
        ),
      ).toBe(0);
      await (await completionButton(page)).focus();
      await expect(manual).toBeFocused();
      await page.screenshot({
        path: test.info().outputPath("manual-completion.png"),
      });
      const move = async (metersFromTarget: number) => {
        await page.clock.setFixedTime(
          new Date((await page.evaluate(() => Date.now())) + 1000),
        );
        return page.evaluate((meters) => {
          const { session } = (window as any).navigationFixture;
          const target = session.engine.leg.to;
          session.updateLocation(
            {
              latitude: target.latitude - meters / 111195,
              longitude: target.longitude,
              accuracy: 10,
              timestamp: Date.now(),
            },
            "current",
          );
        }, metersFromTarget);
      };
      await move(80);
      await expect(quick).toBeVisible();
      await expect(quick).toBeFocused();
      await expect(manual).toBeHidden();
      await page.evaluate(() =>
        (window as any).navigationFixture.session.updateLocation(undefined),
      );
      await expect(quick).toBeVisible();
      await move(140);
      await expect(quick).toBeVisible();
      await move(160);
      await expect(quick).toBeHidden();
      await expect(
        page.locator(
          width < 900 ? "#navigation-instruction" : "#navigation-more-actions",
        ),
      ).toBeFocused();
      await move(80);
      await expect(quick).toBeVisible();
      if (width < 900) await page.locator("#navigation-details-toggle").click();
      await page.screenshot({
        path: test.info().outputPath("near-target-completion.png"),
      });
      await quick.click();
      await expect(page.locator("#navigation-instruction")).toHaveText(
        "Rad jetzt falten",
      );
      await expect(quick).toHaveText("Rad gefaltet");
    });

  test(`manual completion without GPS supports undo at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mountNavigationFixture(page, 0);
    await (await completionButton(page)).press("Enter");
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    await expect(page.locator("#navigation-confirm")).toBeHidden();
    await page.locator("#navigation-undo-button").click();
    await expect(page.locator("#navigation-instruction")).toContainText(
      "Links abbiegen",
    );
    await expect(page.locator("#navigation-complete")).toBeHidden();
    await expect(await completionButton(page)).toBeVisible();
    await page.getByRole("tab", { name: /^Falten nach/ }).click();
    await expect(page.locator("#navigation-complete-manually")).toBeHidden();
    await expect(page.locator("#navigation-complete")).toBeHidden();
  });
}

test("manual completion keeps keyboard focus when the layout changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mountNavigationFixture(page, 0);
  await (await completionButton(page)).focus();
  await page.setViewportSize({ width: 390, height: 844 });
  // Details are initially collapsed on mobile; explicitly open the manual action.
  await (await completionButton(page)).focus();
  await expect(page.locator("#navigation-complete-manually")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("#navigation-complete-manually")).toBeHidden();
  await expect(page.locator("#navigation-more-actions")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#navigation-complete-manually")).toBeVisible();
});

test("a rejected GPS jump cannot unlock completion after restoring near the target", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mountNavigationFixture(page, 0, { progress: { meters: 340 } });
  await page.evaluate(() =>
    (window as any).navigationFixture.setLocation("current"),
  );
  const quick = page.locator("#navigation-complete");
  await expect(quick).toBeHidden();
  const nearTarget = async (elapsed: number) => {
    await page.clock.setFixedTime(
      new Date((await page.evaluate(() => Date.now())) + elapsed),
    );
    await page.evaluate(() => {
      const { session } = (window as any).navigationFixture;
      const target = session.engine.leg.to;
      session.updateLocation(
        {
          latitude: target.latitude - 50 / 111195,
          longitude: target.longitude,
          accuracy: 10,
          timestamp: Date.now(),
        },
        "current",
      );
    });
  };
  await nearTarget(1000);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Standort wird geprüft",
  );
  await expect(quick).toBeHidden();
  await expect(await completionButton(page)).toBeVisible();
  await nearTarget(20000);
  await expect(quick).toBeVisible();
  await expect(page.locator("#navigation-complete-manually")).toBeHidden();
});
