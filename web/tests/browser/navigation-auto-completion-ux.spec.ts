import { test, expect, type Page } from "./test";
import { route, setup } from "./navigation-fixture";
import { mountNavigationFixture } from "./navigation-layout-fixture";

async function arriveNearTarget(page: Page) {
  await page.clock.runFor(20000);
  await page.evaluate(() =>
    window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
  );
}

for (const width of [390, 1280]) {
  test(`hover and focus pause both countdown bars and the actual section change at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true);
    await arriveNearTarget(page);
    const notice = page.locator("#navigation-auto-complete");
    const complete = page.locator("#navigation-complete");
    await notice.hover();
    await expect(notice).toContainText("pausiert");
    await expect(complete.locator(".countdown-bar")).toHaveAttribute(
      "data-paused",
      "",
    );
    const seconds = await complete.getAttribute("data-countdown");
    const scale = await complete
      .locator(".countdown-bar-fill")
      .evaluate((element) => getComputedStyle(element).transform);
    await page.clock.fastForward(40000);
    await page.evaluate(() =>
      window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
    );
    await expect(complete).toHaveAttribute("data-countdown", seconds!);
    await expect(complete.locator(".countdown-bar-fill")).toHaveCSS(
      "transform",
      scale,
    );
    await complete.focus();
    await page.mouse.move(0, 0);
    await page.clock.fastForward(40000);
    await page.evaluate(() =>
      window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
    );
    await expect(complete).toHaveAttribute("data-countdown", seconds!);
    await expect(notice).toContainText("pausiert");
    await page.locator("#navigation-instruction").focus();
    await expect(notice).not.toContainText("pausiert");
    await page.clock.fastForward(35000);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    await expect(notice).toBeHidden();
  });

  test(`touch hover does not leave a sticky countdown pause at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true);
    await arriveNearTarget(page);
    const notice = page.locator("#navigation-auto-complete");
    await notice.dispatchEvent("pointerenter", { pointerType: "touch" });
    await expect(notice).not.toContainText("pausiert");
    await page.clock.fastForward(31000);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
  });

  for (const [index, kind] of [
    [1, "fold"],
    [3, "unfold"],
    [5, "wait"],
  ] as const)
    test(`${kind} pauses its real remaining time under hover and focus at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const journey = route(true);
      journey.legs[index].kind = kind;
      const leg = journey.legs[index];
      await mountNavigationFixture(page, index, { journey, time: leg.start });
      const complete = page.locator("#navigation-complete");
      await complete.hover();
      await expect(complete.locator(".countdown-bar")).toHaveAttribute(
        "data-paused",
        "",
      );
      const remaining = Number(await complete.getAttribute("data-countdown"));
      const tick = async (elapsed: number) => {
        await page.clock.setFixedTime(new Date((leg.start + elapsed) * 1000));
        await page.evaluate(() => {
          const { session, view } = (window as any).navigationFixture;
          session.engine.tick();
          view.render();
        });
      };
      await tick(180);
      await expect(complete).toHaveAttribute(
        "data-countdown",
        String(remaining),
      );
      await complete.focus();
      await page.mouse.move(0, 0);
      await tick(240);
      await expect(complete).toHaveAttribute(
        "data-countdown",
        String(remaining),
      );
      await page.locator("#navigation-instruction").focus();
      await tick(250);
      await expect(complete).toHaveAttribute(
        "data-countdown",
        String(remaining - 10),
      );
      await expect(complete.locator(".countdown-bar")).not.toHaveAttribute(
        "data-paused",
        "",
      );
    });

  for (const kind of ["bike", "walk"] as const)
    test(`${kind} shows a cancellable countdown before the next section at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      const journey = route(true);
      journey.legs[0].kind = kind;
      await setup(page, true, true, {}, journey);
      await arriveNearTarget(page);
      const notice = page.locator("#navigation-auto-complete");
      await expect(notice).toContainText("Nächster Abschnitt in 30 s");
      await expect(notice).toBeInViewport();
      await expect(page.locator("#navigation-complete")).toBeVisible();
      await expect(page.locator("#navigation-complete")).toHaveAttribute(
        "data-countdown",
        "30",
      );
      const positions = await page.evaluate(() => ({
        notice: document
          .getElementById("navigation-auto-complete")!
          .getBoundingClientRect().bottom,
        panel: document
          .getElementById("navigation-panel")!
          .getBoundingClientRect().top,
      }));
      expect(positions.notice).toBeLessThan(positions.panel);
      await page.screenshot({
        path: info.outputPath("automatic-section-countdown.png"),
      });
      await page.clock.fastForward(25000);
      await expect(notice).toBeVisible();
      expect(
        Number(
          await page
            .locator("#navigation-complete")
            .getAttribute("data-countdown"),
        ),
      ).toBeLessThanOrEqual(5);
      await expect(page.locator("#navigation-instruction")).not.toHaveText(
        "Rad jetzt falten",
      );
      await page.clock.fastForward(6000);
      await expect(page.locator("#navigation-instruction")).toHaveText(
        "Rad jetzt falten",
      );
      await expect(notice).toBeHidden();
      await expect(page.locator("#navigation-undo")).toBeHidden();
    });

  test(`cancelling keeps manual completion and undo available at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true);
    await arriveNearTarget(page);
    await page.locator("#navigation-auto-cancel").focus();
    await page.locator("#navigation-auto-cancel").press("Enter");
    await expect(page.locator("#navigation-auto-complete")).toBeHidden();
    await expect(page.locator("#navigation-instruction")).toBeFocused();
    await page.clock.fastForward(35000);
    await page.evaluate(() =>
      window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
    );
    await expect(page.locator("#navigation-auto-complete")).toBeHidden();
    await page.locator("#navigation-complete").click();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    await page.locator("#navigation-undo-button").click();
    await expect(page.locator("#navigation-auto-complete")).toBeHidden();
    await page.clock.fastForward(1000);
    await page.evaluate(() =>
      window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
    );
    await expect(page.locator("#navigation-auto-complete")).toBeHidden();
    await expect(page.locator("#navigation-complete")).toBeVisible();
  });

  test(`GPS loss and backgrounding discard elapsed countdown time at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true);
    await arriveNearTarget(page);
    const notice = page.locator("#navigation-auto-complete");
    await page.clock.fastForward(20000);
    await page.evaluate(() => window.navProbe.fail(2));
    await expect(notice).toBeHidden();
    await page.clock.fastForward(35000);
    await page.evaluate(() =>
      window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
    );
    await expect(notice).toContainText("Nächster Abschnitt in 30 s");
    await page.evaluate(() => window.navProbe.hide(true));
    await expect(notice).toBeHidden();
    await page.clock.fastForward(35000);
    await page.evaluate(() => window.navProbe.hide(false));
    // Restarting the foreground watch supplies a new, valid GPS measurement.
    await expect(notice).toContainText("Nächster Abschnitt in 30 s");
    await expect(page.locator("#navigation-instruction")).not.toHaveText(
      "Rad jetzt falten",
    );
  });

  test(`the final section waits for the countdown before showing arrival at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await arriveNearTarget(page);
    await expect(page.locator("#navigation-auto-complete")).toContainText(
      "Ziel erreicht in 30 s",
    );
    await page.clock.fastForward(30000);
    await expect(page.locator("#navigation-finish-heading")).toHaveText(
      "Ziel erreicht",
    );
    await expect(page.locator("#navigation-finish")).toBeVisible();
    await expect(page.locator("#navigation-auto-complete")).toBeHidden();
  });
}
