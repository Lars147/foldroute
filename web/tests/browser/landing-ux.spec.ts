import { test, expect, type Locator } from "@playwright/test";

const planner =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;
const landing = new URL("../", planner).href;

async function documentBox(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      x: box.x + window.scrollX,
      y: box.y + window.scrollY,
      width: box.width,
      height: box.height,
    };
  });
}

test("landing keeps route planning primary from introduction to conclusion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(landing);
  await expect(page.locator("h1")).toHaveAccessibleName("ÖPNV kann mehr. Mit deinem Klapprad.");
  await expect(page.locator(".questions details[open]")).toHaveCount(0);
  const words = await page.locator("main p").evaluateAll(elements =>
    elements.filter(element => !element.closest(".faq"))
      .map(element => (element as HTMLElement).innerText).join(" ").trim().split(/\s+/).length,
  );
  // The previous explanatory paragraphs contained 348 words; keep at least a third less.
  expect(words).toBeLessThanOrEqual(232);
  const actions = page.locator("main a.primary");
  await expect(actions).toHaveCount(3);
  await expect(actions).toHaveText(["Route planen", "Beispiel öffnen", "Route planen"]);
  for (const action of await page.locator(".hero a.primary, .closing a.primary").all()) {
    await expect(action).toHaveAccessibleName("Route planen");
    await expect(action).toHaveAttribute("href", "plan/");
  }
  await expect(page.getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("link", { name: "Webplaner", exact: true, includeHidden: true })).toHaveAttribute("href", "#reise");
  await expect(page.locator("#projekt .primary")).toHaveCount(0);
  const project = await documentBox(page.locator("#projekt"));
  const preview = await documentBox(page.locator("#reise"));
  expect(project.y).toBeGreaterThan(preview.y + preview.height);
  const faq = await documentBox(page.locator(".faq"));
  const conclusion = await documentBox(page.locator(".closing"));
  expect(conclusion.y).toBeGreaterThanOrEqual(faq.y + faq.height);
  await page.locator(".hero").getByRole("link", { name: "Route planen", exact: true }).press("Enter");
  await expect(page).toHaveURL(planner);
  await expect(page.getByRole("heading", { name: "Wohin geht’s?", exact: true })).toBeVisible();
});

test("real planner preview stays proportional and follows copy on small screens", async ({ page }) => {
  for (const width of [320, 390, 760, 761, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(landing);
    const heroAction = page.locator(".hero a.primary");
    await expect(heroAction).toBeInViewport({ ratio: 1 });
    const image = page.locator(".planner-preview img");
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(780);
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(1688);
    await expect(image).toHaveAccessibleName(/Mobile Verbindungsliste/);
    const copy = await documentBox(page.locator(".planner-copy"));
    const figure = await documentBox(page.locator(".planner-preview"));
    const screenshot = await documentBox(image);
    expect(Math.abs(screenshot.height - screenshot.width * 1688 / 780)).toBeLessThanOrEqual(3);
    if (width <= 760) expect(figure.y).toBeGreaterThanOrEqual(copy.y + copy.height);
    else expect(figure.x).toBeGreaterThanOrEqual(copy.x + copy.width);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator("#reise").screenshot({ path: test.info().outputPath(`planner-preview-${width}.png`) });
  }
});

test("body text, context and scaled map labels remain readable at every breakpoint", async ({ page }) => {
  for (const width of [320, 390, 760, 761, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(landing);
    const paragraphs = page.locator(".intro, .comparison-heading p, .planner-steps p, .planner-storage, .project p, .questions p");
    for (const paragraph of await paragraphs.all()) {
      await expect(paragraph).toHaveCSS("font-size", "18px");
      await expect(paragraph).toHaveCSS("line-height", "27.9px");
    }
    const contextSizes = await page.locator(
      "nav a, .button, .standalone-link, .hero-availability p, .map-caption, .ticket-modes > span, .comparison-legend, .comparison-controls button, .footer > a, .footer > span",
    ).evaluateAll(elements => elements.map(element => ({
      text: element.textContent,
      size: parseFloat(getComputedStyle(element).fontSize),
    })));
    for (const context of contextSizes) expect(context.size, context.text ?? "").toBeGreaterThanOrEqual(16);
    const labels = await page.locator(".route-diagram text, .comparison-map text").evaluateAll(elements =>
      elements.filter(element => element.getBoundingClientRect().width > 0).map(element => {
        const text = element as SVGTextElement;
        const matrix = text.getScreenCTM()!;
        const box = text.getBoundingClientRect();
        const svg = text.closest("svg")!.getBoundingClientRect();
        return {
          text: text.textContent,
          font: parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.a, matrix.b),
          contained: box.left >= svg.left && box.right <= svg.right && box.top >= svg.top && box.bottom <= svg.bottom,
        };
      }),
    );
    for (const label of labels) {
      expect(label.font, `${width}px: ${label.text}`).toBeGreaterThanOrEqual(16);
      expect(label.contained, `${width}px: ${label.text}`).toBe(true);
    }
  }
});

test("standalone actions and FAQ summaries offer touch targets and keyboard feedback", async ({ page }) => {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(landing);
    const targets = page.locator("nav a:visible, a.button, a.standalone-link, .questions summary, .footer > a");
    for (const target of await targets.all()) {
      const box = await documentBox(target);
      expect(box.height, await target.innerText()).toBeGreaterThanOrEqual(44);
    }
  }
  const question = page.getByText("Wo kann ich FoldRoute nutzen?", { exact: true });
  const answer = page.locator("details").filter({ has: question });
  await question.focus();
  await question.press("Enter");
  await expect(answer).toHaveAttribute("open", "");
  await expect(question).toBeFocused();
  await expect(question).toHaveCSS("outline-style", "solid");
  await question.press("Space");
  await expect(answer).not.toHaveAttribute("open");
});

test("mobile comparison changes routes in a fixed map viewport and desktop shows both", async ({ page }) => {
  for (const width of [320, 390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(landing);
    await expect(page.locator("#comparison-foldroute")).toBeVisible();
    await expect(page.locator("#comparison-classic")).toBeHidden();
    const before = await documentBox(page.locator("#comparison-foldroute .comparison-map"));
    await page.getByRole("button", { name: "Ohne Radetappe", exact: true }).click();
    await expect(page.locator("#comparison-foldroute")).toBeHidden();
    const after = await documentBox(page.locator("#comparison-classic .comparison-map"));
    for (const dimension of ["x", "y", "width", "height"] as const)
      expect(Math.abs(before[dimension] - after[dimension])).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Mit Faltrad", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#comparison-foldroute")).toBeVisible();
    await page.locator("#idee").screenshot({ path: test.info().outputPath(`comparison-${width}.png`) });
  }
  await page.locator("#idee").screenshot({ path: test.info().outputPath("comparison-mobile.png") });
  await page.setViewportSize({ width: 761, height: 900 });
  await expect(page.locator(".comparison-option:visible")).toHaveCount(2);
  await expect(page.locator(".comparison-controls")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#comparison-foldroute")).toBeVisible();
});

test("landing remains readable without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(landing);
  await expect(page.locator(".questions details[open]")).toHaveCount(0);
  await expect(page.locator(".comparison-option:visible")).toHaveCount(2);
  await expect(page.locator(".comparison-controls")).toBeHidden();
  await expect(page.locator(".hero").getByRole("link", { name: "Route planen", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beispiel öffnen", exact: true })).toBeVisible();
  await page.locator(".planner-preview img").scrollIntoViewIfNeeded();
  await expect(page.locator(".planner-preview img")).toBeVisible();
  const question = page.getByText("Wo kann ich FoldRoute nutzen?", { exact: true });
  await question.click();
  await expect(page.locator("details").filter({ has: question })).toHaveAttribute("open", "");
  await context.close();
});

test("landing provides complete setup links and opens the fixed interactive example", async ({ page }) => {
  await page.goto(landing);
  await expect(page.getByRole("link", { name: "Prototyp selbst bauen", exact: true })).toHaveAttribute(
    "href", "https://github.com/Lars147/foldroute/blob/main/ios/README.md",
  );
  await page.getByText("Wie kann ich den iPhone-Prototyp selbst bauen?", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Quellcode als ZIP", exact: true })).toHaveAttribute(
    "href", "https://github.com/Lars147/foldroute/archive/refs/heads/main.zip",
  );
  const installation = page.getByText("Kann ich FoldRoute als App nutzen?", { exact: true });
  await installation.click();
  await expect(page.locator("details").filter({ has: installation })
    .getByRole("link", { name: "So installierst du ihn.", exact: true })).toHaveAttribute(
    "href", "plan/hilfe.html#installation",
  );
  const folding = page.getByText("Wie wird mein Klapprad eingeplant?", { exact: true });
  await folding.click();
  await expect(page.locator("details").filter({ has: folding }))
    .toContainText("die Zeit zum Falten und Entfalten stellst du selbst ein");
  const example = page.locator("#idee").getByRole("link", { name: "Beispiel öffnen", exact: true });
  await expect(example).toBeVisible();
  await expect(page.locator(".comparison-panel #example-route")).toHaveCount(1);
  await expect(page.locator(".comparison-footer a")).toHaveCount(1);
  await expect(example).toHaveClass(/\bprimary\b/);
  await expect(page.locator(".faq #example-route")).toHaveCount(0);
  const href = await page.locator("#example-route").getAttribute("href");
  const url = new URL(href!, landing);
  expect(url.pathname).toBe(new URL(planner).pathname);
  expect([...url.searchParams]).toEqual([["example", "bike-transfer"]]);
  await expect(page.locator("#idee")).not.toContainText("Flughafen München → Fröttmaning.");
  for (const width of [320, 390, 760, 761, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    // Measure together so resize handling and scroll anchoring cannot mix frames.
    await expect.poll(() => page.evaluate((width) => {
      const panel = document.querySelector(".comparison-panel")!.getBoundingClientRect();
      const cards = document.querySelector(".comparison-columns")!.getBoundingClientRect();
      const footer = document.querySelector(".comparison-footer")!.getBoundingClientRect();
      const action = document.querySelector("#example-route")!.getBoundingClientRect();
      const legend = document.querySelector(".comparison-legend")!.getBoundingClientRect();
      const edge = width <= 760 ? "left" : "right";
      return Math.max(
        Math.abs(action[edge] - footer[edge]),
        panel.left - action.left, action.right - panel.right,
        panel.top - action.top, action.bottom - panel.bottom,
        Math.abs(footer.top - cards.bottom - 26),
        width <= 760
          ? Math.abs(action.top - legend.bottom - 20)
          : Math.abs((action.top + action.bottom - legend.top - legend.bottom) / 2),
      );
    }, width)).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press("Tab");
  await example.focus();
  await expect(example).toBeFocused();
  await expect(example).toHaveCSS("outline-style", "solid");
  await page.route("**/api/v6/plan?*", route => route.abort());
  await example.press("Enter");
  await expect(page).toHaveURL(url.href);
  await expect(page.getByRole("heading", { name: "Flughafen München → Fröttmaning", exact: true })).toBeVisible();
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator(".route-choice .route-choice-arrival")).toHaveText("57 min gesamt");
});

test("landing supports narrow screens with doubled text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(landing);
  await page.evaluate(() => {
    const text = [...document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,p,button,a,summary,small,strong,span")]
      .filter((element) => !element.closest("svg"))
      .map((element) => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
    for (const { element, size } of text) element.style.fontSize = `${size * 2}px`;
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const question = page.getByText("Wo kann ich FoldRoute nutzen?", { exact: true });
  await question.click();
  await expect(page.locator("details").filter({ has: question })).toHaveAttribute("open", "");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.locator("#reise").screenshot({ path: test.info().outputPath("planner-large-text.png") });
  const before = await documentBox(page.locator("#comparison-foldroute .comparison-map"));
  await page.getByRole("button", { name: "Ohne Radetappe", exact: true }).click();
  const after = await documentBox(page.locator("#comparison-classic .comparison-map"));
  expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(1);
  await page.locator("#idee").screenshot({ path: test.info().outputPath("comparison-large-text.png") });
});
