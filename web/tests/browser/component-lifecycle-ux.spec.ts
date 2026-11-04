import { test, expect } from "./test";
import { componentDocument } from "./component-document";

test("map style picker disposes and mounts again with native focus behavior", async ({
  page,
}) => {
  await componentDocument(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(async () => {
      const { mountMapStylePicker } = await import("/src/map-style-picker.ts");
      const host = document.getElementById("picker")!;
      const dispose = mountMapStylePicker(host, "fixture");
      mountMapStylePicker(host, "fixture");
      host.addEventListener("dispose-picker", dispose, { once: true });
    });
    const trigger = page.getByRole("button", { name: "Kartenstil wählen" });
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    await expect(
      page.getByRole("dialog", { name: "Karte anpassen" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(
      page.getByRole("radio", { name: "Dunkel", exact: true }),
    ).toBeChecked();
    await page.evaluate(() =>
      document
        .getElementById("picker")!
        .dispatchEvent(new Event("dispose-picker")),
    );
    await expect(page.locator("#picker")).toBeEmpty();
    await expect(page.locator(":popover-open")).toHaveCount(0);
  }
});

test("open desktop picker stays inside the viewport when offline status increases its height", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await componentDocument(page);
  await page.locator("#picker").evaluate((host) => {
    Object.assign(host.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
    });
  });
  await page.evaluate(async () => {
    const { mountMapStylePicker } = await import("/src/map-style-picker.ts");
    mountMapStylePicker(document.getElementById("picker")!, "fixture");
    await document.fonts.ready;
  });
  await page.getByRole("button", { name: "Kartenstil wählen" }).click();
  const panel = page.getByRole("dialog", { name: "Karte anpassen" });
  await expect(panel).toBeVisible();
  const before = (await panel.boundingBox())!;
  await context.setOffline(true);
  await expect(panel.getByRole("status")).toHaveText(
    "Die Straßenkarte lädt wieder mit Verbindung.",
  );
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(before.height);
  await expect
    .poll(async () => {
      const bounds = (await panel.boundingBox())!;
      return bounds.y + bounds.height;
    })
    .toBeLessThanOrEqual(889);
  await context.setOffline(false);
  await expect(panel.getByRole("status")).toBeHidden();
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeCloseTo(before.height, 0);
});
