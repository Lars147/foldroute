import { test, expect } from "./test";
import { setup as setupPlanner, plan } from "./planner-fixture";
import { setup as setupNavigation, savedProgress } from "./navigation-fixture";
import { addStop, showMap } from "./assertions";

for (const action of ["click", "type"] as const)
  test(`desktop startup focus keeps mobile form and tabs available until search is opened by ${action}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await setupPlanner(page);
    const input = page.locator("#destination");
    await expect(input).toBeFocused();
    for (const width of [899, 425, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator(".search-focus-back")).toBeHidden();
      await expect(page.locator("#search-adjust")).toBeVisible();
      await expect(page.locator("#tab-settings")).toBeVisible();
    }
    await expect(input).toBeFocused();
    if (action === "click") await input.click();
    else await page.keyboard.type("Ziel");
    const back = page.locator(".search-focus-back");
    await expect(back).toBeVisible();
    await back.click();
    await page.locator("#tab-settings").click();
    await page.locator("#tab-route").click();
  });

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  for (const id of ["destination", "origin", "via-0"]) {
    for (const initialWidth of [899, 900]) {
      test(`focused ${id} retains its search mode, DOM node and selection from ${initialWidth}px with motion ${reducedMotion}`, async ({
        page,
      }) => {
        await page.emulateMedia({ reducedMotion });
        await page.setViewportSize({ width: initialWidth, height: 844 });
        await setupPlanner(page);
        if (id !== "destination") await page.locator("#search-adjust").click();
        if (id === "via-0") await addStop(page);
        const input = page.locator(`#${id}`);
        await input.fill("Ziel");
        await input.evaluate((element: HTMLInputElement) =>
          element.setSelectionRange(1, 3),
        );
        const original = await input.elementHandle();
        const back = page.getByRole("button", {
          name: "‹ Zurück",
          exact: true,
        });
        for (const width of [900, 899, 900, 425]) {
          await page.setViewportSize({ width, height: 844 });
          if (width < 900) await expect(back).toBeVisible();
          else await expect(back).toBeHidden();
          await expect(input).toBeFocused();
          await expect(input).toHaveValue("Ziel");
          expect(
            await input.evaluate(
              (element, original) => element === original,
              original,
            ),
          ).toBe(true);
          expect(
            await input.evaluate((element: HTMLInputElement) => [
              element.selectionStart,
              element.selectionEnd,
            ]),
          ).toEqual([1, 3]);
        }
        await input.click();
        await back.click();
        await expect(back).toBeHidden();
        // A dismissed search must not reopen on a later resize.
        await page.setViewportSize({ width: 900, height: 844 });
        await page.setViewportSize({ width: 425, height: 844 });
        await expect(back).toBeHidden();
      });
    }
  }

  test(`desktop transition closes sheet without accepting its preview with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 899, height: 844 });
    await setupPlanner(page);
    await plan(page);
    await showMap(page);
    const selected = await page
      .locator('.route-choice[aria-pressed="true"]')
      .getAttribute("data-journey");
    const position = await page.evaluate(() => history.state.position);
    await page.locator("#result-back").click();
    await page.locator(".route-detail-link").last().click();
    await expect(page.locator("#alternatives-dialog")).toBeVisible();
    await page.setViewportSize({ width: 900, height: 844 });
    await expect(page.locator("#alternatives-dialog")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => history.state.position))
      .toBe(position);
    await expect(
      page.locator('.route-choice[aria-pressed="true"]'),
    ).toHaveAttribute("data-journey", selected!);
    await expect(
      page.locator('.route-choice[aria-pressed="true"]'),
    ).toBeFocused();
    await page.setViewportSize({ width: 899, height: 844 });
    await expect(page.locator("#alternatives-dialog")).toBeHidden();
  });

  test(`countdown keeps remaining time and trip identity across breakpoint with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 899, height: 844 });
    await setupNavigation(page, true);
    const tripId = () =>
      page.evaluate(async () => {
        const { NavigationStore } = await import("/src/navigation-store.ts");
        const saved = await new NavigationStore().read();
        return saved?.trip?.id ?? saved?.sessionId;
      });
    const beforeTrip = await tripId();
    expect(beforeTrip).toBeTruthy();
    const watches = await page.evaluate(() => window.navProbe.started);
    await page.clock.runFor(20000);
    await page.evaluate(() =>
      window.navProbe.push(48.002 - 9 / 111195, 11.002, 0),
    );
    const notice = page.locator("#navigation-auto-complete");
    const complete = page.locator("#navigation-complete");
    await expect(notice).toBeVisible();
    await page.locator("#navigation-instruction").focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(5000);
    const remaining = Number(await complete.getAttribute("data-countdown"));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(30);
    for (const width of [900, 899]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(complete).toHaveAttribute(
        "data-countdown",
        String(remaining),
      );
      expect(await tripId()).toBe(beforeTrip);
      expect(await page.evaluate(() => window.navProbe.started)).toBe(watches);
    }
    await page.clock.runFor((remaining + 1) * 1000);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    await expect(notice).toBeHidden();
    expect((await savedProgress(page))!.legIndex).toBe(1);
    await page.clock.runFor(5000);
    expect((await savedProgress(page))!.legIndex).toBe(1);
    expect(await tripId()).toBe(beforeTrip);
  });
  test(`focused navigation section retains selection and keyboard focus across breakpoint with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 899, height: 844 });
    await setupNavigation(page, true);
    const selected = page.getByRole("tab", { selected: true });
    const id = await selected.getAttribute("id");
    expect(id).toBeTruthy();
    await selected.focus();
    for (const width of [900, 899]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator(`#${id}`)).toBeFocused();
      await expect(page.locator(`#${id}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
    }
  });
}
