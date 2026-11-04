import type { Page } from "./test";

/** A component origin with real modules, without application startup or replacing its entrypoint. */
export async function componentDocument(
  page: Page,
  body = '<div id="picker"></div>',
) {
  await page.route("**/__component_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/style.css"></head><body>${body}</body></html>`,
    }),
  );
  await page.goto("/__component_fixture");
}
