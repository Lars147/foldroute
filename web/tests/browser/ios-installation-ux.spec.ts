import { test, expect, type Locator, type Page } from "./test";
import { openSettingsSection } from "./assertions";

const production =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;
const listName = "Installation auf iPhone und iPad";
const agents = {
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
};

async function ios(
  page: Page,
  browser: keyof typeof agents,
  installed = false,
) {
  await page.addInitScript(
    ({ agent, desktop, installed }) => {
      Object.defineProperties(navigator, {
        userAgent: { value: agent },
        platform: { value: desktop ? "MacIntel" : "iPhone" },
        maxTouchPoints: { value: desktop ? 5 : 1 },
        standalone: { value: installed },
      });
    },
    { agent: agents[browser], desktop: browser === "ipad", installed },
  );
}

async function android(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      userAgent: {
        value:
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      },
      platform: { value: "Linux armv8l" },
      maxTouchPoints: { value: 5 },
      standalone: { value: false },
    });
  });
}

async function openHelp(page: Page, address = "/") {
  await page.goto(address);
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "help");
}

async function expectGuide(guide: Locator) {
  await expect(guide).toBeVisible();
  const list = guide.getByRole("list", { name: listName });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list).toContainText("„Teilen“");
  await expect(list).toContainText("„Zu Home-Bildschirm hinzufügen“");
  await expect(list).toContainText(
    "In Chrome: „Zum Startbildschirm hinzufügen“.",
  );
  await expect(list).toContainText("„Als Web-App öffnen“");
  await expect(list).toContainText("„Hinzufügen“");
  await expect(guide.locator("svg")).toHaveCount(3);
  for (const svg of await guide.locator("svg").all()) {
    await expect(svg).toBeVisible();
    await expect(svg).toHaveAttribute("focusable", "false");
    expect(
      await svg.evaluate(
        (element) => !!element.closest('[aria-hidden="true"]'),
      ),
    ).toBe(true);
  }
}

for (const browser of ["safari", "chrome", "ipad"] as const) {
  test(`${browser} shows iOS steps on demand and clears them after installation`, async ({
    page,
  }) => {
    await ios(page, browser);
    await openHelp(page);
    const guide = page.locator("#ios-install-guide");
    await expect(guide).toBeHidden();
    await expect(page.locator("#install-message")).toBeEmpty();
    await page.locator("#install").focus();
    await page.locator("#install").press("Enter");
    await expectGuide(guide);
    await expect(
      guide.getByRole("link", { name: "Hilfe zur Installation", exact: true }),
    ).toHaveAttribute("href", "hilfe.html#installation");
    await expect(page.locator("#install-message")).toHaveText(
      "So installierst du FoldRoute auf deinem Home-Bildschirm:",
    );
    await expect(page.locator("#install")).toBeFocused();
    await page.locator("#install").click();
    await expect(guide.getByRole("list", { name: listName })).toHaveCount(1);
    await expect(guide.getByRole("listitem")).toHaveCount(3);
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await expect(guide).toBeHidden();
    await expect(page.locator("#install")).toBeHidden();
    await expect(page.locator("#install-message")).toHaveText(
      "FoldRoute wurde installiert.",
    );
  });
}

test("installed iOS app keeps installation controls and guide hidden", async ({
  page,
}) => {
  await ios(page, "safari", true);
  await openHelp(page);
  await expect(page.locator("#install")).toBeHidden();
  await expect(page.locator("#ios-install-guide")).toBeHidden();
  await expect(page.locator("#install-message")).toBeHidden();
});

test("Android uses its native prompt after an earlier menu hint", async ({
  page,
}) => {
  await android(page);
  await openHelp(page);
  await page.locator("#install").click();
  await expect(page.locator("#install-message")).toContainText("Browsermenü");
  await expect(page.locator("#ios-install-guide")).toBeHidden();
  const prevented = await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        const root = document.documentElement;
        root.dataset.installPrompts = String(
          Number(root.dataset.installPrompts ?? 0) + 1,
        );
      },
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.locator("#install").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-install-prompts",
    "1",
  );
  await expect(page.locator("#ios-install-guide")).toBeHidden();
  await expect(page.locator("#install-message")).toBeEmpty();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`iOS guides fit 320px with enlarged text in ${colorScheme}`, async ({
    page,
  }, info) => {
    await ios(page, "safari");
    await page.setViewportSize({ width: 320, height: 852 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await openHelp(page, production);
    await page.locator("#install").click();
    const plannerGuide = page.locator("#ios-install-guide");
    await expectGuide(plannerGuide);
    const steps = await plannerGuide
      .getByRole("list", { name: listName })
      .innerText();
    for (const fontSize of [16, 32]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(320);
      await expect
        .poll(() =>
          plannerGuide.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        )
        .toBe(true);
      const link = plannerGuide.getByRole("link", {
        name: "Hilfe zur Installation",
        exact: true,
      });
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await plannerGuide.screenshot({
        path: info.outputPath(`planner-${colorScheme}-${fontSize}.png`),
      });
    }
    const link = plannerGuide.getByRole("link", {
      name: "Hilfe zur Installation",
      exact: true,
    });
    await expect(link).not.toHaveAttribute("target", "_blank");
    await page.keyboard.press("Tab");
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS("outline-style", "solid");
    await link.press("Enter");
    await expect(page).toHaveURL(
      new URL("hilfe.html#installation", production).href,
    );
    await expect(page.locator("#installation")).toHaveAttribute("open", "");
    const helpGuide = page.locator("#installation .install-guide");
    await expectGuide(helpGuide);
    await expect(helpGuide.getByRole("list", { name: listName })).toHaveText(
      steps,
    );
    for (const fontSize of [16, 32]) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = `${size}px`;
      }, fontSize);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(320);
      await helpGuide.screenshot({
        path: info.outputPath(`help-${colorScheme}-${fontSize}.png`),
      });
    }
  });
}

test("help keeps its illustrated iOS steps usable without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 852 },
  });
  const page = await context.newPage();
  await page.goto(new URL("hilfe.html#installation", production).href);
  await page.locator("#installation summary").click();
  await expectGuide(page.locator("#installation .install-guide"));
  await expect(
    page.locator("#installation").getByRole("link", { name: "den Webplaner" }),
  ).toHaveAttribute("href", "./");
  await context.close();
});
