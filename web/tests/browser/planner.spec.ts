import { test, expect, type Page } from "@playwright/test";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After",
};
const places = [
  { name: "Start", lat: 48.132, lon: 11.5756 },
  { name: "Ziel", lat: 48.175, lon: 11.6 },
];
async function setup(page: Page, geolocation = true) {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  if (geolocation) {
    await page.context().grantPermissions(["geolocation"]);
    await page
      .context()
      .setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  }
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({ headers: cors, json: places }),
  );
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  await page.goto("/");
}
async function choose(page: Page, id: string, name: string) {
  await page.locator("#" + id).fill(name);
  await page
    .locator("#" + id + "-options")
    .getByRole("option")
    .filter({ hasText: name })
    .click();
}
async function plan(page: Page) {
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
}
for (const width of [320, 390, 768, 1479])
  test(`responsive app flow ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 986 });
    await setup(page);
    await plan(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "normal",
    );
    await page.locator("#panel-size").click();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "expanded",
    );
    await expect(page.locator("#journey-detail")).toContainText("Rad");
    if (width < 900)
      await expect
        .poll(async () =>
          page
            .locator("#journey-panel")
            .evaluate(
              (e) =>
                e.clientHeight /
                document.getElementById("map-view")!.clientHeight,
            ),
        )
        .toBeGreaterThan(0.85);
    await page.screenshot({
      path: `test-results/app-${width}.png`,
      fullPage: true,
    });
    await page.locator("#panel-size").click();
    await expect(page.locator("#journey-panel")).toHaveAttribute(
      "data-size",
      "collapsed",
    );
    await expect(page.locator("#adjust-route")).toBeInViewport();
  });
test("destination selection calculates automatically, never on opening or typing", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/v6/plan")) requests++;
  });
  expect(requests).toBe(0);
  await page.locator("#destination").fill("Ziel");
  await expect(page.locator("#destination-options")).toBeVisible();
  expect(requests).toBe(0);
  await page.locator("#destination").press("ArrowDown");
  await page.locator("#destination").press("ArrowDown");
  await page.locator("#destination").press("Enter");
  await expect(page.locator("#route-duration")).toContainText("32 min");
  expect(requests).toBeGreaterThan(0);
});
test("location denial keeps destination and allows a manual start", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) =>
          fail({ code: 1 }),
      },
    });
  });
  await setup(page, false);
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");
  await choose(page, "origin", "Start");
  await page.locator("#calculate").click();
  await expect(page.locator("#route-duration")).toContainText("32 min");
});
test("adjustments are drafts and cancellation preserves results", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#adjust-route").click();
  await page.locator("#origin").fill("Other");
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Aktueller Standort");
});
test("settings persist only after applying; route remains available", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.locator("#foldDuration").fill("4");
  await page.locator("#discard-settings").click();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldDuration")).toHaveValue("3");
  await page.locator("#foldDuration").fill("4");
  await page.locator("#save-settings").click();
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await page.reload();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldDuration")).toHaveValue("4");
});
test("throttling stops further requests; manual retry observes the pause", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  await page.route("**/api/v6/plan?*", (r) => {
    requests++;
    return r.fulfill({
      status: 429,
      headers: { ...cors, "Retry-After": "60" },
    });
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#status")).toContainText("Zu viele Anfragen");
  const before = requests;
  await page.locator("#adjust-route").click();
  await page.locator("#calculate").click();
  await expect(page.locator("#status")).toContainText("Pause");
  expect(requests).toBe(before);
});
test("cancel retains progressive results and ignores delayed responses", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: fixture.direct });
    else {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await page.locator("#cancel").click();
  await expect(page.locator("#status")).toContainText("abgebrochen");
  await page.waitForTimeout(1700);
  await expect(page.locator("#route-duration")).toContainText("32 min");
  await expect(page.locator("#status")).toContainText("abgebrochen");
});
test("duration order and stable selection while faster alternatives arrive", async ({
  page,
}) => {
  await setup(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  await page.route("**/api/v6/plan?*", async (r) => {
    if (new URL(r.request().url()).searchParams.get("directModes") === "BIKE")
      await r.fulfill({ headers: cors, json: direct });
    else {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await r.fulfill({ headers: cors, json: fixture.multimodal });
    }
  });
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#route-duration")).toContainText("1 h 1 min");
  await expect(page.locator("#status")).toHaveText("Verbindungen gefunden.");
  await expect(page.locator(".route-choice")).toHaveText([
    "1 · 52 min",
    "2 · 1 h 1 min",
  ]);
  await expect(page.locator(".route-choice[aria-pressed=true]")).toHaveText(
    "2 · 1 h 1 min",
  );
  await page.locator("#panel-summary").press("ArrowLeft");
  await expect(page.locator("#route-duration")).toContainText("52 min");
});
test("failed refresh preserves selected journey", async ({ page }) => {
  await setup(page);
  await plan(page);
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ status: 503, headers: cors }),
  );
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toContainText("nicht verfügbar");
  await expect(page.locator("#route-duration")).toContainText("32 min");
});
test("dark appearance, large text and reduced motion remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await setup(page);
  await plan(page);
  await page.locator("#panel-size").click();
  await page.addStyleTag({ content: ":root {font-size: 24px !important;}" });
  await expect(page.locator("#adjust-route")).toBeVisible();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#adjust-dialog")).toBeVisible();
  await page.locator("#cancel-adjust").click();
  await page.screenshot({
    path: "test-results/app-dark-large.png",
    fullPage: true,
  });
});

test("adjustment actions remain reachable in a short keyboard viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await setup(page);
  await page.locator("#search-adjust").click();
  await page.locator("#origin").focus();
  await expect(page.locator("#calculate")).toBeInViewport({ ratio: 1 });
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").scrollIntoViewIfNeeded();
  await expect(page.locator("#when")).toBeInViewport();
  await expect(page.locator("#use-context")).toBeInViewport({ ratio: 1 });
});

test("focused dialog fields stay inside the scroll area when the keyboard opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator("#search-adjust").focus();
  await page.locator("#search-adjust").press("Enter");
  await page.locator("#adjust-destination").fill("Zi");
  await page
    .locator("#adjust-destination")
    .evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));

  // Unlike resizing the page, an iOS keyboard shrinks the visual viewport
  // while leaving the layout viewport intact.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", {
      configurable: true,
      value: 365,
    });
    Object.defineProperty(window.visualViewport!, "offsetTop", {
      configurable: true,
      value: 40,
    });
    window.visualViewport!.dispatchEvent(new Event("resize"));
    window.visualViewport!.dispatchEvent(new Event("scroll"));
  });
  const expectFieldInside = async (id: string, withLabel = true) => {
    await expect
      .poll(() =>
        page.evaluate(
          ({ id, withLabel }) => {
            const field = document.getElementById(id) as HTMLInputElement;
            const bounds = document
              .querySelector(".dialog-body")!
              .getBoundingClientRect();
            const input = field.getBoundingClientRect();
            const label = field.labels![0].getBoundingClientRect();
            return (
              Math.min(input.top, withLabel ? label.top : input.top) >=
                bounds.top - 1 && input.bottom <= bounds.bottom + 1
            );
          },
          { id, withLabel },
        ),
      )
      .toBe(true);
    await expect(page.locator(`#${id}`)).toBeFocused();
  };
  await expectFieldInside("adjust-destination");
  await expect(page.locator("#adjust-destination")).toHaveValue("Zi");
  expect(
    await page
      .locator("#adjust-destination")
      .evaluate((input: HTMLInputElement) => input.selectionStart),
  ).toBe(1);

  await page.locator("#origin").focus();
  await expectFieldInside("origin");
  await page.locator("#timing").selectOption("depart");
  await page.locator("#when").focus();
  await expectFieldInside("when");
  await choose(page, "adjust-destination", "Ziel");
  await expectFieldInside("adjust-destination");
  await expect(page.locator("#adjust-destination")).toHaveValue("Ziel");

  await page.addStyleTag({ content: ":root { font-size: 24px; }" });
  await page.evaluate(() =>
    window.visualViewport!.dispatchEvent(new Event("resize")),
  );
  await expectFieldInside("adjust-destination", false);
  const actionsVisible = await page.evaluate(() => {
    const actions = document
      .querySelector(".dialog-actions")!
      .getBoundingClientRect();
    const viewport = window.visualViewport!;
    return (
      actions.top >= viewport.offsetTop &&
      actions.bottom <= viewport.offsetTop + viewport.height
    );
  });
  expect(actionsVisible).toBe(true);
  await page.locator("#cancel-adjust").click();
  await expect(page.locator("#search-adjust")).toBeFocused();
});

for (const code of [0, 1, 2, 3]) {
  test(`location button requests access immediately: ${code}`, async ({
    page,
  }) => {
    await page.addInitScript((code) => {
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition: (
            success: (p: unknown) => void,
            fail: (e: unknown) => void,
          ) => {
            if (code)
              fail({
                code,
                message:
                  "Origin does not have permission to use Geolocation service",
              });
            else success({ coords: { latitude: 48.132, longitude: 11.5756 } });
          },
        },
      });
    }, code);
    await setup(page, false);
    await page.locator("#search-adjust").click();
    await page.locator("#origin-location").click();
    await expect(page.locator("#adjust-status")).toContainText(
      [
        "Standort verfügbar",
        "Standortzugriff nicht erlaubt",
        "Standort konnte nicht ermittelt werden",
        "Standortabfrage dauert zu lange",
      ][code],
    );
    if (code) {
      await expect(page.locator("#adjust-status")).toContainText(
        `Diagnose: Standortfehler ${code} – Origin does not have permission to use Geolocation service`,
      );
    }
    await expect(page.locator("#origin-location")).toBeEnabled();
    await expect(page.locator("#adjust-dialog")).toBeVisible();
  });
}

test("cancelled location request does not overwrite manual start feedback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (_success: unknown, fail: (e: unknown) => void) => {
          window.addEventListener("fail-location", () => fail({ code: 1 }), {
            once: true,
          });
        },
      },
    });
  });
  await setup(page, false);
  await page.locator("#search-adjust").click();
  await page.locator("#origin-location").click();
  await expect(page.locator("#origin-location")).toBeDisabled();
  await choose(page, "origin", "Start");
  await page.evaluate(() => window.dispatchEvent(new Event("fail-location")));
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(page.locator("#adjust-status")).toHaveText("");
  await expect(page.locator("#origin-location")).toBeEnabled();
});
