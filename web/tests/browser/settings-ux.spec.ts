import { expect, test, type Page } from "./test";
import { openSettingsSection } from "./assertions";

async function open(page: Page) {
  await page.goto("/");
  await page.locator("#tab-settings").click();
}

for (const width of [320, 390, 1280]) {
  test(`settings hierarchy and large text fit at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await open(page);
    for (const id of [
      "cyclingSpeedKilometersPerHour",
      "maxCyclingMinutes",
      "foldingDuration",
    ])
      await expect(page.locator(`#${id}`)).toBeVisible();
    for (const id of ["modes", "options", "optimization", "data", "help"])
      await expect(page.locator(`#settings-${id}`)).not.toHaveAttribute("open");
    await expect(page.locator("#settings-replan")).toBeHidden();
    await expect(page.locator("#save-settings")).toHaveText("Fertig");
    await expect(page.locator("#app-version")).toHaveText(/^[0-9a-f]{7}$/);
    await expect(page.locator("#app-version")).toBeVisible();
    await page.screenshot({
      path: info.outputPath("settings.png"),
      fullPage: true,
    });
    await page.locator("#app-updates").screenshot({
      path: info.outputPath("updates-development.png"),
    });
    for (const id of [
      "modes",
      "options",
      "optimization",
      "data",
      "help",
    ] as const)
      await openSettingsSection(page, id);
    await page
      .locator("#settings-help")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page
      .locator("#settings-help")
      .screenshot({ path: info.outputPath("settings-help.png") });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "32px";
    });
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("#settings-view *"))
          .filter(
            (el) =>
              el.getBoundingClientRect().width &&
              el.getBoundingClientRect().right > innerWidth,
          )
          .map((el) => `${el.tagName}#${el.id}.${el.className}`),
      ),
    ).toEqual([]);
    await expect(page.getByRole("link", { name: "Hilfe & FAQ" })).toBeVisible();
    await page.keyboard.press("Tab");
    await page.locator("#app-version").focus();
    await expect(page.locator("#app-version")).toBeFocused();
    await expect(page.locator("#app-version")).toHaveCSS(
      "outline-style",
      "solid",
    );
    await expect(page.locator("#app-version")).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath("settings-large-text.png"),
      fullPage: true,
    });
  });
}

for (const width of [320, 390, 1280]) {
  test(`settings completion stays reachable after scrolling at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
    await open(page);
    for (const section of ["modes", "options", "data", "help"] as const)
      await openSettingsSection(page, section);
    const invalid = page.locator("#maxWalkingMinutes");
    await invalid.fill("1000");
    await page.locator("#settings-options > summary").click();
    const heading = page.locator(".settings-heading-row");
    const done = page.locator("#save-settings");
    for (const fontSize of [16, 32]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
        window.scrollTo(0, document.documentElement.scrollHeight);
      }, fontSize);
      await expect
        .poll(() =>
          heading.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return Math.abs(
              rect.top - parseFloat(getComputedStyle(element).top),
            );
          }),
        )
        .toBeLessThan(1);
      const box = await done.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThan(852 - 64);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      await expect(done).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: info.outputPath("settings-sticky.png") });
    await done.click();
    await expect(invalid).toBeFocused();
    await expect
      .poll(async () => {
        const field = await invalid.boundingBox();
        const header = await heading.boundingBox();
        return field!.y - (header!.y + header!.height);
      })
      .toBeGreaterThanOrEqual(7);
    await expect(invalid).toBeInViewport({ ratio: 1 });
    await invalid.fill("3");
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await done.click();
    await expect(page.locator("#search-view")).toBeVisible();
  });
}

test("sticky settings header respects safe area and changing offline banner", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 852 });
  await open(page);
  await page.locator("#settings-view").evaluate((element) => {
    element.style.setProperty("--settings-safe-top", "24px");
  });
  // Desktop engines have no iPhone inset; simulate its matching banner position.
  await page.locator("#connection").evaluate((element) => {
    element.style.top = "24px";
  });
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const heading = page.locator(".settings-heading-row");
  await expect
    .poll(() =>
      heading.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBe(24);
  await context.setOffline(true);
  await expect(page.locator("#connection")).toBeVisible();
  await expect
    .poll(async () => {
      const header = await heading.boundingBox();
      const banner = await page.locator("#connection").boundingBox();
      return Math.abs(header!.y - (banner!.y + banner!.height));
    })
    .toBeLessThan(1);
  await context.setOffline(false);
  await expect(page.locator("#connection")).toBeHidden();
  await expect
    .poll(() =>
      heading.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBe(24);
});

test("mode summary, reset and disclosure state survive navigation", async ({
  page,
}) => {
  await open(page);
  const summary = page.locator("#settings-modes > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#settings-modes")).toHaveAttribute("open", "");
  for (const checkbox of await page.locator("#modes input").all())
    await checkbox.uncheck();
  await expect(page.locator("#modes-summary")).toHaveText("Keine ausgewählt");
  await page.getByRole("checkbox", { name: "S-Bahn", exact: true }).check();
  await expect(page.locator("#modes-summary")).toHaveText("S-Bahn");
  await openSettingsSection(page, "options");
  await page.locator("#maxWalkingMinutes").fill("5");
  await page.locator("#reset-settings").click();
  await expect(page.locator("#modes-summary")).toHaveText(
    "Alle Verkehrsmittel",
  );
  await expect(page.locator("#maxWalkingMinutes")).toHaveValue("2");
  await expect(page.locator("#settings-options")).toHaveAttribute("open", "");
  await page.locator("#save-settings").click();
  await expect(page.locator("#search-view")).toBeVisible();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#settings-options")).toHaveAttribute("open", "");
});

for (const exit of ["done", "route", "history", "back"] as const)
  test(`invalid settings block ${exit} and keep the draft until corrected`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await openSettingsSection(page, "options");
    const input = page.locator("#maxWalkingMinutes");
    await input.fill("4");
    await input.fill("1000");
    await page.locator("#settings-options > summary").click();
    const position = await page.evaluate(() => history.state.position);
    if (exit === "back") await page.goBack();
    else
      await page
        .locator(exit === "done" ? "#save-settings" : `#tab-${exit}`)
        .click();
    await expect(page.locator("#settings-view")).toBeVisible();
    await expect(input).toHaveValue("1000");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();
    await expect(page.locator("#settings-options")).toHaveAttribute("open", "");
    await expect(page.locator("#maxWalkingMinutes-error")).toBeVisible();
    await expect(page.locator("#maxWalkingMinutes-error")).toBeInViewport({
      ratio: 1,
    });
    await expect
      .poll(() => page.evaluate(() => history.state.position))
      .toBe(position);
    await page.locator("#tab-settings").click();
    await expect(input).toHaveValue("1000");
    await page.screenshot({
      path: info.outputPath(`settings-invalid-${exit}.png`),
    });
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
            .maxWalkingMinutes,
      ),
    ).toBe(4);
    await input.fill("3");
    await expect(page.locator("#maxWalkingMinutes-error")).toBeHidden();
    if (exit === "back") await page.goBack();
    else
      await page
        .locator(exit === "done" ? "#save-settings" : `#tab-${exit}`)
        .click();
    await expect(page.locator("#settings-view")).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("foldroute.routing.v3")!)
            .maxWalkingMinutes,
      ),
    ).toBe(3);
  });

test("app switches persist and data deletion still requires confirmation", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("switch", { name: /Bildschirm eingeschaltet/ })
    .uncheck();
  await page.reload();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#keep-screen-awake")).not.toBeChecked();
  await openSettingsSection(page, "data");
  await page.locator("#clear-data").click();
  await expect(page.locator("#delete-data-dialog")).toBeVisible();
  await page.locator("#cancel-delete-data").click();
  await expect(page.locator("#keep-screen-awake")).not.toBeChecked();
});

for (const installed of [false, true]) {
  test(`help keeps installation feedback and accessible links, installed=${installed}`, async ({
    page,
  }) => {
    await page.addInitScript((standalone) => {
      Object.defineProperty(navigator, "standalone", { value: standalone });
    }, installed);
    await open(page);
    await expect(page.locator(".settings-licenses")).toBeVisible();
    await openSettingsSection(page, "help");
    if (installed) {
      await expect(page.locator("#install")).toBeHidden();
      await expect(page.locator("#install-message")).toBeEmpty();
      await expect(page.locator("#install-message")).toBeHidden();
    } else {
      await page.locator("#install").click();
      await expect(page.locator("#install-message")).toContainText(
        "Browsermenü",
      );
      await page.evaluate(() =>
        window.dispatchEvent(new Event("appinstalled")),
      );
      await expect(page.locator("#install")).toBeHidden();
      await expect(page.locator("#install-message")).toHaveText(
        "FoldRoute wurde installiert.",
      );
    }
    const links = page.locator(
      ".settings-help-links a, .settings-feedback, .settings-licenses",
    );
    await expect(links).toHaveCount(5);
    for (const link of await links.all()) {
      expect(
        Math.round((await link.boundingBox())!.height),
      ).toBeGreaterThanOrEqual(48);
      await expect(link).not.toHaveAttribute("target", "_blank");
    }
    const privacy = page.getByRole("link", {
      name: "Datenschutz & Daten",
      exact: true,
    });
    await privacy.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#datenschutz")).toHaveAttribute("open", "");
    await expect(page.locator("#datenschutz summary")).toBeInViewport();
    await expect(page.locator("#datenschutz")).toContainText(
      /keine\s+Analyse-Tools/,
    );
    await expect(page.locator("#datenschutz")).toContainText(
      /keine\s+GPS-Spuren/,
    );
  });
}
