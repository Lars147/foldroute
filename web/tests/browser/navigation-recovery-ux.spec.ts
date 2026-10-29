import { test, expect, type Page } from "./test";
import { defaults } from "../../src/model";
import { expectMotionSettled, showMap } from "./assertions";
import { expectRouteFits } from "./planner-fixture";
import {
  setup,
  route,
  complete,
  savedActive,
  savedProgress,
  startSelected,
} from "./navigation-fixture";

async function expectOverview(page: Page) {
  await expect(page.locator("#navigation-view")).toBeHidden();
  await expect(page.locator("#map-view")).toBeVisible();
  const mobile = page.viewportSize()!.width < 900;
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    mobile ? "map" : "desktop",
  );
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator(".app-tabs")).toBeVisible();
  if (mobile) {
    await expect(page.locator("#map-preview")).toBeVisible();
    await expect(page.locator("#panel-details")).toBeHidden();
    await expect(page.locator("#result-back")).toHaveText("Alternativen");
  } else await expect(page.locator("#panel-details")).toBeVisible();
  expect(await page.evaluate(() => history.state.navigation)).toBeUndefined();
  expect(
    await page.evaluate(() => history.state.journeyNavigation.screen),
  ).toBe("map");
}

for (const width of [390, 1280])
  test(`ending confirmation preserves progress and restores focus at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await setup(page);
    await expect.poll(() => savedActive(page)).toBe(true);
    const progress = await savedProgress(page);
    const end = page.locator("#navigation-end");
    const dialog = page.getByRole("dialog", { name: "Navigation beenden?" });
    const keepGoing = dialog.getByRole("button", { name: "Weiter navigieren" });
    const finish = dialog.getByRole("button", { name: "Beenden", exact: true });
    await end.focus();
    await end.press("Enter");
    await expect(dialog).toHaveAccessibleDescription(
      "Die Route bleibt verfügbar.",
    );
    await expect(keepGoing).toBeFocused();
    await expect(finish).toBeVisible();
    await expectMotionSettled(dialog);
    const bounds = (await dialog.boundingBox())!;
    if (width < 900) {
      expect(844 - bounds.y - bounds.height).toBeCloseTo(12, 0);
      expect((await keepGoing.boundingBox())!.y).toBeLessThan(
        (await finish.boundingBox())!.y,
      );
    } else {
      expect(bounds.y + bounds.height / 2).toBeCloseTo(422, 0);
      expect((await keepGoing.boundingBox())!.x).toBeLessThan(
        (await finish.boundingBox())!.x,
      );
    }
    await page.screenshot({
      path: test.info().outputPath("end-confirmation.png"),
    });
    // Enter initially continues instead of ending the active navigation.
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(end).toBeFocused();
    await end.press("Enter");
    await keepGoing.click();
    await expect(dialog).toBeHidden();
    await expect(end).toBeFocused();
    await end.press("Enter");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(end).toBeFocused();
    expect(await savedProgress(page)).toEqual(progress);
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
    await end.press("Enter");
    // The native modal keeps underlying controls inert in both browsers.
    await end.evaluate((element) => element.focus());
    await expect(keepGoing).toBeFocused();
    await finish.focus();
    await expect(finish).toBeFocused();
    await finish.press("Enter");
    await expect(page.locator("#navigation-view")).toBeHidden();
    await expect.poll(() => savedActive(page)).toBe(false);
    await expect(page.locator("#map-view")).toBeVisible();
    await expect(page.locator("#navigation-start")).toBeFocused();
    await expect(page.locator("#navigation-start")).toHaveText("Los");
    await expect(page.locator("#saved-notice")).toBeHidden();
    await expectOverview(page);
  });

test("ending navigation refits the overview and keeps details, alternatives and restart usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, false, false);
  await showMap(page);
  await page.locator("#map-location").click();
  await page.clock.runFor(1000);
  await page.locator("#map-controls .leaflet-control-zoom-in").click();
  await page.clock.runFor(1000);
  await startSelected(page);
  await expect(page.locator("#navigation-view")).toBeVisible();
  let searches = 0;
  page.on("request", (request) => {
    if (request.url().includes("/v6/plan")) searches++;
  });
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-start")).toBeFocused();
  await expectOverview(page);
  await page.clock.runFor(1000);
  await expect(page.locator("#map .route-marker")).toHaveCount(2);
  await expectRouteFits(page);
  await page.screenshot({
    path: test.info().outputPath("return-overview.png"),
  });
  await page.locator("#map-open-details").click();
  await expect(page.locator("#panel-details")).toBeVisible();
  await showMap(page);
  await expectOverview(page);
  await page.locator("#result-back").click();
  await expect(page.locator("#alternatives-dialog")).toBeVisible();
  await expect(page.locator('.route-choice[aria-pressed="true"]')).toHaveCount(
    1,
  );
  await page.locator("#alternatives-close").click();
  await expect(page.locator("#alternatives-dialog")).toBeHidden();
  await expectOverview(page);
  await startSelected(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  expect(searches).toBe(0);
});

for (const failure of ["offline", "storage"] as const)
  test(`ending navigation retains Los and the selected route despite ${failure}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await expect.poll(() => savedActive(page)).toBe(true);
    let searches = 0;
    page.on("request", (r) => {
      if (r.url().includes("/v6/plan")) searches++;
    });
    if (failure === "offline") await context.setOffline(true);
    else
      await page.evaluate(async () => {
        const path = "/src/navigation-store.ts";
        const { NavigationStore } = await import(path);
        NavigationStore.prototype.clear = async () => {
          throw new Error("Storage unavailable");
        };
      });
    await page.locator("#navigation-end").click();
    await page.locator("#navigation-confirm-yes").click();
    await expect(page.locator("#navigation-start")).toBeFocused();
    await expect(page.locator("#navigation-start")).toBeEnabled();
    await expect(page.locator("#navigation-start")).toHaveText("Los");
    await expectOverview(page);
    await expect(page.locator("#saved-notice")).toBeHidden();
    await expect(page.locator("#result-stand")).toContainText(
      "Stand: 6. Okt., 12:00",
    );
    if (failure === "storage")
      await expect(page.locator("#toast")).toContainText(
        "Gespeicherter Zustand konnte nicht gelöscht werden",
      );
    else {
      await expect.poll(() => savedActive(page)).toBe(false);
      await page.locator("#navigation-start").click();
      await expect(page.locator("#navigation-instruction")).toHaveText(
        "Links abbiegen auf Zweite Straße",
      );
    }
    expect(searches).toBe(0);
  });

test("browser back dismisses an open navigation confirmation without losing progress", async ({
  page,
}) => {
  await setup(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  const progress = await savedProgress(page);
  const historyLength = await page.evaluate(() => history.length);
  const end = page.locator("#navigation-end");
  const dialog = page.locator("#navigation-confirm");
  await end.focus();
  await page.goBack();
  await expect(dialog).toBeVisible();
  await expect(page.locator("#navigation-confirm-no")).toBeFocused();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(end).toBeFocused();
  await end.press("Enter");
  await page.goBack();
  await expect(dialog).toBeHidden();
  await expect(end).toBeFocused();
  await page.goBack();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(await savedProgress(page)).toEqual(progress);
  await expect(page.locator("#navigation-view")).toBeVisible();
});

for (const width of [390, 1280])
  test(`manual completion offers only undo and restores saved progress at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, true);
    const before = await savedProgress(page);
    if (width < 900) await page.locator("#navigation-details-toggle").click();
    const completeSection = page.locator("#navigation-complete");
    await completeSection.focus();
    await completeSection.press("Enter");
    await expect(page.locator("#navigation-confirm")).toBeHidden();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Rad jetzt falten",
    );
    const undo = page.getByRole("button", { name: "Rückgängig", exact: true });
    await expect(undo).toBeInViewport();
    expect(await page.locator("#navigation-undo").innerText()).toBe(
      "Rückgängig",
    );
    expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      await undo.evaluate((button) => button.closest("#navigation-panel")),
    ).toBeNull();
    await expectMotionSettled(page.locator("#navigation-undo"));
    await expectMotionSettled(page.locator("#navigation-panel"));
    const toastBounds = (await page.locator("#navigation-undo").boundingBox())!;
    const panelBounds = (await page
      .locator("#navigation-panel")
      .boundingBox())!;
    expect(panelBounds.y - toastBounds.y - toastBounds.height).toBeCloseTo(
      12,
      0,
    );
    expect(toastBounds.x + toastBounds.width / 2).toBeCloseTo(width / 2, 0);

    if (width < 900) await page.locator("#navigation-details-toggle").click();
    await expect(undo).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("navigation-undo.png"),
    });
    await undo.click();
    await expect(undo).toBeHidden();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
    await expect.poll(() => savedProgress(page)).toEqual(before);
    await page.reload();
    await page.locator("#navigation-resume").click();
    await expect(page.locator("#navigation-instruction")).toHaveText(
      "Links abbiegen auf Zweite Straße",
    );
    await expect(page.locator("#navigation-undo")).toBeHidden();
  });

test("undo expires after eight seconds and pauses for focus and mouse hover", async ({
  page,
}) => {
  await setup(page, true);
  await complete(page);
  const undo = page.locator("#navigation-undo-button");
  const bar = page.locator("#navigation-undo .toast-countdown-fill");
  await expect(bar).toHaveCSS("animation-duration", "8s");
  await undo.focus();
  await expect(bar).toHaveCSS("animation-play-state", "paused");
  await page.clock.runFor(9000);
  await expect(undo).toBeVisible();
  await undo.hover();
  await page.locator("#navigation-audio").focus();
  await page.clock.runFor(9000);
  await expect(undo).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(bar).toHaveCSS("animation-play-state", "running");
  await page.clock.runFor(8000);
  await expect(undo).toBeHidden();
});

test("double click completes one section and arrival has no undo or confirmation", async ({
  page,
}) => {
  const journey = route(true);
  journey.legs = journey.legs.slice(0, 5);
  journey.destination = journey.legs.at(-1)!.to;
  journey.arrival = journey.legs.at(-1)!.end;
  await setup(page, true, true, {}, journey);
  await page.locator("#navigation-complete").dblclick();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
  await page.clock.runFor(400);
  await complete(page);
  await complete(page);
  await complete(page);
  await complete(page);
  await expect(page.locator("#navigation-finish")).toBeVisible();
  await expect(page.locator("#navigation-confirm")).toBeHidden();
  await expect(page.locator("#navigation-undo")).toBeHidden();
});

for (const [width, height, largeText] of [
  [320, 320, true],
  [844, 390, false],
] as const)
  test(`ending confirmation remains usable at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: Math.max(height, 568) });
    await setup(page);
    await page.locator("#navigation-end").click();
    // Resize an open dialog, including enlarged text in a very short viewport.
    await page.setViewportSize({ width, height });
    if (largeText)
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
    await page.clock.runFor(200);
    const dialog = page.locator("#navigation-confirm");
    await expect(page.locator("#navigation-confirm-no")).toBeFocused();
    await expect
      .poll(async () => {
        const bounds = (await dialog.boundingBox())!;
        return bounds.y + bounds.height;
      })
      .toBeCloseTo(height - 12, 0);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(12);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 11);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    for (const id of ["navigation-confirm-no", "navigation-confirm-yes"]) {
      const button = page.locator(`#${id}`);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.locator("#navigation-confirm-no").scrollIntoViewIfNeeded();
    await page.locator("#navigation-confirm-no").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#navigation-view")).toBeVisible();
  });
test("completes a multimodal journey with live platform, stop confirmation and waiting", async ({
  page,
}) => {
  await setup(page, true);
  await expect(page.locator("#navigation-transit-status")).toBeEmpty();
  await expect(page.locator("#navigation-context-detail")).toContainText(
    "Gleis 4",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt falten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText(
    "S1 Richtung Altstadt",
  );
  await expect(page.locator("#navigation-detail")).toBeEmpty();
  await expect(page.locator("#navigation-transit-status")).toBeEmpty();
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Rad jetzt entfalten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText("Zu Fuß");
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Zwischenziel erreicht",
  );
  await page.locator("#navigation-complete").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Auf Weiterfahrt warten",
  );
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toContainText(
    "Nach Ziel",
  );
  expect(
    await page.evaluate(() => (window as any).navProbe.spoken as string[]),
  ).toContain("Mit dem Rad nach Ziel");
  await complete(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Ziel erreicht",
  );
});
test("browser back confirms ending and storage opt-out prevents recovery", async ({
  page,
}) => {
  await setup(page);
  await page.goBack();
  await expect(page.locator("#navigation-confirm")).toBeVisible();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-start")).toBeFocused();
  await expectOverview(page);
  await page.locator("#tab-settings").click();
  await page.locator("#navigation-storage-enabled").uncheck();
  await page.locator("#tab-route").click();
  await startSelected(page);
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  expect(await savedActive(page)).toBe(false);
});

test("navigation remains resumable with route history disabled", async ({
  page,
}) => {
  await setup(page);
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#navigation-storage-enabled")).toBeChecked();
  await page.locator("#tab-route").click();
  await startSelected(page);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.reload();
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
});

test("ending resumed navigation restores stops without replacing personal preferences", async ({
  page,
}) => {
  await setup(page, true);
  await expect.poll(() => savedActive(page)).toBe(true);
  await page.evaluate(async (defaults) => {
    const { NavigationStore } = await import("/src/navigation-store.ts");
    const store = new NavigationStore();
    const snapshot = (await store.read())!;
    snapshot.settings = {
      ...defaults,
      cyclingSpeedKilometersPerHour: 21,
      maxCyclingMinutes: 45,
    };
    await store.save(snapshot);
    localStorage.setItem("foldroute.routing.v3", JSON.stringify(defaults));
  }, defaults);
  await page.goto("/");
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-instruction")).toHaveText(
    "Links abbiegen auf Zweite Straße",
  );
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#navigation-view")).toBeHidden();
  await expectOverview(page);
  await page.locator("#adjust-route").click();
  await expect(page.locator("#origin")).toHaveValue("Start");
  await expect(page.locator("#destination")).toHaveValue("Ziel");
  await expect(page.locator(".stop-editor-row:visible")).toHaveCount(1);
  await expect(page.locator("#via-0")).toHaveValue("Café");
  await page.locator("#cancel-adjust").click();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#cyclingSpeedKilometersPerHour")).toHaveValue(
    String(defaults.cyclingSpeedKilometersPerHour),
  );
  await expect(page.locator("#maxCyclingMinutes")).toHaveValue(
    String(defaults.maxCyclingMinutes),
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toEqual(defaults);
  await page.locator("#tab-route").click();
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({ json: { direct: [], itineraries: [] } }),
  );
  const planned = page.waitForRequest("**/api/v6/plan?*");
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  const params = new URL((await planned).url()).searchParams;
  expect(params.get("cyclingSpeed")).toBe(
    (defaults.cyclingSpeedKilometersPerHour / 3.6).toFixed(3),
  );
});

for (const width of [390, 1280])
  for (const reducedMotion of ["no-preference", "reduce"] as const)
    test(`undo remains centered throughout entry at ${width} with ${reducedMotion}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ reducedMotion });
      await setup(page, true);
      if (width < 900) await page.locator("#navigation-details-toggle").click();
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.evaluate(() => {
          const samples: { center: number; animated: boolean }[] = [];
          (window as unknown as { undoFrames: typeof samples }).undoFrames =
            samples;
          const toast = document.getElementById("navigation-undo")!;
          document.getElementById("navigation-complete")!.addEventListener(
            "click",
            () => {
              const started = performance.now();
              const sample = () => {
                if (toast.hidden) return;
                const bounds = toast.getBoundingClientRect();
                samples.push({
                  center: bounds.x + bounds.width / 2,
                  animated: toast
                    .getAnimations()
                    .some((animation) => animation.playState === "running"),
                });
                if (performance.now() - started < 500)
                  requestAnimationFrame(sample);
              };
              queueMicrotask(sample);
            },
            { once: true },
          );
        });
        await page.locator("#navigation-complete").click();
        await page.clock.runFor(600);
        const frames = await page.evaluate(
          () =>
            (
              window as unknown as {
                undoFrames: { center: number; animated: boolean }[];
              }
            ).undoFrames,
        );
        expect(frames.length).toBeGreaterThan(3);
        expect(
          Math.max(
            ...frames.map((frame) => Math.abs(frame.center - width / 2)),
          ),
        ).toBeLessThanOrEqual(1);
        expect(frames.some((frame) => frame.animated)).toBe(
          reducedMotion === "no-preference",
        );
        await expectMotionSettled(page.locator("#navigation-undo"));
        const bounds = (await page.locator("#navigation-undo").boundingBox())!;
        expect(bounds.x + bounds.width / 2).toBeCloseTo(width / 2, 0);
        await page.locator("#navigation-undo-button").click();
        await expect(page.locator("#navigation-undo")).toBeHidden();
      }
    });
