import { resizeOverview } from "./assertions";
import { expect, test, type Page } from "@playwright/test";
import { defaults } from "../../src/model";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
import { expectPlanningComplete } from "./assertions";

const cors = { "Access-Control-Allow-Origin": "*" };
async function setup(page: Page) {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({
      headers: cors,
      json: [
        { name: "Start", lat: 48.132, lon: 11.5756 },
        { name: "Ziel", lat: 48.175, lon: 11.6 },
      ],
    }),
  );
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({
      headers: cors,
      json:
        new URL(route.request().url()).searchParams.get("directModes") ===
        "BIKE"
          ? fixture.direct
          : fixture.multimodal,
    }),
  );
  await page.goto("/");
  await page.evaluate(
    (value) =>
      localStorage.setItem("foldroute.routing.v3", JSON.stringify(value)),
    {
      ...defaults,
      maxCyclingMinutes: 60,
      maxBikeTransfers: 0,
    },
  );
  await page.reload();
}
async function choose(page: Page, id: string, name: string) {
  await page.locator(`#${id}`).fill(name);
  await page
    .locator(`#${id}-options .place-select`)
    .filter({ hasText: name })
    .click();
}
async function plan(page: Page) {
  await choose(page, "destination", "Ziel");
  await expectPlanningComplete(page);
  await expect(page.locator("#storage-message")).toContainText("gespeichert");
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/offline.ts";
    const { OfflineStore } = await import(path);
    return (await new OfflineStore().read()).snapshot;
  });
}

test("context-only action is limited to the initial dialog, including failed plans", async ({
  page,
}) => {
  await setup(page);
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#search-adjust").click();
  await expect(page.locator("#use-context")).toBeVisible();
  await choose(page, "origin", "Start");
  await page.locator("#use-context").click();
  expect(requests).toBe(0);
  await plan(page);
  await page.locator("#adjust-route").click();
  await expect(page.locator("#use-context")).toBeHidden();
  await page.locator("#cancel-adjust").click();
  await page.locator("#close-route").click();
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({ status: 500, headers: cors }),
  );
  await choose(page, "destination", "Ziel");
  await expect(page.locator("#cancel")).toBeHidden();
  await page.locator("#adjust-route").click();
  await expect(page.locator("#use-context")).toBeHidden();
});

test("settings exit respects History and attempts once while preserving the old result and snapshot", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const before = await snapshot(page);
  let directRequests = 0;
  await page.route("**/api/v6/plan?*", (route) => {
    if (
      new URL(route.request().url()).searchParams.get("directModes") === "BIKE"
    )
      directRequests++;
    return route.fulfill({ status: 500, headers: cors });
  });
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  await page.locator("#tab-history").focus();
  await page.locator("#tab-history").press("Enter");
  await expect(page.locator("#history-view")).toBeVisible();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  expect(directRequests).toBe(1);
  await expect(page.locator("#tab-history")).toBeFocused();
  await page.locator("#tab-route").click();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#stale-notice")).toBeVisible();
  expect(directRequests).toBe(1);
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("240");
  expect(await snapshot(page)).toEqual(before);
});

test("offline settings keep the previous result and reconnect never starts planning", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const before = await snapshot(page);
  let directRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/v6/plan") &&
      new URL(request.url()).searchParams.get("directModes") === "BIKE"
    )
      directRequests++;
  });
  await page.context().setOffline(true);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("20");
  await page.locator("#tab-history").click();
  await expect(page.locator("#history-view")).toBeVisible();
  await expect(page.locator("#status")).toContainText(
    "Keine Internetverbindung",
  );
  await page.locator("#tab-route").click();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(
    page.locator(".route-choice[aria-pressed=true]"),
  ).not.toHaveAccessibleName(/über deinem Radlimit/);
  await expect(page.locator("#stale-notice")).toBeVisible();
  expect(await snapshot(page)).toEqual(before);
  await page.context().setOffline(false);
  await expect(page.locator("#connection")).toBeHidden();
  expect(directRequests).toBe(0);
  await page.locator("#refresh-route").click();
  await expectPlanningComplete(page);
  expect(directRequests).toBe(1);
  await expect(page.locator("#stale-notice")).toBeHidden();
});

test("archive edits have distinct browser history and retain their request on Back and Forward", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#close-route").click();
  await page.locator("#open-saved").click();
  const archive = await page.evaluate(() => ({
    state: history.state,
    url: location.href,
  }));
  await page.route("**/api/v6/plan?*", (route) =>
    route.fulfill({ status: 500, headers: cors }),
  );
  await page.locator("#tab-settings").click();
  await page.locator("#foldingDuration").fill("4");
  const edited = await page.evaluate(() => ({
    state: history.state,
    url: location.href,
  }));
  expect(edited.state.planId).not.toBe(archive.state.planId);
  expect(edited.state.historyId).toBeUndefined();
  await page.locator("#tab-history").click();
  await expect(page.locator("#status")).toContainText(
    "Anfrage nicht beantworten",
  );
  await page.locator("#tab-route").click();
  await page.goBack();
  await expect(page.locator("#history-view")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#settings-view")).toBeVisible();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  await page.goBack();
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("180");
  expect((await page.evaluate(() => history.state)).historyId).toBe(
    archive.state.historyId,
  );
  await page.goForward();
  await expect(page.locator("#foldingDuration")).toHaveValue("4");
  expect(new URL(page.url()).searchParams.get("foldingDuration")).toBe("240");
});

test("entry focus and archive timestamps remain stable without background focus changes", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  // Desktop empty-state focus stays on content when results arrive.
  await expect(page.locator("#panel-content")).toBeFocused();
  await page.locator("#close-route").click();
  await expect(page.locator("#destination")).toBeFocused();
  await page.locator("#tab-history").click();
  const timestamp = page.locator(".history-timestamp").first();
  const savedTime = await timestamp.getAttribute("datetime");
  await expect(timestamp).toContainText("Zuletzt geplant: 4. Sept., 10:00");
  await page.locator(".history-open").first().click();
  await expect(page.locator(".route-choice[aria-pressed=true]")).toBeFocused();
  await page.locator("#tab-history").focus();
  await page.locator("#tab-history").press("Enter");
  await expect(timestamp).toHaveAttribute("datetime", savedTime!);
  await expect(page.locator("#tab-history")).toBeFocused();
});

test("offline Back and Forward restore the matching old result with the edited request", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const before = await snapshot(page);
  await page.locator("#close-route").click();
  await page.locator("#open-saved").click();
  await page.context().setOffline(true);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("20");
  await page.locator("#tab-history").click();
  await expect(page.locator("#status")).toContainText(
    "Keine Internetverbindung",
  );
  await page.locator("#tab-route").click();
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("60");
  await page.goForward();
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("20");
  await page.goForward();
  await expect(page.locator("#history-view")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#stale-notice")).toBeVisible();
  await expect(page.locator("#cycling-comparison")).toBeHidden();
  await expect(page.locator("#status")).toContainText(
    "Keine Internetverbindung",
  );
  expect(new URL(page.url()).searchParams.get("maxCyclingMinutes")).toBe("20");
  expect(await snapshot(page)).toEqual(before);
  await page.context().setOffline(false);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition() {
          throw new Error("Archived start must remain fixed");
        },
      },
    }),
  );
  await page.locator("#replan-saved").click();
  await expectPlanningComplete(page);
  await expect(page.locator("#stale-notice")).toBeHidden();
  await expect
    .poll(async () => (await snapshot(page)).settings.maxCyclingMinutes)
    .toBe(20);
});

test("details opened before the first result hold that result as better options arrive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  let releaseFirst!: () => void, releaseOther!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const others = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  const direct = structuredClone(fixture.direct);
  direct.direct[0].endTime = direct.direct[0].legs[0].endTime =
    "2026-09-04T09:00:00Z";
  await page.route("**/api/v6/plan?*", async (route) => {
    const isDirect =
      new URL(route.request().url()).searchParams.get("directModes") === "BIKE";
    await (isDirect ? first : others);
    await route.fulfill({
      headers: cors,
      json: isDirect ? direct : fixture.multimodal,
    });
  });
  await choose(page, "destination", "Ziel");
  await resizeOverview(page);
  releaseFirst();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("1 h");
  releaseOther();
  await expectPlanningComplete(page);
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("1 h");
  await expect(page.locator("#better-connection")).toHaveCount(0);
  await page
    .locator(".route-choice")
    .filter({ hasText: "53 min" })
    .first()
    .click();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("53 min");
});

test("editing settings does not mark the original plan cache stale", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  const originalId = await page.evaluate(() => history.state.planId);
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/v6/plan")) requests++;
  });
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("20");
  expect(await page.evaluate(() => history.state.planId)).not.toBe(originalId);
  await page.goBack();
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue("60");
  expect(await page.evaluate(() => history.state.planId)).toBe(originalId);
  await expect(page.locator("#stale-notice")).toHaveJSProperty("hidden", true);
  await page.goBack();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#stale-notice")).toBeHidden();
  expect(requests).toBe(0);
});

test("clearing all local data also clears cached results from browser history", async ({
  page,
}) => {
  await setup(page);
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.locator("#clear-data").click();
  await page.locator("#confirm-delete-data").click();
  await expect(page.locator("#search-view")).toBeVisible();
  expect(await snapshot(page)).toBeUndefined();
  await page.context().setOffline(true);
  await page.goBack();
  await expect(page.locator("#settings-view")).toBeVisible();
  await page.locator("#tab-route").click();
  await expect(page.locator("#map-view")).toBeVisible();
  await expect(page.locator(".route-choice")).toHaveCount(0);
  await expect(page.locator("#open-saved")).toBeHidden();
  expect(await snapshot(page)).toBeUndefined();
});

for (const succeeds of [true, false])
  test(`unfinished settings survive Back and Forward and are consumed once, succeeds=${succeeds}`, async ({
    page,
  }) => {
    await setup(page);
    await plan(page);
    let calculations = 0;
    page.on("request", (request) => {
      if (request.url().includes("directModes=BIKE")) calculations++;
    });
    if (!succeeds)
      await page.route("**/api/v6/plan?*", (route) =>
        route.fulfill({ status: 500, headers: cors }),
      );
    await page.locator("#tab-settings").click();
    await page.locator("#foldingDuration").fill("4");
    await page.goBack();
    await expect(page.locator("#foldingDuration")).toHaveValue("3");
    expect(calculations).toBe(0);
    await page.goForward();
    await expect(page.locator("#foldingDuration")).toHaveValue("4");
    expect(calculations).toBe(0);
    await page.locator("#save-settings").click();
    if (succeeds) await expectPlanningComplete(page);
    else
      await expect(page.locator("#status")).toContainText(
        "Anfrage nicht beantworten",
      );
    expect(calculations).toBe(1);
    await page.goBack();
    await page.goBack();
    await expect(page.locator("#foldingDuration")).toHaveValue("3");
    await page.goForward();
    await expect(page.locator("#foldingDuration")).toHaveValue("4");
    await page.locator("#save-settings").click();
    await expect(page.locator("#map-view")).toBeVisible();
    await expect(page.locator("#cancel")).toBeHidden();
    expect(calculations).toBe(1);
  });
