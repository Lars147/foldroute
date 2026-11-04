import { test, expect } from "./test";
import { componentDocument } from "./component-document";

test("root presentation retains focused retry across toast hosts and breakpoint layouts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 899, height: 844 });
  await componentDocument(page, '<div id="recovery-fixture"></div>');
  await page.evaluate(async () => {
    const { mountRecoveryFixture } =
      await import("/tests/browser/recovery-focus-fixture.ts");
    mountRecoveryFixture();
  });
  const retry = page.locator("#recover-planning");
  await expect(retry).toBeVisible();
  await retry.focus();
  for (const width of [899, 900, 899]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [placement, host] of [
      ["inline", "#planning-feedback-slot"],
      ["sheet", "#alternatives-feedback-slot"],
      ["root", ".history-feedback"],
    ] as const) {
      await page.evaluate(async (placement) => {
        const { moveRecoveryToast } =
          await import("/tests/browser/recovery-focus-fixture.ts");
        moveRecoveryToast(placement);
      }, placement);
      await expect(
        page.locator(`${host} > #toast #recover-planning`),
      ).toHaveCount(1);
      await expect(page.locator("#toast")).toHaveCount(1);
      await expect(retry).toHaveCount(1);
      await expect(retry).toBeVisible();
      await expect(retry).toBeFocused();
    }
  }
  await retry.press("Enter");
  expect(
    await page.evaluate(async () => {
      const { recoveryActivations } =
        await import("/tests/browser/recovery-focus-fixture.ts");
      return recoveryActivations();
    }),
  ).toBe(1);
});
