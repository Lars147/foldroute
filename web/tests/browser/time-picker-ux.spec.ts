import { test, expect, type Page } from "./test";
import { expectMotionSettled } from "./assertions";

async function setVisualViewport(
  page: Page,
  height: number,
  offsetTop = 0,
  event = "resize",
) {
  await page.evaluate(
    ({ height, offsetTop, event }) => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
      });
      window.visualViewport!.dispatchEvent(new Event(event));
    },
    { height, offsetTop, event },
  );
}

async function expectClockAboveKeyboard(page: Page) {
  // Read geometry before any action that could scroll the input into view.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.getElementById("time-dialog")!;
        const body = dialog.querySelector(".time-editor-body")!;
        const bounds = body.getBoundingClientRect();
        const field = document.getElementById("time-clock") as HTMLInputElement;
        const clock = field.getBoundingClientRect();
        const label = field.labels![0].getBoundingClientRect();
        const apply = document
          .getElementById("time-apply")!
          .getBoundingClientRect();
        const modal = dialog.getBoundingClientRect();
        const viewport = window.visualViewport;
        const top = viewport?.offsetTop ?? 0;
        const bottom = top + (viewport?.height ?? innerHeight);
        return {
          inputVisible:
            clock.top >= Math.max(bounds.top, top) + 7 &&
            clock.bottom <= Math.min(bounds.bottom, bottom) - 7,
          labelVisible: label.top >= bounds.top + 7,
          applyVisible: apply.top >= top && apply.bottom <= bottom,
          dialogFits: modal.top >= top && modal.bottom <= bottom + 1,
          onlyBodyScrolls: dialog.scrollTop === 0,
          noHorizontalOverflow: body.scrollWidth <= body.clientWidth + 1,
        };
      }),
    )
    .toEqual({
      inputVisible: true,
      labelVisible: true,
      applyVisible: true,
      dialogFits: true,
      onlyBodyScrolls: true,
      noHorizontalOverflow: true,
    });
}

for (const width of [320, 390])
  test(`focused time follows keyboard opening, panning and closing at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
    await page.goto("/");
    await page.locator("#search-adjust").click();
    await page.locator("#time-trigger").click();
    const clock = page.locator("#time-clock");
    await clock.focus();
    const background = await page.evaluate(() => ({
      window: window.scrollY,
      search: document.querySelector(".search-content")!.scrollTop,
    }));

    // A software keyboard changes only the visual viewport on iOS.
    await setVisualViewport(page, 365, 40);
    await expectClockAboveKeyboard(page);
    expect(await page.evaluate(() => innerHeight)).toBe(844);
    await expect(clock).toBeFocused();
    await expect(clock).toHaveValue("14:00");

    // Panning and further keyboard resize must not hide the focused field.
    await setVisualViewport(page, 300, 65, "scroll");
    await expectClockAboveKeyboard(page);
    await clock.fill("");
    await expect(page.locator("#time-apply")).toBeDisabled();
    await expectClockAboveKeyboard(page);
    await clock.fill("18:30");
    await expect(page.locator("#time-apply")).toBeEnabled();

    await setVisualViewport(page, 844);
    await expectClockAboveKeyboard(page);
    await setVisualViewport(page, 365, 40);
    await expectClockAboveKeyboard(page);
    expect(
      await page.evaluate(() => ({
        window: window.scrollY,
        search: document.querySelector(".search-content")!.scrollTop,
      })),
    ).toEqual(background);
    await page.screenshot({ path: info.outputPath("keyboard-time.png") });
    await page.locator("#time-apply").click();
    await expect(page.locator("#when")).toHaveValue("2026-09-22T18:30");
    await expect(page.locator("#time-trigger")).toBeFocused();

    // Focus must also reveal the input when the keyboard is already open.
    await page.locator("#time-trigger").click();
    await clock.evaluate((field: HTMLInputElement) =>
      field.focus({ preventScroll: true }),
    );
    await expectClockAboveKeyboard(page);
    await clock.fill("19:45");
    await page.locator("#time-cancel").click();
    await expect(page.locator("#when")).toHaveValue("2026-09-22T18:30");
    await expect(page.locator("#time-trigger")).toBeFocused();
    await setVisualViewport(page, 844);
    await expect(page.locator("#time-dialog")).not.toHaveAttribute("open");
  });

for (const locale of ["de-DE", "en-US"])
  test.describe(`native time input in ${locale}`, () => {
    test.use({ locale });
    for (const width of [320, 390, 1100])
      test(`time and actions fit at ${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({
          colorScheme: locale === "de-DE" ? "light" : "dark",
        });
        await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
        await page.goto("/");
        await page.locator("#search-adjust").click();
        await page.locator("#time-trigger").click();
        const clock = page.locator("#time-clock");
        await expect(clock).toHaveAttribute("type", "time");
        await expect(clock).toHaveAttribute("step", "60");
        await expect(clock).toHaveAttribute("required", "");
        await expect(clock).not.toBeFocused();
        await clock.fill("18:31");
        await expect(clock).toBeFocused();
        await expect(clock).toHaveValue("18:31");
        await expectClockAboveKeyboard(page);
        expect(
          await clock.evaluate((field) =>
            ["time-minus", "time-plus", "time-now"].every((id) => {
              const button = document.getElementById(id)!;
              const input = field.getBoundingClientRect();
              const bounds = button.getBoundingClientRect();
              const body = button.closest(".time-editor-body")!;
              return (
                bounds.width >= 44 &&
                bounds.height >= 44 &&
                bounds.left >= body.getBoundingClientRect().left &&
                bounds.right <= body.getBoundingClientRect().right &&
                (bounds.right <= input.left ||
                  bounds.left >= input.right ||
                  bounds.top >= input.bottom)
              );
            }),
          ),
        ).toBe(true);
        await page.screenshot({ path: info.outputPath("native-time.png") });
        await page.locator("#time-apply").click();
        await expect(page.locator("#when")).toHaveValue("2026-09-22T18:31");
      });
  });

for (const event of ["change", "blur"])
  test(`native time ${event} validates the draft before applying`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
    await page.goto("/");
    await page.locator("#search-adjust").click();
    await page.locator("#time-trigger").click();
    const clock = page.locator("#time-clock");
    const saved = await page.locator("#when").inputValue();
    for (const value of ["", "18:31"]) {
      await clock.focus();
      // Model picker commits without a preceding text-input event.
      await clock.evaluate(
        (field: HTMLInputElement, { value, event }) => {
          field.value = value;
          if (event === "blur") field.blur();
          else field.dispatchEvent(new Event(event, { bubbles: true }));
        },
        { value, event },
      );
      await expect(clock).toHaveAttribute("aria-invalid", String(!value));
      for (const id of ["time-apply", "time-minus", "time-plus"])
        await expect(page.locator(`#${id}`)).toBeEnabled({ enabled: !!value });
      await expect(page.locator("#when")).toHaveValue(saved);
    }
    await page.locator("#time-apply").click();
    await expect(page.locator("#when")).toHaveValue("2026-09-22T18:31");
  });

test("window resize keeps time and actions visible with safe areas and no VisualViewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 844 });
  await page.addInitScript(() =>
    Object.defineProperty(window, "visualViewport", { value: undefined }),
  );
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "24px");
    document.documentElement.style.setProperty("--safe-bottom", "16px");
  });
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").fill("18:30");
  await page.setViewportSize({ width: 1100, height: 340 });
  await expectClockAboveKeyboard(page);
  await expect(page.locator("#time-clock")).toBeFocused();
  await expect(page.locator("#time-clock")).toHaveValue("18:30");
  // Sample safe-area bounds after the dialog's entrance translation finishes.
  await expectMotionSettled(page.locator("#time-dialog"));
  const dialog = await page.locator("#time-dialog").boundingBox();
  expect(dialog!.y).toBeGreaterThanOrEqual(24);
  expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(340 - 16);
  await page.locator("#time-apply").click();
  await expect(page.locator("#time-summary")).toContainText("18:30");
});

for (const width of [390, 1100])
  test(`calendar edits are isolated and keyboard accessible at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
    await page.goto("/");
    await page.locator("#search-adjust").click();
    await page.locator("#time-trigger").click();
    await expect(page.locator("#time-editor")).toBeVisible();
    await expect(page.locator("#time-dialog")).toHaveAttribute("open", "");
    await expect(page.locator("#time-clock")).toHaveValue("14:00");
    await expect(page.locator('[data-date="2026-09-21"]')).toBeEnabled();
    await page.locator('[data-date="2026-09-22"]').press("ArrowLeft");
    await expect(page.locator('[data-date="2026-09-21"]')).toBeFocused();
    await page.locator('[data-date="2026-09-21"]').press("ArrowRight");
    await page.locator('[data-date="2026-09-22"]').press("ArrowRight");
    await expect(page.locator('[data-date="2026-09-23"]')).toBeFocused();
    await page.locator('[data-date="2026-09-23"]').press("Enter");
    await page.locator("#time-arrive").click();
    await page.locator("#time-clock").fill("18:30");
    await page.locator("#time-apply").click();
    await expect(page.locator("#time-summary")).toHaveText("Morgen, an 18:30");
    await expect(page.locator("#time-trigger")).toBeFocused();
    await page.locator("#time-trigger").click();
    await page.locator("#time-next").click();
    await expect(page.locator("#time-month")).toHaveText("Oktober 2026");
    await page.locator("#time-now").click();
    await expect(page.locator("#time-month")).toHaveText("September 2026");
    await expect(page.locator("#time-arrive")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.locator("#time-cancel").press("Escape");
    await expect(page.locator("#route-editor")).toBeVisible();
    await expect(page.locator("#time-summary")).toHaveText("Morgen, an 18:30");
    await page.locator("#time-trigger").click();
    await page.locator("#time-now").click();
    await page.screenshot({ path: info.outputPath("calendar.png") });
    await page.locator("#time-apply").click();
    await expect(page.locator("#timing")).toHaveValue("arrive");
    await expect(page.locator("#when")).toHaveValue("2026-09-22T14:00");
    await expect(page.locator("#time-summary")).toHaveText("Heute, an 14:00");
  });

test("time validation, five minute midnight rollover and short keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 500 });
  await page.clock.setFixedTime(new Date("2026-09-22T12:00:00Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").fill("13:59");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.locator("#time-clock").fill("");
  await expect(page.locator("#time-apply")).toBeDisabled();
  await expect(page.locator("#time-error")).not.toContainText("zukünftig");
  await page.locator("#time-clock").fill("23:58");
  await page.locator("#time-plus").click();
  await expect(page.locator("#time-clock")).toHaveValue("00:03");
  await expect(
    page.locator('[data-date="2026-09-23"]').locator(".."),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#time-apply")).toBeInViewport();
  await page.locator("#time-minus").click();
  await expect(page.locator("#time-clock")).toHaveValue("23:58");
  await page.locator("#time-clock").fill("00:03");
  await page.locator("#time-minus").click();
  await expect(page.locator("#time-clock")).toHaveValue("23:58");
  await expect(
    page.locator('[data-date="2026-09-21"]').locator(".."),
  ).toHaveAttribute("aria-selected", "true");
  await page.locator("#time-apply").click();
  await expect(page.locator("#when")).toHaveValue("2026-09-21T23:58");
});

test("initial time draft stays fixed and cancelling preserves dynamic now; DST gaps are rejected", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-03-28T11:59:00Z") });
  await page.clock.pauseAt(new Date("2026-03-28T12:00:00Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await expect(page.locator("#time-clock")).toHaveValue("13:00");
  await page.clock.fastForward(60000);
  await expect(page.locator("#time-clock")).toHaveValue("13:00");
  await page.locator("#time-clock").fill("13:02");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.clock.fastForward(120000);
  await expect(page.locator("#time-apply")).toBeEnabled();
  await expect(page.locator("#time-clock")).toHaveValue("13:02");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator("#time-error")).toBeEmpty();
  await expect(page.locator("#time-clock")).toHaveValue("13:02");
  await page.locator('[data-date="2026-03-29"]').click();
  await page.locator("#time-clock").fill("02:30");
  await expect(page.locator("#time-apply")).toBeDisabled();
  await page.locator("#time-clock").fill("03:30");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.locator("#time-cancel").click();
  await expect(page.locator("#timing")).toHaveValue("now");
  await expect(page.locator("#time-summary")).toHaveText("Jetzt");
  await page.locator("#time-trigger").click();
  await expect(page.locator("#time-clock")).toHaveValue("13:03");
});

test("current minute and earlier months can be applied without moving the fixed time", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-22T11:38:10Z") });
  await page.clock.pauseAt(new Date("2026-09-22T11:38:10Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-clock").fill("13:38");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.clock.fastForward(60000);
  await expect(page.locator("#time-apply")).toBeEnabled();
  await expect(page.locator("#time-clock")).toHaveValue("13:38");
  await page.locator("#time-apply").click();
  await page.locator("#search-adjust").click();
  await expect(page.locator("#route-editor")).toBeHidden();
  await expect(page.locator("#search-context")).toContainText("13:38");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await page.locator("#time-previous").click();
  await expect(page.locator("#time-month")).toHaveText("August 2026");
  await page.locator('[data-date="2026-08-22"]').focus();
  await page.locator('[data-date="2026-08-22"]').press("PageUp");
  await expect(page.locator('[data-date="2026-07-22"]')).toBeFocused();
  await page.locator('[data-date="2026-07-22"]').press("Enter");
  await page.locator("#time-arrive").click();
  await page.locator("#time-apply").click();
  await expect(page.locator("#timing")).toHaveValue("arrive");
  await expect(page.locator("#when")).toHaveValue("2026-07-22T13:38");
  await page.locator("#search-adjust").click();
  await expect(page.locator("#route-editor")).toBeHidden();
});

test("now fills once across midnight and only another click refreshes it", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-22T21:59:45Z") });
  await page.clock.pauseAt(new Date("2026-09-22T21:59:50Z"));
  await page.goto("/");
  await page.locator("#search-adjust").click();
  await page.locator("#time-trigger").click();
  await expect(page.locator("#time-clock")).toHaveValue("23:59");
  await expect(page.locator("#time-apply")).toBeEnabled();
  await page.locator("#time-now").click();
  await page.clock.fastForward(60000);
  await expect(page.locator("#time-clock")).toHaveValue("23:59");
  await expect(
    page.locator('[data-date="2026-09-22"]').locator(".."),
  ).toHaveAttribute("aria-selected", "true");
  await page.locator("#time-now").click();
  await expect(page.locator("#time-clock")).toHaveValue("00:00");
  await expect(
    page.locator('[data-date="2026-09-23"]').locator(".."),
  ).toHaveAttribute("aria-selected", "true");
  await page.clock.fastForward(60000);
  await page.locator("#time-apply").click();
  await expect(page.locator("#when")).toHaveValue("2026-09-23T00:00");
  await expect(page.locator("#timing")).toHaveValue("depart");
  await expect(page.locator("#time-summary")).toHaveText("Heute, ab 00:00");
});

for (const mode of ["depart", "arrive"] as const)
  test(`now and manual entry produce the same fixed ${mode} time`, async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-09-22T12:07:45Z") });
    await page.clock.pauseAt(new Date("2026-09-22T12:07:45Z"));
    await page.goto("/");
    await page.locator("#search-adjust").click();
    await page.locator("#time-trigger").click();
    await page.locator(`#time-${mode}`).click();
    await page.locator('[data-date="2026-09-23"]').click();
    await page.locator("#time-clock").fill("18:30");
    await page.locator("#time-now").click();
    await expect(page.locator(`#time-${mode}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#time-clock")).toHaveValue("14:07");
    await page.clock.fastForward(120000);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page.locator("#time-apply").click();
    await expect(page.locator("#timing")).toHaveValue(mode);
    await expect(page.locator("#when")).toHaveValue("2026-09-22T14:07");
    await page.locator("#time-trigger").click();
    await page.locator('[data-date="2026-09-23"]').click();
    await page.locator("#time-clock").fill("18:30");
    await page.locator('[data-date="2026-09-22"]').click();
    await page.locator("#time-clock").fill("14:07");
    await page.locator("#time-apply").click();
    await expect(page.locator("#timing")).toHaveValue(mode);
    await expect(page.locator("#when")).toHaveValue("2026-09-22T14:07");
  });
