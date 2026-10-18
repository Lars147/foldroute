import { openSettingsSection, openSelectedDetails } from "./assertions";
import {
  expectPlanningComplete,
  expectSelectedJourneySaved,
} from "./assertions";
import { test, expect, type Page } from "@playwright/test";
import { defaults } from "../../src/model";
import { mapResponse, baseVariants } from "../../src/transitous";
import fixture from "../fixtures/swift-parity.json" with { type: "json" };
const root =
  process.env.FOLDROUTE_PRODUCTION_URL ??
  `http://127.0.0.1:${Number(process.env.FOLDROUTE_TEST_PORT ?? 4173) + 1}/docs/plan/`;
const cors = { "Access-Control-Allow-Origin": "*" };
async function production(page: Page) {
  await page.clock.setFixedTime(new Date("2026-09-04T08:00:00Z"));
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 48.132, longitude: 11.5756 });
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({
      headers: cors,
      json: [{ name: "Ziel", lat: 48.175, lon: 11.6 }],
    }),
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
  await page.goto(root);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.evaluate(
    (value) => {
      // Some tests deliberately reject storage writes; they exercise session-only settings.
      try {
        if (!localStorage.getItem("foldroute.routing.v3"))
          localStorage.setItem("foldroute.routing.v3", JSON.stringify(value));
      } catch {
        /* Leave unavailable storage to the application's existing handling. */
      }
    },
    { ...defaults, maxCyclingMinutes: 60 },
  );
  await page.reload();
}
async function plan(page: Page) {
  await page.locator("#destination").fill("Ziel");
  await page.locator("#destination-options").locator(".place-select").click();
  await expectPlanningComplete(page);
  await expectSelectedJourneySaved(page);
}
test("scoped PWA manifest, icons and cache work under a static subpath", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await production(page);
  const info = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const manifest = await fetch(
      document.querySelector<HTMLLinkElement>("link[rel=manifest]")!.href,
    ).then((r) => r.json());
    return { scope: registration.scope, manifest };
  });
  expect(info.scope).toBe(root);
  expect(info.manifest.display).toBe("standalone");
  expect(info.manifest.start_url).toBe("./");
  for (const entry of info.manifest.icons) {
    const response = await page.request.get(new URL(entry.src, root).href);
    expect(response.ok()).toBe(true);
  }
  await expect(page.locator("#offline-ready")).toContainText(
    "offline verfügbar",
  );
  await page.screenshot({
    path: "test-results/pwa-search.png",
    fullPage: true,
  });
  await page.locator(".brand").click();
  await expect(page).toHaveURL(new URL("../", root).href);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller),
  ).toBeNull();
  expect(errors).toEqual([]);
});
test("license page and original notices remain accessible offline", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(new URL("../", root).href);
  await page
    .getByRole("link", { name: "Lizenzen & Datenquellen", exact: true })
    .click();
  await expect(page).toHaveURL(new URL("licenses.html", root).href);
  await expect(
    page.getByRole("heading", { name: "Lizenzen & Datenquellen" }),
  ).toBeVisible();
  await production(page);
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "help");
  await context.setOffline(true);
  await page
    .getByRole("link", { name: "Lizenzen & Datenquellen", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(16, 19, 20)",
  );
  await expect(
    page.getByRole("heading", { name: "Lizenzen & Datenquellen" }),
  ).toBeVisible();
  for (const id of ["foldroute", "leaflet", "lucide", "workbox"]) {
    await page.locator(`#${id} summary`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(`#${id} pre`)).toBeVisible();
    const notice = await page.locator(`#${id} a`).getAttribute("href");
    const downloaded = await page.evaluate(async (name) => {
      const response = await fetch(name!);
      return { ok: response.ok, text: await response.text() };
    }, notice);
    expect(downloaded.ok).toBe(true);
    expect(downloaded.text.replace(/\r\n/g, "\n")).toBe(
      await page.locator(`#${id} pre`).textContent(),
    );
  }
  for (const width of [320, 390, 1660]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("link", { name: "Zum Webplaner", exact: true }).click();
  await expect(page.locator("#offline-empty")).toBeVisible();
});
test("offline restart restores exactly the saved journey without API or tile cache", async ({
  page,
  context,
}) => {
  await production(page);
  await plan(page);
  await context.setOffline(true);
  await page.goto(root);
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
  await expect(page.locator("#refresh-route")).toBeDisabled();
  const urls = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (
      await Promise.all(
        keys.map(async (k) =>
          (await (await caches.open(k)).keys()).map((r) => r.url),
        ),
      )
    ).flat();
  });
  expect(urls.every((url) => url.startsWith(root))).toBe(true);
  expect(
    urls.some(
      (url) => url.includes("transitous") || url.includes("tile.openstreetmap"),
    ),
  ).toBe(false);
  await openSelectedDetails(page);
  await expect(page.locator("#journey-detail")).toContainText("Rad");
  await page.screenshot({
    path: "test-results/pwa-offline.png",
    fullPage: true,
  });
  await context.setOffline(false);
  await expect(page.locator("#saved-notice")).toBeVisible();
});
test("disabling offline storage deletes the saved route and survives restart", async ({
  page,
  context,
}) => {
  await production(page);
  await plan(page);
  await page.locator("#tab-settings").click();
  await page.locator("#offline-enabled").uncheck();
  await expect(page.locator("#storage-message")).toContainText("ausgeschaltet");
  await context.setOffline(true);
  await page.goto(root);
  await expect(page.locator("#offline-empty")).toBeVisible();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#offline-enabled")).not.toBeChecked();
});
test("offline app without a saved route explains how to continue", async ({
  page,
  context,
}) => {
  await production(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#offline-empty")).toBeVisible();
  await expect(page.locator("#search-heading")).toBeVisible();
});
test("local storage failure does not prevent online planning", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await production(page);
  await page.locator("#destination").fill("Ziel");
  await page.locator("#destination-options").locator(".place-select").click();
  await expectPlanningComplete(page);
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#storage-message")).toContainText(
    "nicht offline gespeichert",
  );
});

test("switching alternatives replaces the single saved record", async ({
  page,
  context,
}) => {
  await production(page);
  const direct = structuredClone(fixture.direct);
  direct.direct[0].legs[0].endTime = "2026-09-04T09:01:00Z";
  direct.direct[0].endTime = "2026-09-04T09:01:00Z";
  await page.route("**/api/v6/plan?*", (r) =>
    r.fulfill({
      headers: cors,
      json:
        new URL(r.request().url()).searchParams.get("directModes") === "BIKE"
          ? direct
          : fixture.multimodal,
    }),
  );
  await page.locator("#destination").fill("Ziel");
  await page.locator("#destination-options").locator(".place-select").click();
  await expectPlanningComplete(page);
  await page.locator(".route-choice").last().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string>((resolve, reject) => {
            const open = indexedDB.open("foldroute-offline", 2);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const request = open.result
                .transaction("state")
                .objectStore("state")
                .get("last");
              request.onsuccess = () => {
                open.result.close();
                resolve(request.result.journey.id);
              };
            };
          }),
      ),
    )
    .toBe("bike-1");
  await context.setOffline(true);
  await page.goto(root);
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("1 h 1 min");
  await expect(page.locator(".route-choice")).toHaveCount(1);
});

test("help topics and links work offline under the deployment subpath", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(new URL("../", root).href);
  await page.getByRole("link", { name: "Hilfe & FAQ", exact: true }).click();
  await expect(page).toHaveURL(new URL("hilfe.html", root).href);
  await production(page);
  await page.locator("#tab-settings").click();
  await openSettingsSection(page, "help");
  await context.setOffline(true);
  await page
    .getByRole("link", { name: "Datenschutz & Daten", exact: true })
    .click();
  await expect(page.locator("#datenschutz")).toHaveAttribute("open", "");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(16, 19, 20)",
  );
  await expect(page.locator("#datenschutz summary")).toBeInViewport();
  for (const topic of [
    "standort-pwa",
    "standort-freigabe",
    "standort-verfuegbar",
    "installation",
    "updates",
    "offline",
    "datenschutz",
  ]) {
    await page.goto(new URL(`hilfe.html#${topic}`, root).href);
    await page.reload();
    await expect(page.locator(`#${topic}`)).toHaveAttribute("open", "");
    await expect(page.locator(`#${topic} summary`)).toBeInViewport();
  }
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 1660]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page.goto(new URL("hilfe.html#installation", root).href);
  await page.locator("#installation summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#installation")).not.toHaveAttribute("open", "");
  await page
    .getByRole("link", { name: "Lizenzen & Datenquellen", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Hilfe & FAQ", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Zum Webplaner", exact: true }).click();
  await expect(page.locator("#offline-empty")).toBeVisible();
});

test("upgrades legacy database and settings while retaining the original offline journey", async ({
  page,
  context,
}) => {
  await page.goto(new URL("../", root).href);
  const { foldingDuration, ...rest } = defaults;
  const settings = { ...rest, foldDuration: 180, unfoldDuration: 120 };
  const request = {
    origin: { name: "Start", detail: "", latitude: 48.132, longitude: 11.5756 },
    destination: {
      name: "Ziel",
      detail: "",
      latitude: 48.175,
      longitude: 11.6,
    },
    timing: "depart" as const,
    time: Date.parse("2026-09-04T08:00:00Z") / 1000,
  };
  const snapshot = {
    version: 1,
    savedAt: request.time,
    request,
    settings,
    journey: mapResponse(fixture.direct, request, defaults, baseVariants[0])
      .journeys[0],
  };
  await page.evaluate(
    async ({ snapshot, settings }) => {
      localStorage.setItem("foldroute.routing.v1", JSON.stringify(settings));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("foldroute-offline", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("state");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("state", "readwrite");
        tx.objectStore("state").put(snapshot, "last");
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { snapshot, settings },
  );
  await production(page);
  await expect(page.locator("#open-saved")).toBeVisible();
  await page.locator("#tab-settings").click();
  await expect(page.locator("#foldingDuration")).toHaveValue("3");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("foldroute.routing.v3")!),
    ),
  ).toMatchObject({ foldingDuration: 180 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(
    page.locator(".route-choice[aria-pressed=true] .route-choice-time"),
  ).toContainText("32 min");
  await expect(page.locator("#late-departure")).toBeHidden();
  const persisted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("foldroute-offline");
      r.onsuccess = () => resolve(r.result);
    });
    const snapshot = await new Promise<any>((resolve) => {
      const r = db.transaction("state").objectStore("state").get("last");
      r.onsuccess = () => resolve(r.result);
    });
    const version = db.version;
    db.close();
    return { version, snapshot };
  });
  expect(persisted).toEqual({ version: 2, snapshot });
});

test("saved comparison remains labeled offline using the current cycling limit", async ({
  page,
  context,
}) => {
  await production(page);
  await page.locator("#tab-settings").click();
  await page.locator("#maxCyclingMinutes").fill("30");
  await page.locator("#save-settings").click();
  await plan(page);
  await page.getByRole("button", { name: /Fahrradvergleich:/ }).click();
  await expect(page.locator("#cycling-comparison")).toContainText(
    "2 Min. über deinem Radlimit",
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
          const r = indexedDB.open("foldroute-offline");
          r.onsuccess = () => resolve(r.result);
        });
        const saved = await new Promise<any>((resolve) => {
          const r = db.transaction("state").objectStore("state").get("last");
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return saved?.journey.isDirect;
      }),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.goto(root);
  await expect(page.locator("#cycling-comparison")).toContainText(
    "2 Min. über deinem Radlimit",
  );
  await expect(page.locator("#status")).toContainText(
    "Keine Verbindung innerhalb deines Radlimits",
  );
});

test("planning deep link loads offline under the static subpath without replacing it with a saved trip", async ({
  page,
  context,
}) => {
  await production(page);
  await plan(page);
  const link = new URL(page.url());
  link.searchParams.set("toName", "Anderes Ziel");
  link.searchParams.set("to", "48.180000,11.620000");
  await context.setOffline(true);
  await page.goto(link.href);
  await expect(page.locator("#status")).toContainText("brauchst du Internet");
  await expect(page.locator("#saved-notice")).toBeHidden();
  await expect(page.locator("#refresh-route")).toBeDisabled();
  expect(page.url()).toBe(link.href);
  await page.reload();
  await expect(page.locator("#status")).toContainText("brauchst du Internet");
  expect(page.url()).toBe(link.href);
  await page.locator("#adjust-route").click();
  await expect(page.locator("#destination")).toHaveValue("Anderes Ziel");
  await page.locator("#cancel-adjust").click();
  await context.setOffline(false);
  const request = page.waitForRequest((r) =>
    r.url().includes("directModes=BIKE"),
  );
  await page.locator("#route-more").click();
  await page.locator("#refresh-route").click();
  expect(new URL((await request).url()).searchParams.get("toPlace")).toBe(
    "48.180000,11.620000",
  );
});

test("PWA history deduplicates repeated trips across an offline restart", async ({
  page,
  context,
}) => {
  await production(page);
  await plan(page);
  await page.locator("#close-route").click();
  await plan(page);
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await context.setOffline(true);
  await page.goto(root);
  await expect(page.locator("#saved-notice")).toBeVisible();
  await page.locator("#tab-history").click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-open").last().click();
  await expect(page.locator("#saved-notice")).toBeVisible();
  await expect(page.locator("#replan-saved")).toBeDisabled();
  await expect(page.locator("#map")).toHaveClass(/offline-map/);
});

test("installed shell resumes navigation and loads its map while fully offline", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
    (window as any).startupDialogOverlap = false;
    new MutationObserver(() => {
      const splash = document.getElementById("app-startup");
      if (document.querySelector("dialog[open]") && splash && !splash.hidden)
        (window as any).startupDialogOverlap = true;
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
  });
  await production(page);
  await page.clock.setFixedTime(new Date());
  await page.evaluate(async (settings) => {
    const origin = {
      name: "Start",
      detail: "",
      latitude: 48.132,
      longitude: 11.5756,
    };
    const destination = {
      name: "Ziel",
      detail: "",
      latitude: 48.133,
      longitude: 11.5766,
    };
    const now = Date.now() / 1000;
    const journey = {
      id: "offline-navigation",
      origin,
      destination,
      departure: now,
      arrival: now + 100,
      transfers: 0,
      isDirect: true,
      legs: [
        {
          kind: "bike",
          navigationId: "bike",
          from: origin,
          to: destination,
          start: now,
          end: now + 100,
          distance: 150,
          coordinates: [origin, destination],
        },
      ],
    };
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("foldroute-offline", 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction("state", "readwrite");
        tx.objectStore("state").put(
          {
            version: 1,
            savedAt: now,
            journey,
            settings,
            request: { origin, destination, timing: "now", time: now },
            progress: {
              legIndex: 0,
              maneuverIndex: 0,
              meters: 0,
              confirmedStops: [],
            },
          },
          "activeNavigation",
        );
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  }, defaults);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#navigation-resume-dialog")).toBeVisible();
  expect(await page.evaluate(() => (window as any).startupDialogOverlap)).toBe(
    false,
  );
  await page.locator("#navigation-resume").click();
  await expect(page.locator("#navigation-instruction")).toHaveText("Nach Ziel");
  await expect(page.locator("#navigation-map canvas")).toBeVisible();
  await expect(page.locator("#navigation-network-status")).toContainText(
    "Offline",
  );
  await expect(page.locator("#update-banner")).toBeHidden();
  await page.locator("#navigation-end").click();
  await page.locator("#navigation-confirm-yes").click();
  await expect(page.locator("#map-view")).toBeVisible();
});
