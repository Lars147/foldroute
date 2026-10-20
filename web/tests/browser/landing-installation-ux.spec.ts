import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const planner =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;
const landing = new URL("../", planner).href;
const landingDocument = fileURLToPath(
  new URL("../../../docs/index.html", import.meta.url),
);

for (const mount of ["/", "/foldroute/"]) {
  for (const mode of ["browser", "standalone", "ios"] as const) {
    test(`${mode} landing launch respects ${mount} and navigation history`, async ({
      page,
    }) => {
      await page.addInitScript((mode) => {
        const match = window.matchMedia.bind(window);
        window.matchMedia = (query) => {
          const result = match(query);
          if (query === "(display-mode: standalone)")
            Object.defineProperty(result, "matches", {
              value: mode === "standalone",
            });
          return result;
        };
        Object.defineProperty(navigator, "standalone", {
          value: mode === "ios",
        });
      }, mode);
      const entry = new URL(mount, planner);
      entry.search = "from=home-screen";
      entry.hash = "reise";
      const target = new URL("plan/", entry);
      const previous = new URL("before-installation-test", entry);
      const navigations: string[] = [];
      // Serve the real landing HTML under both deployment paths. Keep the
      // destination inert so this test isolates redirects and history.
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (!request.isNavigationRequest()) return route.abort();
        const url = new URL(request.url());
        navigations.push(url.href);
        if (url.pathname === entry.pathname)
          return route.fulfill({
            path: landingDocument,
            contentType: "text/html",
          });
        expect([target.pathname, previous.pathname]).toContain(url.pathname);
        return route.fulfill({
          contentType: "text/html",
          body: `<h1>${url.pathname === target.pathname ? "Webplaner" : "Vorherige Seite"}</h1>`,
        });
      });
      await page.goto(previous.href);
      await page.goto(entry.href);
      if (mode === "browser") {
        await expect(page).toHaveURL(entry.href);
        await expect(page.locator("h1")).toHaveText(
          "ÖPNV kann mehr.Mit deinem Klapprad.",
        );
        expect(navigations).toHaveLength(2);
        return;
      }
      await expect(page).toHaveURL(target.href);
      await expect(
        page.getByRole("heading", { name: "Webplaner" }),
      ).toBeVisible();
      expect(navigations).toHaveLength(3);
      await page.goBack();
      await expect(page).toHaveURL(previous.href);
      await expect(
        page.getByRole("heading", { name: "Vorherige Seite" }),
      ).toBeVisible();
    });
  }
}

test("landing installation points to the planner without registering a PWA", async ({
  page,
}) => {
  await page.goto(landing);
  const answer = page.locator("details").filter({
    has: page.getByText("Kann ich FoldRoute als App nutzen?", { exact: true }),
  });
  await answer.locator("summary").click();
  await expect(answer).toContainText("Öffne zuerst den Webplaner");
  const link = answer.getByRole("link", { name: "Webplaner", exact: true });
  await expect(link).toHaveAttribute("href", "plan/");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  const icon = await page
    .locator('link[rel="apple-touch-icon"]')
    .evaluate(async (link: HTMLLinkElement) => {
      const image = new Image();
      image.src = link.href;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    });
  expect(icon).toEqual([180, 180]);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller),
  ).toBeNull();
  expect(
    await page.evaluate(() =>
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => registrations.length),
    ),
  ).toBe(0);
  await link.click();
  await expect(page).toHaveURL(planner);
  await expect(
    page.getByRole("heading", { name: "Wohin geht’s?", exact: true }),
  ).toBeVisible();
});

test("planner starts directly in app mode without redirecting again", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
  const navigations: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      navigations.push(request.url());
  });
  await page.goto(planner);
  await expect(page.locator("#app-startup")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Wohin geht’s?", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.ready).scope,
    ),
  ).toBe(planner);
  expect(navigations).toEqual([planner]);
});
