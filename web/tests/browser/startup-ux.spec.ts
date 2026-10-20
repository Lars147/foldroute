import { test, expect, type Page } from "@playwright/test";

const production =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;

async function standalone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
}

async function controlledStartup(
  page: Page,
  { installed = true, hidden = false } = {},
) {
  const epoch = new Date("2026-10-17T10:00:00Z");
  await page.clock.install({ time: new Date(epoch.getTime() - 1000) });
  await page.clock.pauseAt(epoch);
  if (installed) await standalone(page);
  await page.addInitScript((hidden) => {
    let visible = !hidden;
    Object.defineProperty(document, "visibilityState", {
      get: () => (visible ? "visible" : "hidden"),
    });
    (window as any).setStartupVisibility = (value: boolean) => {
      visible = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  }, hidden);
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export const startupReady = new Promise(resolve => { window.releaseTestStartup = resolve; });",
    }),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseTestStartup))
    .toBe("function");
  await page.clock.runFor(32);
}

async function advanceVisibleTo(page: Page, elapsed: number) {
  const current = await page.evaluate(
    () =>
      performance.now() -
      Number(document.documentElement.dataset.startupVisibleAt),
  );
  await page.clock.runFor(elapsed - current);
}

async function startupPose(page: Page, elapsed: number) {
  return page.locator(".startup-scene").evaluate((scene, elapsed) => {
    for (const animation of scene.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = elapsed;
    }
    const matrix = (element: Element) => {
      const value = getComputedStyle(element).transform;
      return value === "none"
        ? new DOMMatrixReadOnly()
        : new DOMMatrixReadOnly(value);
    };
    const wheels = [...scene.querySelectorAll<SVGGElement>("[data-wheel]")].map(
      (wheel) => {
        const circle = wheel.querySelector("circle")!;
        const screen = circle.getScreenCTM()!;
        const center = new DOMPoint(
          circle.cx.baseVal.value,
          circle.cy.baseVal.value,
        ).matrixTransform(screen);
        const rotation = matrix(wheel);
        return {
          center: [center.x, center.y],
          rotation: [rotation.a, rotation.b],
          circumference:
            2 *
            Math.PI *
            (circle.r.baseVal.value +
              Number(getComputedStyle(circle).strokeWidth.replace("px", "")) /
                2) *
            Math.hypot(screen.a, screen.b),
        };
      },
    );
    const mark = scene.querySelector(".startup-mark")!.getBoundingClientRect();
    return {
      wheels,
      fold: [...scene.querySelectorAll("[data-fold]")].map(
        (part) => getComputedStyle(part).transform,
      ),
      roadClip: getComputedStyle(scene.querySelector(".startup-road")!)
        .clipPath,
      roadTravel: matrix(scene.querySelector(".startup-road-track")!).m41,
      mark: { x: mark.x, y: mark.y, width: mark.width, height: mark.height },
    };
  }, elapsed);
}

for (const [width, theme] of [
  [320, "light"],
  [390, "dark"],
] as const)
  test(`unfolding becomes a seamless stationary ride at ${width}px in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: "no-preference",
    });
    await controlledStartup(page);
    await expect(page.locator(".startup-scene")).toBeVisible();
    const initial = await startupPose(page, 0);
    const folding = await startupPose(page, 240);
    expect(folding.fold).not.toEqual(initial.fold);
    const unfolded = await startupPose(page, 480);
    expect(unfolded.fold).toEqual(initial.fold);
    expect(unfolded.roadClip).toEqual(initial.roadClip);
    const waiting = await startupPose(page, 640);
    expect(waiting.roadClip).toEqual(initial.roadClip);
    const arriving = await startupPose(page, 720);
    expect(arriving.roadClip).not.toBe(initial.roadClip);
    const ready = await startupPose(page, 800);
    expect(ready.wheels).toHaveLength(2);
    expect(arriving.roadClip).not.toBe(ready.roadClip);
    const riding = await startupPose(page, 1025);
    for (const [index, wheel] of riding.wheels.entries()) {
      expect(wheel.rotation[0]).toBeCloseTo(0, 4);
      expect(wheel.rotation[1]).toBeCloseTo(1, 4);
      expect(wheel.center[0]).toBeCloseTo(ready.wheels[index].center[0], 3);
      expect(wheel.center[1]).toBeCloseTo(ready.wheels[index].center[1], 3);
    }
    expect(riding.roadTravel).toBeCloseTo(
      -riding.wheels[0].circumference / 4,
      2,
    );
    const later = await startupPose(page, 1325);
    expect(later.wheels[0].rotation).not.toEqual(riding.wheels[0].rotation);
    expect(later.roadTravel).toBeLessThan(riding.roadTravel);
    const repeated = await startupPose(page, 1925);
    for (const [index, wheel] of repeated.wheels.entries()) {
      const previous = riding.wheels[index];
      wheel.center.forEach((value, axis) =>
        expect(value).toBeCloseTo(previous.center[axis], 4),
      );
      wheel.rotation.forEach((value, axis) =>
        expect(value).toBeCloseTo(previous.rotation[axis], 4),
      );
      expect(wheel.circumference).toBeCloseTo(previous.circumference, 4);
    }
    expect(repeated.roadTravel).toBeCloseTo(riding.roadTravel, 4);
    expect(repeated.mark).toEqual({
      x: (width - 128) / 2,
      y: (844 - 128) / 2,
      width: 128,
      height: 128,
    });
    expect(
      await page.locator(".startup-scene").evaluate((scene) => {
        const bounds = scene.getBoundingClientRect();
        const road = scene
          .querySelector(".startup-road")!
          .getBoundingClientRect();
        return (
          bounds.left >= 24 &&
          bounds.right <= innerWidth - 24 &&
          road.bottom <= bounds.bottom
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`ride-${theme}.png`) });
    await advanceVisibleTo(page, 2000);
    await page.evaluate(() => (window as any).releaseTestStartup());
    // Paused infinite animations must never hold the ready application.
    await expect(page.locator("#main")).not.toHaveAttribute("inert");
    await expect(page.locator("#app-startup")).toBeHidden();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-startup-motion",
    );
  });

test("a failed ride stops motion and keeps reload available", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await controlledStartup(page);
  await startupPose(page, 1000);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("foldroute:startup-error")),
  );
  await expect(page.locator("#startup-reload")).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  expect(
    await page
      .locator(".startup-scene")
      .evaluate((scene) => scene.getAnimations({ subtree: true }).length),
  ).toBe(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`fast installed start holds 600 ms of visible logo (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await controlledStartup(page);
    if (reducedMotion === "reduce")
      expect(
        await page
          .locator(".startup-scene")
          .evaluate((scene) => scene.getAnimations({ subtree: true }).length),
      ).toBe(0);
    await page.evaluate(() => (window as any).releaseTestStartup());
    await advanceVisibleTo(page, 599);
    await expect(page.locator("#app-startup")).toBeVisible();
    await expect(page.locator("#main")).toHaveAttribute("inert", "");
    await page.clock.runFor(1);
    await expect(page.locator("#main")).not.toHaveAttribute("inert");
    if (reducedMotion === "reduce") {
      expect(
        await page
          .locator("#app-startup")
          .evaluate((element) => element.hidden),
      ).toBe(true);
      await expect(page.locator("#app-startup")).not.toHaveAttribute(
        "data-exiting",
      );
    } else {
      await expect(page.locator("#app-startup")).toHaveAttribute(
        "data-exiting",
        "",
      );
    }
    await expect(page.locator("#app-startup")).toBeHidden();
  });
}

test("slow startup releases immediately when ready after the minimum", async ({
  page,
}) => {
  await controlledStartup(page);
  await advanceVisibleTo(page, 1200);
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  await page.evaluate(() => (window as any).releaseTestStartup());
  // No clock advance: adding another 600 ms after readiness would leave controls inert.
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
});

test("a failed start cancels the minimum without releasing incomplete controls", async ({
  page,
}) => {
  await controlledStartup(page);
  await page.evaluate(() => (window as any).releaseTestStartup());
  await advanceVisibleTo(page, 100);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("foldroute:startup-error")),
  );
  await expect(page.locator("#startup-error")).toBeVisible();
  await page.clock.runFor(1000);
  await expect(page.locator("#startup-error")).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  await expect(page.locator("#app-startup")).not.toHaveAttribute(
    "data-exiting",
  );
});

test("initial background time does not consume the minimum or restart it on return", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await controlledStartup(page, { hidden: true });
  await page.evaluate(() => (window as any).releaseTestStartup());
  await page.clock.runFor(1500);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-startup-visible-at",
  );
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  await page.evaluate(() => (window as any).setStartupVisibility(true));
  await page.clock.runFor(16);
  await advanceVisibleTo(page, 599);
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  await page.clock.runFor(1);
  await expect(page.locator("#app-startup")).toBeHidden();
  const started = await page
    .locator("html")
    .getAttribute("data-startup-visible-at");
  await page.evaluate(() => {
    (window as any).setStartupVisibility(false);
    (window as any).setStartupVisibility(true);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });
  await page.clock.runFor(1000);
  await expect(page.locator("#app-startup")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute(
    "data-startup-visible-at",
    started!,
  );
});

test("ordinary browser startup never waits for the splash minimum", async ({
  page,
}) => {
  await controlledStartup(page, { installed: false });
  await page.evaluate(() => (window as any).releaseTestStartup());
  await expect(page.locator("#main")).not.toHaveAttribute("inert");
  await expect(page.locator("#app-startup")).toBeHidden();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-startup-visible-at",
  );
});

for (const theme of ["light", "dark"] as const) {
  test(`installed cold start paints ${theme} before the bundle and honors saved preference`, async ({
    page,
  }) => {
    await standalone(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({
      colorScheme: theme === "light" ? "dark" : "light",
    });
    await page.addInitScript(
      (theme) => localStorage.setItem("foldroute.appearance", theme),
      theme,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/src/bootstrap.ts", async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/", { waitUntil: "commit" });
    const splash = page.locator("#app-startup");
    let initialColors!: { background: string; color: string };
    try {
      await expect(splash).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(splash).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(16, 19, 20)" : "rgb(245, 246, 243)",
      );
      initialColors = await splash.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      }));
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
        "content",
        theme === "dark" ? "#101314" : "#f5f6f3",
      );
      await expect(page.locator("#main")).toHaveAttribute("inert", "");
      const logo = await page.locator(".startup-mark").boundingBox();
      expect(logo).toEqual({ x: 131, y: 358, width: 128, height: 128 });
      // A paused brand animation must never hold the app's readiness guard.
      const paused = await page.locator(".startup-mark").evaluate((mark) => {
        const animations = mark.getAnimations({ subtree: true });
        for (const animation of animations) {
          animation.pause();
          animation.currentTime =
            Number(animation.effect!.getTiming().duration) / 2;
        }
        return animations.length;
      });
      expect(paused).toBeGreaterThan(0);
      // WebKit waits for document.fonts.ready in screenshots until the held module loads.
      // The fully loaded preview below captures both visual variants instead.
    } finally {
      release();
    }
    await expect(splash).toBeHidden();
    await expect(page.locator("#main")).not.toHaveAttribute("inert");
    await expect(page.locator("#destination")).toBeVisible();
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      initialColors.background,
    );
    await expect(page.locator("html")).toHaveCSS("color", initialColors.color);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      theme === "dark" ? "#101314" : "#f5f6f3",
    );
    await page.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(splash).toBeHidden();
  });
}

test("startup waits for local restoration, then releases controls without location or network", async ({
  page,
}) => {
  await standalone(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("https://api.transitous.org/**", (route) => route.abort());
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.abort(),
  );
  await page.addInitScript(() => {
    const original = indexedDB.open;
    indexedDB.open = function (...args) {
      const request = original.apply(this, args);
      const hold = (event: Event) => {
        event.stopImmediatePropagation();
        (window as any).releaseLocalStartup = () => {
          request.removeEventListener("success", hold);
          request.dispatchEvent(new Event("success"));
        };
      };
      request.addEventListener("success", hold);
      return request;
    };
    for (const key of ["getCurrentPosition", "watchPosition"] as const)
      Object.defineProperty(navigator.geolocation, key, {
        value: () => {
          throw new Error("Startup must not require GPS");
        },
      });
  });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseLocalStartup))
    .toBe("function");
  await expect(page.locator("#app-startup")).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("inert", "");
  expect(
    await page
      .locator(".startup-mark")
      .evaluate((mark) => mark.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await page.evaluate(() => (window as any).releaseLocalStartup());
  await expect(page.locator("#app-startup")).toBeHidden();
  await expect(page.locator("#app-startup")).not.toHaveAttribute(
    "data-exiting",
  );
  await expect(page.locator("#destination")).toBeFocused();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#app-startup")).toBeHidden();
});

test("ordinary browser entry has no splash and unavailable storage falls back to system theme", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage unavailable");
    };
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/src/main.ts", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app-startup")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  release();
  await expect(page.locator("#destination")).toBeFocused();
});

for (const module of ["bootstrap", "main"]) {
  test(`failed ${module} offers an accessible reload without releasing incomplete controls`, async ({
    page,
  }) => {
    await standalone(page);
    const path = `**/src/${module}.ts`;
    await page.route(path, (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("#startup-error")).toBeVisible();
    await expect(page.locator("#main")).toHaveAttribute("inert", "");
    // macOS WebKit's default Tab traversal skips buttons; still verify focus and keyboard activation.
    const reload = page.getByRole("button", { name: "Neu laden" });
    await reload.focus();
    await expect(reload).toBeFocused();
    await expect(reload).toHaveCSS("outline-style", "solid");
    await page.unroute(path);
    await page.keyboard.press("Enter");
    await expect(page.locator("#destination")).toBeVisible();
    await expect(page.locator("#app-startup")).toBeHidden();
  });
}

test("local preview pauses, changes theme and replays without touching personal data", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("foldroute.appearance", "light");
    const effects = { storage: 0, database: 0, location: 0 };
    (window as any).previewEffects = effects;
    for (const key of ["setItem", "removeItem", "clear"] as const) {
      const original = Storage.prototype[key];
      (Storage.prototype as any)[key] = function (...args: any[]) {
        effects.storage++;
        return (original as Function).apply(this, args);
      };
    }
    const open = indexedDB.open;
    indexedDB.open = function (...args) {
      effects.database++;
      return open.apply(this, args);
    };
    for (const key of ["getCurrentPosition", "watchPosition"] as const)
      Object.defineProperty(navigator.geolocation, key, {
        value: () => {
          effects.location++;
        },
      });
  });
  await page.goto("/splash-preview/");
  const phone = page.frameLocator("#preview");
  for (const theme of ["light", "dark"]) {
    await page
      .getByRole("button", {
        name: theme === "light" ? "Hell" : "Dunkel",
        exact: true,
      })
      .click();
    await expect(page.locator("#continue")).toBeEnabled();
    await expect(phone.locator("#app-startup")).toBeVisible();
    await expect(phone.locator("html")).toHaveAttribute("data-theme", theme);
    await expect
      .poll(() =>
        phone.locator(".startup-scene").evaluate((scene) => {
          const loops = scene
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect!.getTiming().iterations === Infinity,
            );
          return (
            loops.length === 3 &&
            loops.every(
              (animation) =>
                animation.playState === "running" &&
                Number(animation.currentTime) > 800,
            )
          );
        }),
      )
      .toBe(true);
    await phone.locator(".startup-scene").evaluate((scene) => {
      for (const animation of scene.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 1000;
      }
    });
    await page.screenshot({
      path: test.info().outputPath(`preview-${theme}.png`),
    });
    await page.getByRole("button", { name: "Fortsetzen" }).click();
    await expect(page.locator("#preview-status")).toHaveText(
      "Start abgeschlossen.",
    );
    await expect(phone.locator("#app-startup")).toBeHidden();
    await expect(phone.locator("#destination")).toBeVisible();
    for (const frame of page.frames()) {
      expect(
        await frame.evaluate(() => (window as any).previewEffects),
      ).toEqual({ storage: 0, database: 0, location: 0 });
      expect(
        await frame.evaluate(() =>
          localStorage.getItem("foldroute.appearance"),
        ),
      ).toBe("light");
    }
  }
  await page.getByRole("button", { name: "Start abspielen" }).click();
  await expect(page.locator("#preview-status")).toHaveText(
    "Start abgeschlossen.",
  );
  await expect(page.locator("#continue")).toBeDisabled();
  await expect(phone.locator("#app-startup")).toBeHidden();
  for (const frame of page.frames())
    expect(await frame.evaluate(() => (window as any).previewEffects)).toEqual({
      storage: 0,
      database: 0,
      location: 0,
    });
  expect(errors).toEqual([]);
});

test("production startup shell stays inline and offline without generated splash images", async ({
  page,
  context,
  browserName,
}) => {
  await standalone(page);
  await page.goto(production);
  await expect(page.locator("#app-startup")).toBeHidden();
  await expect(page.locator("#app-startup svg [data-fold]")).toHaveCount(2);
  await expect(page.locator("#app-startup [data-startup-spokes]")).toHaveCount(
    2,
  );
  await expect(page.locator(".startup-road-track pattern")).toHaveCount(1);
  await expect(
    page.locator('link[rel="apple-touch-startup-image"]'),
  ).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // An activated worker can precede control of the first WebKit document.
  await page.reload();
  await expect(page.locator("#destination")).toBeVisible();
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(
    true,
  );
  await context.setOffline(true);
  const cached = await page.evaluate(async () => {
    const requests = (
      await Promise.all(
        (await caches.keys()).map(async (key) =>
          (await (await caches.open(key)).keys()).map((request) => request.url),
        ),
      )
    ).flat();
    const shell = await caches.match(new URL("index.html", location.href), {
      ignoreSearch: true,
    });
    if (!shell) throw new Error("Missing offline application shell");
    return { requests, html: await shell.text() };
  });
  expect(cached.html).toContain('data-fold="rear"');
  expect(cached.html).toContain('data-fold="front"');
  expect(cached.html).toContain("data-startup-spokes");
  expect(cached.html).toContain("startup-road-pattern");
  expect(cached.html).not.toContain("apple-touch-startup-image");
  expect(
    cached.requests.filter((url) => new URL(url).pathname.includes("/splash/")),
  ).toEqual([]);
  // Playwright 1.63 WebKit rejects even cache-only SW navigation in offline emulation.
  // Cached inline HTML was verified offline above; Chromium also exercises the restart.
  // https://github.com/microsoft/playwright/issues/42775
  if (browserName === "webkit") {
    test.info().annotations.push({
      type: "limitation",
      description:
        "Offline navigation emulation blocked by Playwright #42775; cached inline HTML verified directly.",
    });
    await context.setOffline(false);
  }
  await page.goto(`${production}?splash-preview=dark`);
  await expect(page.locator("#destination")).toBeVisible();
  await expect(page.locator("#app-startup svg [data-fold]")).toHaveCount(2);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-startup-preview",
  );
  await expect(page.locator('meta[name="foldroute-dev"]')).toHaveCount(0);
  await expect(page.locator("#app-startup")).toBeHidden();
});
