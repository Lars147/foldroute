import { test, expect } from "./test";
import { setup, plan, runMapClock } from "./planner-fixture";
import { showMap } from "./assertions";

for (const clipboard of ["allowed", "denied"] as const)
  test(`screen diagnosis keeps the visible map after opening settings (${clipboard} clipboard)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, "standalone", { value: true });
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            if (mode === "denied")
              throw new DOMException("Denied", "NotAllowedError");
            document.documentElement.dataset.copiedScreenReport = text;
          },
        },
      });
    }, clipboard);
    await setup(page);
    await page.addStyleTag({
      content: ":root { --safe-top: 59px; --safe-bottom: 34px; }",
    });
    await plan(page);
    await runMapClock(page);
    await showMap(page);
    await page.locator("#tab-settings").click();
    await page.locator("#screen-diagnostics > summary").click();
    await page.evaluate(() => {
      history.replaceState(
        history.state,
        "",
        `${location.pathname}?fromName=PRIVATE_ADDRESS#PRIVATE_ROUTE`,
      );
      localStorage.setItem("diagnostic-private-test", "PRIVATE_STORAGE");
    });
    await page.locator("#copy-screen-diagnostics").click();
    await expect(page.locator("#screen-diagnostics-status")).toContainText(
      clipboard === "allowed" ? "Diagnose kopiert" : "manuell kopieren",
    );
    const text =
      clipboard === "allowed"
        ? (await page
            .locator("html")
            .getAttribute("data-copied-screen-report"))!
        : await page.locator("#screen-diagnostics-value").inputValue();
    const report = JSON.parse(text);
    expect(report.build).toMatch(/^[a-f0-9]{7}$/);
    expect(report.lastMapSnapshot.view).toBe("map");
    expect(report.lastMapSnapshot.resultScreen).toBe("map");
    expect(report.lastMapSnapshot.standalone).toBe(true);
    expect(report.lastMapSnapshot.layout.map.bounds).toMatchObject({
      x: 0,
      y: 0,
      width: 393,
      height: 852,
    });
    expect(report.lastMapSnapshot.layout.statusBarOverlay.height).toBe("59px");
    expect(
      report.lastMapSnapshot.layout.statusBarOverlay["background-image"],
    ).toContain("linear-gradient");
    expect(report.current.view).toBe("settings");
    expect(report.current.layout.map.bounds).toBeNull();
    expect(text).not.toMatch(/PRIVATE_|latitude|longitude|fromName|"Ziel"/);
    if (clipboard === "denied") {
      await expect(page.locator("#screen-diagnostics-value")).toBeVisible();
      await expect(page.locator("#screen-diagnostics-value")).toBeFocused();
    } else
      await expect(page.locator("#screen-diagnostics-fallback")).toBeHidden();
  });

test("screen diagnosis explains when no map has been opened", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
  });
  await page.locator("#tab-settings").click();
  await page.locator("#screen-diagnostics > summary").click();
  await page.locator("#copy-screen-diagnostics").click();
  await expect(page.locator("#screen-diagnostics-status")).toContainText(
    "Noch keine Kartenansicht erfasst",
  );
  const report = JSON.parse(
    await page.locator("#screen-diagnostics-value").inputValue(),
  );
  expect(report.lastMapSnapshot).toBeNull();
});
