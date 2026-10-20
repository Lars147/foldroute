import { expect, test, type Page } from "@playwright/test";
import recording from "../../src/data/bike-transfer.json" with { type: "json" };
import type { RouteRequest } from "../../src/model";
import { routeURL } from "../../src/route-url";
import {
  expectMotionSettled,
  openSelectedDetails,
  showMap,
  showConnections,
} from "./assertions";
import { expectRouteFitUnchanged } from "./planner-fixture";

// Keep the real application/session/view and control only the planner stream.
// The stream deliberately allows a late response after its signal is aborted.
async function open(page: Page, clock = false) {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.route("**/api/v1/reverse-geocode?*", (route) =>
    route.fulfill({
      json: [],
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
  await page.route("**/src/planner.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: [
        'import { exampleRecording } from "/src/example-data.ts";',
        "export async function* planRoutes(request, settings, signal, client) {",
        "  window.searchControlRuns = (window.searchControlRuns ?? 0) + 1;",
        "  const queue = []; let wake;",
        "  const control = window.searchControl = {",
        "    aborted: false, publish(event) { queue.push(event); wake?.(); }",
        "  };",
        '  signal.addEventListener("abort", () => { control.aborted = true; }, { once: true });',
        '  yield { journeys: [], status: "searching", phase: "base", incompletePhases: [], issues: [] };',
        "  while (true) {",
        "    if (!queue.length) await new Promise(resolve => { wake = resolve; });",
        "    const event = queue.shift(); wake = undefined;",
        "    if (event.error) throw new Error(event.error);",
        "    if (event.retryAt) client.retryAt = event.retryAt;",
        "    const journeys = (event.ids ?? []).map((id, index) => ({",
        "      ...structuredClone(exampleRecording.journey), id,",
        "      arrival: exampleRecording.journey.arrival + index * 60,",
        "      legs: exampleRecording.journey.legs.map((leg, legIndex) => ({ ...leg,",
        "        coordinates: event.detourIds?.includes(id) && legIndex === 0",
        "          ? [...leg.coordinates, { latitude: exampleRecording.journey.origin.latitude - 0.3, longitude: exampleRecording.journey.origin.longitude }]",
        "          : leg.coordinates",
        "      }))",
        "    }));",
        '    yield { issues: [], incompletePhases: [], status: "searching", ...event, journeys };',
        '    if (event.status === "complete" || event.status === "partial") return;',
        "  }",
        "}",
      ].join("\n"),
    }),
  );
  const url = routeURL(new URL("http://localhost/"), {
    request: recording.request as RouteRequest,
  });
  const time = new Date(recording.journey.departure * 1000 - 60_000);
  if (clock) await page.clock.install({ time });
  else await page.clock.setFixedTime(time);
  await page.goto(url.pathname + url.search);
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await expect(page.locator("#status")).toHaveText(
    "Verbindungen werden gesucht …",
  );
}

async function publish(
  page: Page,
  event: {
    phase: string;
    ids?: string[];
    detourIds?: string[];
    status?: string;
    incompletePhases?: string[];
    issues?: string[];
    retryAt?: number;
    error?: string;
  },
) {
  await page.evaluate(
    (event) => (window as any).searchControl.publish(event),
    event,
  );
}

for (const status of ["searching", "complete"] as const) {
  test(`mobile results skip visual readiness when search is ${status}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, true);
    await page.evaluate(() => {
      (window as any).toastStages = [];
      new MutationObserver((records) => {
        for (const record of records)
          if (record.attributeName === "data-planning-stage")
            (window as any).toastStages.push(record.oldValue);
      }).observe(document.getElementById("toast")!, {
        attributes: true,
        attributeOldValue: true,
      });
    });
    await publish(page, { phase: "base", ids: ["first"], status });
    const toast = page.locator("#toast");
    await expect(page.locator("#map-preview-summary")).toBeVisible();
    if (status === "complete") await expect(toast).toBeHidden();
    else
      await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);
    await expect(page.locator("#planning-announcement")).toHaveText(
      "Verbindungen gefunden",
    );
    expect(
      await page.evaluate(() => (window as any).toastStages),
    ).not.toContain("ready");
    await showConnections(page);
    await openSelectedDetails(page);
    await showMap(page);
    await page.setViewportSize({ width: 1280, height: 844 });
    if (status === "complete") await expect(toast).toBeHidden();
    else
      await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
  });
}

for (const [width, height, fontSize] of [
  [320, 844, 16],
  [390, 844, 16],
  [844, 390, 16],
  [320, 568, 32],
]) {
  test(`mobile map toasts stay above the route panel at ${width}x${height} with ${fontSize}px text`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await open(page, true);
    await page.evaluate((fontSize) => {
      const style = document.documentElement.style;
      style.fontSize = `${fontSize}px`;
      for (const edge of ["top", "left", "right", "bottom"])
        style.setProperty(`--safe-${edge}`, edge === "top" ? "24px" : "8px");
    }, fontSize);
    await publish(page, { phase: "bike-transfers", ids: ["first"] });
    const toast = page.locator("#toast");
    await expect(toast).toHaveText("Optimierung läuft …");
    await expectFeedbackPosition(page, width);
    await expect(page.locator("#map-error")).toBeVisible();
    const panel = page.locator("#journey-panel");
    const panelHeight = (await panel.boundingBox())!.height;
    await publish(page, {
      phase: "bike-transfers",
      ids: ["first"],
      status: "complete",
    });
    await expect(toast).toBeHidden();
    await expect
      .poll(async () => (await panel.boundingBox())!.height)
      .toBe(panelHeight);
    await page.locator("#route-more").click();
    await page.locator("#share-plan").click();
    await expect(toast).toHaveText("Planungslink kopiert.");
    await expectFeedbackPosition(page, width);
    expect((await panel.boundingBox())!.height).toBe(panelHeight);
    await expect(toast.locator(".toast-countdown")).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("map-toast-top.png") });
    await page.clock.fastForward(6001);
    await expect(toast).toBeHidden();
  });
}

test("map error toast follows the offline banner and keeps retry reachable with large text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "24px";
    document.documentElement.style.setProperty("--safe-top", "24px");
  });
  await publish(page, {
    phase: "walking",
    ids: ["first"],
    status: "partial",
    incompletePhases: ["walking"],
    issues: ["Der Dienst hat nicht rechtzeitig geantwortet."],
  });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "error",
  );
  await expectFeedbackPosition(page, 390);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.locator("#connection")).toBeVisible();
  await expectFeedbackPosition(page, 390);
  const banner = (await page.locator("#connection").boundingBox())!;
  const toast = (await page.locator("#toast").boundingBox())!;
  expect(toast.y).toBeGreaterThanOrEqual(banner.y + banner.height + 12);
  await expect(page.locator("#toast #recover-planning")).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.locator("#connection")).toBeHidden();
  await expectFeedbackPosition(page, 390);
  await page.locator("#toast #recover-planning").click();
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
});

test("finished optimization drops discarded detours before the route-fit button is clicked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 425, height: 812 });
  await open(page);
  await publish(page, {
    phase: "bike-transfers",
    ids: ["first", "detour"],
    detourIds: ["detour"],
  });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await expectRouteFitUnchanged(page);
  await publish(page, {
    phase: "bike-transfers",
    ids: ["first"],
    status: "complete",
  });
  await expect(page.locator("#toast")).toBeHidden();
  await expectRouteFitUnchanged(page);
});

test("first current link result opens the map once and preserves explicit choices during optimization", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  await publish(page, {
    phase: "bike-transfers",
    ids: ["first", "alternative"],
  });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator("#map-preview-summary")).toBeVisible();
  await showConnections(page);
  await page.locator('[data-journey="alternative"]').click();
  await publish(page, {
    phase: "bike-transfers",
    ids: ["improved", "first", "alternative"],
  });
  await expect(page.locator('[data-journey="improved"]')).toBeAttached();
  await expect(page.locator("#choices")).toBeVisible();
  await expect(page.locator('[data-journey="alternative"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await openSelectedDetails(page);
  await publish(page, {
    phase: "bike-transfers",
    ids: ["improved", "first", "alternative"],
    status: "complete",
  });
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#panel-details")).toBeVisible();
  await expect(page.locator('[data-journey="alternative"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("refresh opens the map only for current results and respects navigation while waiting", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await publish(page, { phase: "base", ids: ["original"], status: "complete" });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  const refresh = async (run: number) => {
    await page.locator("#route-more").click();
    await page.locator("#refresh-route").click();
    await expect
      .poll(() => page.evaluate(() => (window as any).searchControlRuns))
      .toBe(run);
    await expect(page.locator("#map-view")).toHaveAttribute(
      "data-result-screen",
      "list",
    );
    await expect(page.locator("#stale-notice")).toBeVisible();
  };
  await refresh(2);
  await publish(page, { phase: "base", ids: ["fresh"], status: "complete" });
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "map",
  );
  await expect(page.locator('[data-journey="fresh"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await refresh(3);
  await publish(page, { phase: "base", error: "Verbindung fehlgeschlagen" });
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "list",
  );
  await expect(page.locator("#stale-notice")).toBeVisible();
  await page.locator("#recover-planning").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).searchControlRuns))
    .toBe(4);
  await openSelectedDetails(page);
  await publish(page, { phase: "base", ids: ["latest"], status: "complete" });
  await expect(page.locator('[data-journey="latest"]')).toBeAttached();
  await expect(page.locator("#map-view")).toHaveAttribute(
    "data-result-screen",
    "detail",
  );
});

async function expectFeedbackPosition(page: Page, width: number) {
  await expectMotionSettled(page.locator("#toast"));
  await expect(async () => {
    const geometry = await page.evaluate(() => {
      const feedback = document.getElementById("toast")!;
      const toast = feedback.getBoundingClientRect();
      const panel = document
        .getElementById("journey-panel")!
        .getBoundingClientRect();
      const controls = document
        .getElementById("map-controls")!
        .getBoundingClientRect();
      const map = document.getElementById("map-view")!;
      const content = document.getElementById(
        map.dataset.resultScreen === "map"
          ? "map-preview-summary"
          : map.dataset.resultScreen === "detail"
            ? "panel-details"
            : "choices",
      )!;
      return {
        left: toast.left,
        right: toast.right,
        top: toast.top,
        bottom: toast.bottom,
        panelRight: panel.right,
        panelTop: panel.top,
        controlsLeft: controls.left,
        controlsTop: controls.top,
        sidePanel:
          getComputedStyle(map)
            .getPropertyValue("--map-panel-layout")
            .trim() === "side",
        mapTop: map.getBoundingClientRect().top,
        inline: feedback.parentElement?.id === "planning-feedback-slot",
        inlineParent: feedback.parentElement?.parentElement?.id,
        position: getComputedStyle(feedback).position,
        contentTop: content.getBoundingClientRect().top,
        screen: map.dataset.resultScreen,
        viewport: innerWidth,
      };
    });
    if (width >= 900 || geometry.screen === "map") {
      expect(geometry.inline).toBe(false);
      expect(geometry.position).toBe("fixed");
      expect(geometry.left).toBeGreaterThanOrEqual(
        width >= 900 || geometry.sidePanel ? geometry.panelRight + 11 : 15,
      );
      expect(geometry.right).toBeLessThanOrEqual(geometry.controlsLeft - 11);
      if (width >= 900) {
        expect((geometry.left + geometry.right) / 2).toBeCloseTo(
          (geometry.panelRight + geometry.controlsLeft) / 2,
          0,
        );
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.mapTop + 11);
      } else {
        expect((geometry.left + geometry.right) / 2).toBeCloseTo(
          ((geometry.sidePanel ? geometry.panelRight : 0) + geometry.viewport) /
            2,
          0,
        );
        expect(geometry.top).toBeCloseTo(geometry.controlsTop, 0);
        if (!geometry.sidePanel)
          expect(geometry.bottom).toBeLessThanOrEqual(geometry.panelTop - 11);
      }
    } else {
      expect(geometry.inline).toBe(true);
      expect(geometry.position).toBe("relative");
      expect(geometry.inlineParent).toBe(
        geometry.screen === "map" ? "map-preview" : "panel-content",
      );
      expect(geometry.left).toBeGreaterThanOrEqual(15);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 15);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.contentTop + 1);
    }
  }).toPass({ timeout: 5000 });
}

async function expectRetryIcon(page: Page) {
  const toast = page.locator("#toast");
  await expect(toast.locator(".toast-countdown")).toHaveCount(0);
  const warning = toast.locator(".planning-toast-warning");
  const dark =
    (await page.locator("html").getAttribute("data-theme")) === "dark";
  const warningColor = dark ? "rgb(255, 209, 138)" : "rgb(138, 75, 8)";
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("aria-hidden", "true");
  await expect(warning).toHaveCSS("color", warningColor);
  await expect(toast).toHaveCSS("border-top-color", warningColor);
  await expect(toast).toHaveCSS("border-top-width", "1px");
  await expect(toast).toHaveCSS(
    "background-color",
    dark ? "rgb(23, 26, 28)" : "rgb(245, 246, 243)",
  );
  await expect(toast).toHaveCSS(
    "color",
    dark ? "rgb(245, 246, 243)" : "rgb(23, 26, 28)",
  );
  const retry = page.locator("#toast #recover-planning");
  await expect(retry).toHaveAccessibleName("Erneut versuchen");
  await expect(retry).toHaveAttribute("title", "Erneut versuchen");
  await expect(retry.locator("#recovery-label")).toHaveClass("sr-only");
  await expect(retry.locator("svg")).toBeVisible();
  await expect(retry).toHaveCSS("text-decoration-line", "none");
  const geometry = await retry.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const icon = button.querySelector("svg")!.getBoundingClientRect();
    const message = document
      .querySelector("#toast .planning-toast-message")!
      .getBoundingClientRect();
    const warning = document
      .querySelector("#toast .planning-toast-warning")!
      .getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      left: bounds.left,
      center: (bounds.top + bounds.bottom) / 2,
      messageRight: message.right,
      messageLeft: message.left,
      messageCenter: (message.top + message.bottom) / 2,
      warningRight: warning.right,
      warningCenter: (warning.top + warning.bottom) / 2,
      iconWidth: icon.width,
      iconHeight: icon.height,
    };
  });
  // WebKit can round transformed bounds a few millionths of a pixel below 44.
  expect(geometry.width).toBeGreaterThanOrEqual(44 - 0.01);
  expect(geometry.height).toBeGreaterThanOrEqual(44 - 0.01);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.messageRight + 7);
  expect(geometry.messageLeft).toBeGreaterThanOrEqual(
    geometry.warningRight + 7,
  );
  expect(geometry.warningCenter).toBeCloseTo(geometry.messageCenter, 0);
  expect(geometry.center).toBeCloseTo(geometry.messageCenter, 0);
  expect(geometry.iconWidth).toBeCloseTo(20, 2);
  expect(geometry.iconHeight).toBeCloseTo(20, 2);
}

async function expectCountdownAt(
  page: Page,
  duration: number,
  elapsed: number,
) {
  const countdown = page.locator("#toast .toast-countdown");
  await expect(countdown).toBeVisible();
  await expect(countdown).toHaveAttribute("aria-hidden", "true");
  const geometry = await countdown.locator(".toast-countdown-fill").evaluate(
    (fill, { duration, elapsed }) => {
      const animation = fill.getAnimations()[0];
      if (!animation?.effect)
        throw new Error("Toast countdown animation missing");
      animation.pause();
      const timing = animation.effect.getTiming();
      animation.currentTime = duration * elapsed + timing.delay;
      const track = fill.parentElement!.getBoundingClientRect();
      const bounds = fill.getBoundingClientRect();
      const toast = fill.closest("#toast")!.getBoundingClientRect();
      return {
        duration: timing.duration,
        easing: timing.easing,
        remaining: bounds.width / track.width,
        origin: bounds.left - track.left,
        height: track.height,
        left: track.left - toast.left,
        right: toast.right - track.right,
        bottom: toast.bottom - track.bottom,
      };
    },
    { duration, elapsed },
  );
  expect(geometry.duration).toBe(duration);
  expect(geometry.easing).toBe("linear");
  expect(geometry.remaining).toBeCloseTo(1 - elapsed, 2);
  expect(geometry.origin).toBeCloseTo(0, 2);
  expect(geometry.height).toBeCloseTo(2, 2);
  // Insets include the toast's one-pixel border.
  expect(geometry.left).toBeCloseTo(15, 2);
  expect(geometry.right).toBeCloseTo(15, 2);
  expect(geometry.bottom).toBeCloseTo(5, 2);
}

for (const width of [320, 390, 1280])
  test(
    "planning feedback keeps results usable at " + width + "px",
    async ({ page }, info) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({
        colorScheme: width === 390 ? "dark" : "light",
        reducedMotion: width === 320 ? "reduce" : "no-preference",
      });
      await open(page);
      if (width === 320)
        await page.addStyleTag({ content: "html { font-size: 24px; }" });
      const toast = page.locator("#toast");
      await expect(toast).toHaveText("Verbindungen werden gesucht …");
      await expect(toast).toHaveAttribute("data-planning-stage", "searching");
      await expect(toast.locator(".toast-countdown")).toHaveCount(0);
      await expect(page.locator("#status")).toBeHidden();
      await expect(page.locator("#planning-ready")).toHaveCount(0);
      await publish(page, { phase: "base", ids: ["first", "chosen"] });
      await expect(toast).toHaveText(
        width < 900 ? "Optimierung läuft …" : "Verbindungen gefunden",
      );
      await expect(toast).toHaveAttribute(
        "data-planning-stage",
        width < 900 ? "optimizing" : "ready",
      );
      const countdown = toast.locator(".toast-countdown");
      if (width < 900) await expect(countdown).toHaveCount(0);
      else await expect(countdown).toBeVisible();
      await expectFeedbackPosition(page, width);
      await expect(page.locator("#toast .icon")).toHaveCount(
        width < 900 ? 0 : 1,
      );
      await expect(page.locator("#status")).toBeEmpty();
      await expect(page.locator("#journey-panel")).not.toHaveClass(
        /is-loading/,
      );
      await expect(page.locator("#navigation-start")).toBeEnabled();
      await page.screenshot({
        path: info.outputPath("search-results-feedback.png"),
      });
      await showConnections(page);
      await page.locator('.route-choice[data-journey="chosen"]').click();
      await openSelectedDetails(page);
      await expect(page.locator("#panel-details")).toContainText("S8");
      await page.evaluate(() => {
        (window as any).toastMutations = 0;
        new MutationObserver((records) => {
          (window as any).toastMutations += records.length;
        }).observe(document.getElementById("toast")!, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      const control = page.locator(
        width >= 900 ? "#route-more" : "#panel-map-toggle",
      );
      await control.focus();
      for (const phase of ["bike-transfers", "walking", "via"]) {
        await publish(page, { phase, ids: ["optimized"] });
        await expect(toast).toHaveAttribute(
          "data-planning-stage",
          width < 900 ? "optimizing" : "ready",
        );
        await expect(control).toBeFocused();
        await expect(
          page.locator('.route-choice[aria-pressed="true"]'),
        ).toHaveAttribute("data-journey", "chosen");
        await expect(page.locator("#panel-details")).toBeVisible();
      }
      await showMap(page);
      await expectFeedbackPosition(page, width);
      expect(await page.evaluate(() => (window as any).toastMutations)).toBe(0);
      await expect(page.locator("#toast .planning-toast-spinner")).toHaveCount(
        width < 900 ? 1 : 0,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath("search-feedback.png") });
      if (width < 900) await page.locator("#result-back").click();
      await page.locator("#close-route").click();
      await expect(toast).toBeHidden();
      await expect(toast.locator(".toast-countdown")).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as any).searchControl.aborted),
      ).toBe(true);
      await publish(page, {
        phase: "walking",
        ids: ["late"],
        status: "complete",
      });
      await expect(page.locator(".route-choice")).toHaveCount(0);
      await expect(toast).toBeHidden();
    },
  );

test("live feedback follows mobile and desktop layouts without replaying readiness", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, true);
  await publish(page, { phase: "base", ids: ["first"] });
  await expectFeedbackPosition(page, 390);
  await page.clock.fastForward(3100);
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  for (const width of [768, 1280, 899, 900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expectFeedbackPosition(page, width);
    await expect(page.locator("#toast")).toHaveAttribute(
      "data-planning-stage",
      "optimizing",
    );
  }
  await openSelectedDetails(page);
  await expectFeedbackPosition(page, 390);
  await showMap(page);
  await expectFeedbackPosition(page, 390);
  await page.locator("#result-back").click();
  await expectFeedbackPosition(page, 390);
});

for (const [width, colorScheme] of [
  [320, "light"],
  [1280, "dark"],
] as const)
  test(`toast countdown preserves duration and motion preference at ${width}px in ${colorScheme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await open(page, true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    if (width === 320)
      await page.addStyleTag({ content: "html { font-size: 24px; }" });
    await publish(page, { phase: "base", ids: ["first"] });
    const toast = page.locator("#toast");
    if (width >= 900) {
      await expect(toast).toHaveAttribute("data-planning-stage", "ready");
      await page.clock.runFor(350);
      await expectMotionSettled(toast);
      const original = await toast.locator(".toast-countdown").elementHandle();
      await expectCountdownAt(page, 3000, 0);
      await expectCountdownAt(page, 3000, 0.5);
      await publish(page, { phase: "walking", ids: ["first"] });
      expect(await original!.evaluate((element) => element.isConnected)).toBe(
        true,
      );
      expect(
        await toast
          .locator(".toast-countdown-fill")
          .evaluate((fill) => fill.getAnimations()[0].currentTime),
      ).toBe(1500);
      await page.screenshot({
        path: info.outputPath("readiness-countdown.png"),
      });
      await expectCountdownAt(page, 3000, 1);
      await page.clock.fastForward(2650);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(
        false,
      );
    }
    await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);

    await page.locator("#route-more").click();
    await page.clock.runFor(350);
    await page.locator("#share-plan").click();
    await expect(toast).toHaveText("Planungslink kopiert.");
    await expect(page.locator(".history-feedback > #toast")).toBeVisible();
    const deadline = await page.evaluate(() => performance.now() + 6000);
    await page.clock.runFor(350);
    await expectMotionSettled(toast);
    await expectCountdownAt(page, 6000, 0);
    await expectCountdownAt(page, 6000, 0.5);
    await page.clock.fastForward(2650);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.runFor(32);
    await expect(toast.locator(".toast-countdown")).toBeHidden();
    // WebKit delivers media-query changes after rendering; wait before toggling back.
    await expect(toast.locator(".toast-countdown")).toHaveCSS(
      "--toast-elapsed",
      /^[1-9]\d*(?:\.\d+)?ms$/,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.clock.runFor(32);
    await expect(toast.locator(".toast-countdown")).toBeVisible();
    await expect
      .poll(() =>
        toast
          .locator(".toast-countdown-fill")
          .evaluate(
            (fill) => fill.getAnimations()[0]?.effect?.getTiming().delay ?? 0,
          ),
      )
      .toBeLessThanOrEqual(-3000);
    const resumed = await toast
      .locator(".toast-countdown-fill")
      .evaluate((fill) => {
        const animation = fill.getAnimations()[0];
        animation.pause();
        // Native animation time and Playwright's clock advance independently.
        // Inspect the restart at time zero to verify its preserved elapsed offset.
        animation.currentTime = 0;
        return {
          progress: animation.effect!.getComputedTiming().progress,
          elapsed: -animation.effect!.getTiming().delay,
        };
      });
    expect(resumed.elapsed).toBeGreaterThanOrEqual(3000);
    expect(resumed.progress).toBeCloseTo(resumed.elapsed / 6000, 3);
    await page.screenshot({ path: info.outputPath("message-countdown.png") });
    await expectCountdownAt(page, 6000, 1);
    const remaining = await page.evaluate(
      (deadline) => deadline - performance.now(),
      deadline,
    );
    await page.clock.fastForward(remaining - 1);
    await expect(toast).toHaveText("Planungslink kopiert.");
    await page.clock.fastForward(1);
    await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);
    await expectFeedbackPosition(page, width);
  });

for (const status of ["searching", "complete"])
  test(`readiness lasts exactly three seconds when search is ${status}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, true);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await publish(page, { phase: "base", ids: ["first"], status });
    const toast = page.locator("#toast");
    await expect(toast).toHaveAttribute("data-planning-stage", "ready");
    await expect(toast.locator(".toast-countdown")).toBeHidden();
    await page.clock.fastForward(1500);
    if (status === "searching")
      await publish(page, { phase: "walking", ids: ["first"] });
    await page.clock.fastForward(1499);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-planning-stage", "ready");
    await page.clock.fastForward(1);
    if (status === "complete") await expect(toast).toBeHidden();
    else {
      await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
      await expect(toast).toHaveText("Optimierung läuft …");
    }
    await expect(toast.locator(".toast-countdown")).toHaveCount(0);
  });

test("mobile search switches directly to optimization without shifting the list header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true);
  await page.clock.fastForward(7000);
  await expect(page.locator("#toast")).toBeVisible();
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "searching",
  );
  await publish(page, { phase: "base", ids: ["first"] });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await showConnections(page);
  await expectFeedbackPosition(page, 390);
  const header = await page.locator("#result-header").boundingBox();
  await page.clock.fastForward(3100);
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await expect(page.locator("#toast")).toHaveText("Optimierung läuft …");
  await expect(page.locator("#toast .planning-toast-spinner")).toHaveCSS(
    "animation-name",
    "route-loading",
  );
  await expectFeedbackPosition(page, 390);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#toast .planning-toast-spinner")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await publish(page, { phase: "walking", ids: ["first"] });
  await page.clock.fastForward(7000);
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await publish(page, { phase: "walking", ids: ["first"], status: "complete" });
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#planning-announcement")).toHaveText(
    "Optimierung abgeschlossen.",
  );
  expect((await page.locator("#result-header").boundingBox())!.height).toBe(
    header!.height,
  );
  await expect(page.locator("#toast")).toBeHidden();
});

for (const target of ["editor", "history"])
  test(
    "leaving for " + target + " hides feedback and resumes only optimization",
    async ({ page }) => {
      await open(page);
      await publish(page, { phase: "base", ids: ["first"] });
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "ready",
      );
      await page
        .locator(target === "editor" ? "#adjust-route" : "#tab-history")
        .click();
      await expect(page.locator("#toast")).toBeHidden();
      await publish(page, { phase: "walking", ids: ["first"] });
      await page
        .locator(target === "editor" ? "#cancel-adjust" : "#tab-route")
        .click();
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "optimizing",
      );
    },
  );

test("user messages take priority over searching and readiness toasts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    });
  });
  await open(page, true);
  await publish(page, { phase: "base", ids: ["first"], status: "complete" });
  const readinessCountdown = await page
    .locator("#toast .toast-countdown")
    .elementHandle();
  await page.locator("#route-more").click();
  await page.locator("#share-plan").click();
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  expect(
    await readinessCountdown!.evaluate((element) => element.isConnected),
  ).toBe(false);
  await expect(page.locator("#toast .toast-countdown")).toHaveCount(1);
  await expect(page.locator("#toast .toast-countdown-fill")).toHaveCSS(
    "animation-duration",
    "6s",
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  await expect(page.locator("#status")).toBeVisible();
  await expect(page.locator("#status")).toHaveText(
    "Verbindungen werden gesucht …",
  );
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await publish(page, { phase: "base", ids: ["new"] });
  await expect(page.locator(".route-choice")).toHaveCount(1);
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await page.clock.fastForward(3100);
  await expect(page.locator("#toast")).toHaveText("Planungslink kopiert.");
  await page.clock.fastForward(3000);
  await expect(page.locator("#toast")).toHaveText("Optimierung läuft …");
});

test("partial optimization keeps retry reachable across map and details during a server pause", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, true);
  await publish(page, { phase: "via", ids: ["first"] });
  await showMap(page);
  await publish(page, {
    phase: "walking",
    ids: ["first"],
    incompletePhases: ["bike-transfers"],
    issues: ["Der Dienst bittet um eine Pause."],
  });
  await expect(page.locator("#issues")).toBeEmpty();
  await expect(page.locator("#map-preview-status")).toBeHidden();
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "optimizing",
  );
  await publish(page, {
    phase: "walking",
    ids: ["first"],
    status: "partial",
    incompletePhases: ["walking"],
    issues: ["Der Dienst bittet um eine Pause."],
    retryAt: await page.evaluate(() => Date.now() / 1000 + 60),
  });
  await expect(page.locator("#toast")).toHaveAttribute(
    "data-planning-stage",
    "error",
  );
  await expect(page.locator("#toast .planning-toast-message")).toHaveText(
    "Optimierung nicht vollständig.",
  );
  await expect(page.locator("#map-preview-status")).toBeHidden();
  await expect(page.locator("#toast #recover-planning")).toBeVisible();
  await expectRetryIcon(page);
  await expectFeedbackPosition(page, 390);
  await expect(page.locator("#recover-planning")).toBeVisible();
  await expect(page.locator("#recover-planning")).toBeDisabled();
  await expect(page.locator("#recovery-wait")).toBeVisible();
  const cooldown = await page.locator("#recovery-wait").boundingBox();
  const button = await page.locator("#recover-planning").boundingBox();
  expect(cooldown!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
  await page.locator("#map-open-details").click();
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator("#toast .planning-toast-message")).toHaveText(
    "Optimierung nicht vollständig.",
  );
  await expect(page.locator("#toast #recover-planning")).toBeVisible();
  await expectFeedbackPosition(page, 390);
  await expect(page.locator("#issues")).toBeHidden();
  await page.clock.fastForward(60_100);
  await expect(page.locator("#recover-planning")).toBeEnabled();
  await expect(page.locator("#recovery-wait")).toBeHidden();
  await expectRetryIcon(page);
  await expectFeedbackPosition(page, 390);
});

for (const [cause, message] of [
  [
    "Suche nach weiteren Rad-Umstiegen: Zeitlimit erreicht.",
    "Optimierung: Zeitlimit erreicht",
  ],
  [
    "Prüfung kürzerer Fußwege: Anfragelimit erreicht.",
    "Optimierung: Anfragelimit erreicht.",
  ],
  ["Verbindung zum Dienst fehlgeschlagen.", "Optimierung nicht vollständig."],
] as const)
  test(
    "partial search shows " + message + " once across views",
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: "dark" });
      await open(page);
      await publish(page, {
        phase: "bike-transfers",
        ids: ["first"],
        status: "partial",
        incompletePhases: ["bike-transfers"],
        issues: [cause, cause],
      });
      await expect(page.locator("#toast .planning-toast-message")).toHaveText(
        message,
      );
      await expect(page.locator("#status")).toBeEmpty();
      await expect(page.locator("#issues")).toBeHidden();
      await expect(page.locator("#recover-planning")).toBeEnabled();
      await expectRetryIcon(page);
      await openSelectedDetails(page);
      await expect(page.locator("#toast .planning-toast-message")).toHaveText(
        message,
      );
      await expect(page.locator("#status")).toBeEmpty();
      await showMap(page);
      await expect(page.locator("#map-preview-status")).toBeHidden();
      await expect(page.locator("#toast .planning-toast-message")).toHaveText(
        message,
      );
      await expect(page.locator("#toast #recover-planning")).toBeVisible();
      await expectFeedbackPosition(page, 390);
      await expect(page.locator("#recover-planning")).toBeVisible();
      await page.context().setOffline(true);
      await expect(page.locator("#recover-planning")).toBeDisabled();
      await page.context().setOffline(false);
      await expect(page.locator("#recover-planning")).toBeEnabled();
      // Continue the same calculation; current results remain usable.
      await page.locator("#recover-planning").click();
      await expect(page.locator("#toast")).toHaveAttribute(
        "data-planning-stage",
        "optimizing",
      );
      await expect(page.locator("#toast")).toHaveText("Optimierung läuft …");
      await expect(page.locator("#journey-panel")).not.toHaveClass(
        /is-loading/,
      );
      await expect(page.locator("#stale-notice")).toBeHidden();
      await expect(page.locator("#navigation-start")).toBeEnabled();
      await publish(page, {
        phase: "base",
        ids: ["retried"],
        status: "complete",
      });
      await expect(page.locator("#toast")).toBeHidden();
      await expect(page.locator("#stale-notice")).toBeHidden();
      await expect(page.locator("#status")).toBeEmpty();
      await expect(
        page.locator('.route-choice[aria-pressed="true"]'),
      ).toHaveAttribute("data-journey", "first");
    },
  );

for (const width of [390, 1280])
  test(`continuation preserves open details and reading position at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 });
    await open(page);
    await publish(page, {
      phase: "walking",
      ids: ["first", "chosen"],
      status: "partial",
      incompletePhases: ["walking"],
      issues: ["Zeitlimit erreicht"],
    });
    await showConnections(page);
    await page.locator('.route-choice[data-journey="chosen"]').click();
    await openSelectedDetails(page);
    const position = await page.evaluate(() => {
      const panel = document.getElementById("journey-panel")!;
      const container = panel.classList.contains("result-scroll-all")
        ? panel
        : document.getElementById("panel-content")!;
      container.scrollTop = 100;
      return {
        scrollTop: container.scrollTop,
        headingTop: document
          .getElementById("journey-heading")!
          .getBoundingClientRect().top,
      };
    });
    expect(position.scrollTop).toBeGreaterThan(0);
    // Start continuation without scrolling the inline action back into view.
    // The assertion covers background updates while the user reads the details.
    await page
      .locator("#recover-planning")
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.locator("#toast")).toHaveAttribute(
      "data-planning-stage",
      "optimizing",
    );
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(page.locator("#stale-notice")).toBeHidden();
    await publish(page, {
      phase: "walking",
      ids: ["improved"],
      status: "complete",
    });
    await expect(page.locator("#toast")).toBeHidden();
    await expect(page.locator("#panel-details")).toBeVisible();
    await expect(
      page.locator('.route-choice[aria-pressed="true"]'),
    ).toHaveAttribute("data-journey", "chosen");
    // Browser anchoring may adjust scrollTop when alternatives above the details change.
    const headingTop = await page
      .locator("#journey-heading")
      .evaluate((element) => element.getBoundingClientRect().top);
    // Scrolling can round the fractional inline row heights to device pixels.
    expect(Math.abs(headingTop - position.headingTop)).toBeLessThanOrEqual(1);
  });

test("completed search keeps errors out of the result area", async ({
  page,
}) => {
  await open(page);
  await publish(page, { phase: "base", ids: ["first"] });
  await publish(page, { phase: "base", ids: ["first"], status: "complete" });
  await expect(page.locator("#status")).toBeEmpty();
  await expect(page.locator("#status")).toBeHidden();
  await showMap(page);
  const status = page.locator(
    (await page.evaluate(() => innerWidth < 900))
      ? "#map-preview-status"
      : "#status",
  );
  await expect(status).toBeHidden();
});

test("failure before any result shows the original error without readiness", async ({
  page,
}) => {
  await open(page);
  await publish(page, {
    phase: "base",
    error: "Der Dienst konnte die Anfrage nicht beantworten.",
  });
  await expect(page.locator("#status")).toHaveText(
    "Der Dienst konnte die Anfrage nicht beantworten.",
  );
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#recover-planning")).toBeEnabled();
  await expect(page.locator("#recovery-label")).not.toHaveClass(/sr-only/);
  await expect(page.locator("#recover-planning .recovery-icon")).toBeHidden();
  await expect(page.locator("#journey-panel")).not.toHaveClass(/is-loading/);
  await expect(page.locator(".route-choice")).toHaveCount(0);
});

for (const width of [320, 1280])
  test(`optimization error persists and resumes after another toast at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => {} },
      });
    });
    await open(page, true);
    if (width === 320)
      await page.addStyleTag({ content: "html { font-size: 24px; }" });
    await publish(page, {
      phase: "walking",
      ids: ["first"],
      status: "partial",
      incompletePhases: ["walking"],
      issues: ["Prüfung kürzerer Fußwege: Zeitlimit erreicht."],
    });
    const toast = page.locator("#toast");
    const retry = page.locator("#recover-planning");
    await expect(toast).toHaveAttribute("data-planning-stage", "error");
    await expect(page.locator("#toast #recover-planning")).toBeEnabled();
    await expectRetryIcon(page);
    await expectFeedbackPosition(page, width);
    await page.evaluate(() => {
      (window as any).errorToastMutations = 0;
      new MutationObserver((records) => {
        (window as any).errorToastMutations += records.length;
      }).observe(document.getElementById("toast")!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    await page.context().setOffline(true);
    await expect(retry).toBeDisabled();
    await page.context().setOffline(false);
    await expect(retry).toBeEnabled();
    expect(await page.evaluate(() => (window as any).errorToastMutations)).toBe(
      0,
    );
    await retry.focus();
    await page.clock.fastForward(15000);
    await expect(retry).toBeFocused();
    await expect(toast).toBeVisible();
    await page.screenshot({ path: info.outputPath("optimization-error.png") });
    await page.locator("#route-more").click();
    await expect(toast).toBeHidden();
    await page.locator("#route-actions-close").click();
    await expect(toast).toHaveAttribute("data-planning-stage", "error");
    await expect(page.locator("#toast #recover-planning")).toBeEnabled();
    await expect(page.locator("#route-more")).toBeFocused();
    await page.locator("#route-more").click();
    await page.locator("#share-plan").click();
    await expect(toast).toHaveText("Planungslink kopiert.");
    await expect(page.locator("#status")).toHaveText(
      "Optimierung: Zeitlimit erreicht",
    );
    await expect(retry).toBeVisible();
    await expect(page.locator("#toast #recover-planning")).toHaveCount(0);
    await expect(page.locator("#recovery-label")).not.toHaveClass(/sr-only/);
    await expect(retry.locator(".recovery-icon")).toBeHidden();
    await retry.focus();
    await page.clock.fastForward(6100);
    await expect(toast).toHaveAttribute("data-planning-stage", "error");
    await expect(page.locator("#toast #recover-planning")).toBeEnabled();
    await expect(retry).toBeFocused();
    await expectRetryIcon(page);
    await expect(page.locator("#status")).toBeEmpty();
    await expectFeedbackPosition(page, width);
    await retry.click();
    await expect(toast).toHaveAttribute("data-planning-stage", "optimizing");
    await expect(page.locator("#toast #recover-planning")).toHaveCount(0);
    await publish(page, { phase: "base", ids: ["new"], status: "complete" });
    await expect(toast).toBeHidden();
  });

for (const key of ["Enter", "Space"])
  test(`retry icon continues optimization once with ${key}`, async ({
    page,
    browserName,
  }) => {
    await open(page);
    await publish(page, {
      phase: "walking",
      ids: ["first"],
      status: "partial",
      incompletePhases: ["walking"],
      issues: ["Prüfung kürzerer Fußwege: Zeitlimit erreicht."],
    });
    await expectRetryIcon(page);
    const retry = page.getByRole("button", {
      name: "Erneut versuchen",
      exact: true,
    });
    await page.locator("#tab-settings").focus();
    await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
    await expect(retry).toBeFocused();
    await expect(retry).toHaveCSS("outline-style", "solid");
    await retry.press(key);
    await expect(page.locator("#toast")).toHaveAttribute(
      "data-planning-stage",
      "optimizing",
    );
    expect(await page.evaluate(() => (window as any).searchControlRuns)).toBe(
      2,
    );
    await publish(page, {
      phase: "base",
      ids: ["retried"],
      status: "complete",
    });
    await expect(page.locator("#toast")).toBeHidden();
    expect(await page.evaluate(() => (window as any).searchControlRuns)).toBe(
      2,
    );
  });
