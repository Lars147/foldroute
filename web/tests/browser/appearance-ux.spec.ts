import { test, expect, type Page } from "./test";
import {
  openSettingsSection,
  expectPlanningComplete,
  expectMotionSettled,
} from "./assertions";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };

const key = "foldroute.appearance";
const root = () => test.info().project.use.baseURL!;

async function open(page: Page) {
  await page.goto("/");
  await page.locator("#tab-settings").click();
}

async function theme(page: Page, value: "light" | "dark") {
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  await expect(page.locator("html")).toHaveCSS("color-scheme", value);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    value === "dark" ? "#101314" : "#f5f6f3",
  );
}

async function expectPanelContrast(page: Page, selector = ".journey-panel") {
  const failures = await page.locator(selector).evaluate((panel) => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const luminance = (values: number[]) =>
      values.slice(0, 3).reduce((sum, value, i) => {
        const channel = value / 255;
        const linear =
          channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][i];
      }, 0);
    return [
      ...panel.querySelectorAll<HTMLElement>(
        ".route-choice, .route-choice-schedule, .route-line, .route-stage > .icon, .route-effort-metric, .detail-heading, .detail-meta, .leg-symbol, .planning-context-meta, input:not(:disabled), select:not(:disabled), label, summary, p, h1, h2, button:not(:disabled)",
      ),
    ]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .flatMap((element) => {
        let background: HTMLElement | null = element;
        while (
          background &&
          rgb(getComputedStyle(background).backgroundColor)[3] === 0
        )
          background = background.parentElement;
        const foreground = element.matches('input[role="switch"]')
          ? getComputedStyle(element, "::before").backgroundColor
          : getComputedStyle(element).color;
        const a = luminance(rgb(foreground));
        const b = luminance(rgb(getComputedStyle(background!).backgroundColor));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        return ratio >= 4.5
          ? []
          : [
              `${element.tagName}#${element.id}.${element.className} ${element.textContent?.trim().slice(0, 40)}: ${ratio.toFixed(2)} (${foreground} on ${getComputedStyle(background!).backgroundColor})`,
            ];
      });
  });
  expect(failures).toEqual([]);
}

for (const width of [390, 1280])
  for (const value of ["light", "dark"] as const)
    test(`palette stays consistent across screens and dialogs at ${width}px in ${value}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: value, reducedMotion: "reduce" });
      await page.route("https://tiles.openfreemap.org/**", (route) =>
        route.abort(),
      );
      await page.goto("/");
      const ink = value === "dark" ? "rgb(245, 246, 243)" : "rgb(23, 26, 28)";
      const canvas =
        value === "dark" ? "rgb(16, 19, 20)" : "rgb(245, 246, 243)";
      const surface = value === "dark" ? "rgb(23, 26, 28)" : canvas;
      await theme(page, value);
      await expect(page.locator(".app-header")).toHaveCSS(
        "background-color",
        canvas,
      );
      await expect(page.locator(".app-tabs")).toHaveCSS(
        "background-color",
        surface,
      );
      for (const [tab, screen] of [
        ["route", "search"],
        ["history", "history"],
        ["settings", "settings"],
      ]) {
        await page.locator(`#tab-${tab}`).click();
        await expect(page.locator(`#${screen}-view`)).toBeVisible();
        await expect(page.locator(`#${screen}-view`)).toHaveCSS("color", ink);
        await expectPanelContrast(page, `#${screen}-view`);
        const tabColor = await page
          .locator(`#tab-${tab}`)
          .evaluate((element) => getComputedStyle(element).color);
        await page.locator(`#tab-${tab}`).hover();
        await expect(page.locator(`#tab-${tab}`)).toHaveCSS("filter", "none");
        await expect(page.locator(`#tab-${tab}`)).toHaveCSS("color", tabColor);
        await expect(page.locator(".tab-indicator")).toHaveCSS(
          "color",
          "rgb(23, 26, 28)",
        );
      }
      await expect(page.locator(".settings-heading-row")).toHaveCSS(
        "background-color",
        canvas,
      );
      await openSettingsSection(page, "data");
      await page.locator("#clear-data").click();
      const dialog = page.locator("#delete-data-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS("background-color", canvas);
      await expect(dialog).toHaveCSS("color", ink);
      await expectPanelContrast(page, "#delete-data-dialog");
      await dialog.screenshot({ path: info.outputPath(`dialog-${value}.png`) });
      await page.emulateMedia({ contrast: "more" });
      await expect(page.locator(".appearance-segments")).toHaveCSS(
        "border-color",
        ink,
      );
      await expect(page.locator("#cancel-delete-data")).toHaveCSS(
        "border-color",
        ink,
      );
      await page.emulateMedia({ contrast: "no-preference" });
      await page.locator("#cancel-delete-data").click();
      await page.goto("/?example=bike-transfer");
      const card = page.locator(".route-choice");
      await expect(card).toBeVisible();
      await expect(page.locator(".journey-panel")).toHaveCSS(
        "background-color",
        surface,
      );
      const bike = card.locator('.route-stage[data-kind="bike"] .icon').first();
      const bikeColor = await bike.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await card.hover();
      await expect(card).toHaveCSS("filter", "none");
      await expect(bike).toHaveCSS("color", bikeColor);
      await expectPanelContrast(page);
      await expect(page.locator(".map-credit")).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
      await page
        .locator(".journey-panel")
        .screenshot({ path: info.outputPath(`palette-${value}.png`) });
    });

for (const system of ["light", "dark"] as const) {
  test(`appearance overrides ${system} OS, persists and returns to System`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: system });
    await open(page);
    await expect(
      page.getByRole("radio", { name: "System", exact: true }),
    ).toBeChecked();
    await theme(page, system);
    for (const [label, value] of [
      ["Hell", "light"],
      ["Dunkel", "dark"],
    ] as const) {
      await page.getByRole("radio", { name: label, exact: true }).check();
      await theme(page, value);
      await page.emulateMedia({
        colorScheme: value === "light" ? "dark" : "light",
      });
      await theme(page, value);
      await page.reload();
      await page.locator("#tab-settings").click();
      await expect(
        page.getByRole("radio", { name: label, exact: true }),
      ).toBeChecked();
      await theme(page, value);
    }
    await page.getByRole("radio", { name: "System", exact: true }).check();
    await page.emulateMedia({ colorScheme: "dark" });
    await theme(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await theme(page, "light");
  });
}

test("routing reset preserves appearance and local data deletion restores System", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("foldroute.mapStyle", "dark"),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await open(page);
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await page.locator("#reset-settings").click();
  await theme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-map-style", "dark");
  await openSettingsSection(page, "data");
  await page.locator("#clear-data").click();
  await page.locator("#cancel-delete-data").click();
  await theme(page, "dark");
  await page.locator("#clear-data").click();
  await page.locator("#confirm-delete-data").click();
  await theme(page, "light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-map-style",
    "positron",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("foldroute.mapStyle")),
  ).toBeNull();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), key),
  ).toBeNull();
  await page.locator("#tab-settings").click();
  await expect(
    page.getByRole("radio", { name: "System", exact: true }),
  ).toBeChecked();
});

test("invalid stored appearance falls back to System", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "unknown"), key);
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await theme(page, "dark");
  await expect(
    page.getByRole("radio", { name: "System", exact: true }),
  ).toBeChecked();
});

test("unavailable storage keeps appearance usable for this session", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
  });
  await open(page);
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await theme(page, "dark");
  await expect(page.locator("#toast")).toHaveText(
    "Darstellung gilt nur für diese Sitzung.",
  );
  await page.getByRole("radio", { name: "Hell", exact: true }).check();
  await theme(page, "light");
});

test("public example follows System without reading personal routing data", async ({
  page,
}, info) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name !== key && name !== "foldroute.mapStyle")
        throw new Error("Example read personal routing data");
      return original.call(this, name);
    };
  }, key);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/?example=bike-transfer");
  await expect(page.locator(".route-choice")).toBeVisible();
  await theme(page, "light");
  const routeLines = page.locator(
    '.leaflet-overlay-pane path[stroke-width="6"]',
  );
  await expect(routeLines.first()).toBeAttached();
  const lineColors = await routeLines.evaluateAll((lines) =>
    lines.map((line) => line.getAttribute("stroke")),
  );
  expect(lineColors).toContain("#087f8c");
  expect(lineColors).toContain("#7667e8");
  await expect(page.locator(".journey-panel")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
  await expect(page.locator(".app-header")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
  await page
    .locator(".journey-panel")
    .screenshot({ path: info.outputPath("route-light.png") });
  await expectPanelContrast(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await theme(page, "dark");
  await expect(page.locator("#map")).toHaveCSS(
    "background-color",
    "rgb(238, 240, 235)",
  );
  expect(
    await routeLines.evaluateAll((lines) =>
      lines.map((line) => line.getAttribute("stroke")),
    ),
  ).toEqual(lineColors);
  await expect(page.locator(".route-marker-destination")).toHaveCSS(
    "background-color",
    "rgb(23, 26, 28)",
  );
  await expect(page.locator(".journey-panel")).toHaveCSS(
    "background-color",
    "rgb(23, 26, 28)",
  );
  await page
    .locator(".journey-panel")
    .screenshot({ path: info.outputPath("route-dark.png") });
  await expectPanelContrast(page);
  expect(errors).toEqual([]);
});

test("landing stays light while planner and public example share appearance changes", async ({
  page,
  context,
}) => {
  await context.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await theme(page, "dark");
  const landing = await context.newPage();
  await landing.emulateMedia({ colorScheme: "dark" });
  await landing.goto("/landing/");
  await theme(landing, "light");
  await expect(
    landing.getByRole("combobox", { name: "Darstellung" }),
  ).toHaveCount(0);
  await expect(landing.locator(".planner-preview img").first()).toHaveAttribute(
    "src",
    /^assets\/webplaner-vorschau\.png\?v=/,
  );
  expect(await landing.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "dark",
  );
  const planner = await context.newPage();
  await planner.goto("/?example=bike-transfer");
  await expect(planner.locator(".route-choice")).toBeVisible();
  await theme(planner, "dark");
  await page.getByRole("radio", { name: "Hell", exact: true }).check();
  await theme(page, "light");
  await theme(planner, "light");
  await theme(landing, "light");
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await theme(planner, "dark");
  await landing.reload();
  await theme(landing, "light");
  expect(await landing.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "dark",
  );
  await landing.close();
  await planner.close();
});

for (const width of [320, 390, 1280]) {
  for (const value of ["light", "dark"] as const) {
    test(`appearance control fits and keeps keyboard access at ${width}px in ${value}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 852 });
      await page.emulateMedia({ colorScheme: value });
      await open(page);
      const system = page.getByRole("radio", { name: "System", exact: true });
      await system.focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("radio", { name: "Hell", exact: true }),
      ).toBeChecked();
      await page.keyboard.press("ArrowRight");
      await expect(
        page.getByRole("radio", { name: "Dunkel", exact: true }),
      ).toBeChecked();
      await page.getByRole("radio", { name: "System", exact: true }).check();
      await expectMotionSettled(page.locator(".appearance-indicator"));
      await page
        .locator(".appearance-picker")
        .screenshot({ path: info.outputPath("appearance.png") });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.locator(".appearance-picker").scrollIntoViewIfNeeded();
      const overflowing = await page
        .locator(".appearance-picker")
        .evaluate((element) =>
          [element, ...element.querySelectorAll("*")].some(
            (item) => item.getBoundingClientRect().right > innerWidth + 1,
          ),
        );
      expect(overflowing).toBe(false);
      const wrappedLabels = await page
        .locator(".appearance-segments span")
        .evaluateAll((spans) =>
          spans
            .filter((span) => {
              const range = document.createRange();
              range.selectNodeContents(span);
              return (
                range.getBoundingClientRect().height >
                parseFloat(getComputedStyle(span).fontSize) * 1.5
              );
            })
            .map((span) => span.textContent),
        );
      expect(wrappedLabels).toEqual([]);
      await page
        .locator(".appearance-picker")
        .screenshot({ path: info.outputPath("appearance-large-text.png") });
    });
  }
}

test("changing appearance preserves planned route and does not request replanning", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  let requests = 0;
  await page.route("**/api/v6/plan?*", (route) => {
    requests++;
    return route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json:
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    });
  });
  await page.goto(
    `${root()}/?v=3&from=48.132,11.5756&fromName=Start&to=48.175,11.6&toName=Ziel&timing=now`,
  );
  await expectPlanningComplete(page);
  const selected = await page
    .locator('.route-choice[aria-pressed="true"]')
    .getAttribute("data-journey");
  const before = requests;
  await page.locator("#tab-settings").click();
  await page.getByRole("radio", { name: "Hell", exact: true }).check();
  await expect(page.locator("#settings-replan")).toBeHidden();
  await page.locator("#save-settings").click();
  await expect(
    page.locator('.route-choice[aria-pressed="true"]'),
  ).toHaveAttribute("data-journey", selected!);
  await expect(page.locator(".journey-panel")).toHaveCSS(
    "background-color",
    "rgb(245, 246, 243)",
  );
  await page.locator("#tab-settings").click();
  await page.getByRole("radio", { name: "Dunkel", exact: true }).check();
  await page.locator("#save-settings").click();
  await expect(page.locator(".journey-panel")).toHaveCSS(
    "background-color",
    "rgb(23, 26, 28)",
  );
  expect(requests).toBe(before);
});
