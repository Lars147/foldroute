import { test, expect } from "./test";
import { componentDocument } from "./component-document";

test("replacing focused settings fields preserves validation and one active change binding", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await componentDocument(page, '<div id="settings-fixture"></div>');
  await page.evaluate(async () => {
    const { mountSettingsFixture } =
      await import("/tests/browser/settings-lifecycle-fixture.ts");
    mountSettingsFixture();
  });
  const input = page.locator("#cyclingSpeedKilometersPerHour");
  const error = page.locator("#cyclingSpeedKilometersPerHour-error");
  const changes: number[][] = [[]];
  await expect(input).toHaveValue("15");

  for (const speed of [18, 20, 22]) {
    await input.fill("");
    await expect(input).toBeFocused();
    const previous = await input.elementHandle();
    await page.evaluate(async (speed) => {
      const { replaceSettingsBinding } =
        await import("/tests/browser/settings-lifecycle-fixture.ts");
      replaceSettingsBinding(speed);
    }, speed);
    expect(await previous!.evaluate((element) => element.isConnected)).toBe(
      false,
    );
    await expect(input).toHaveCount(1);
    await expect(input).toHaveValue(String(speed));
    await expect(input).toHaveAttribute("aria-invalid", "false");
    await expect(error).toBeHidden();
    expect(errors).toEqual([]);

    await input.fill("99");
    await input.press("Tab");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(error).toHaveText("Bitte einen Wert von 10 bis 30 eingeben.");
    await expect(error).toBeVisible();
    await input.fill(String(speed + 1));
    await expect(input).toHaveAttribute("aria-invalid", "false");
    await expect(error).toBeHidden();
    changes.push([speed + 1]);
    expect(
      await page.evaluate(async () => {
        const { settingsBindingChanges } =
          await import("/tests/browser/settings-lifecycle-fixture.ts");
        return settingsBindingChanges();
      }),
    ).toEqual(changes);
    expect(errors).toEqual([]);
  }

  await expect(input).toBeFocused();
  await page.evaluate(async () => {
    const { clearSettingsBinding } =
      await import("/tests/browser/settings-lifecycle-fixture.ts");
    clearSettingsBinding();
  });
  await expect(input).toHaveCount(0);
  expect(errors).toEqual([]);
});
