import { test, expect, type Page } from "./test";
import { componentDocument } from "./component-document";

interface SearchLifecycleProbe {
  mount(): void;
  dispose(): void;
  resetCounts(): void;
  counts(): { book: number; pause: number; selected: number; errors: number };
  favorite(name: string): Promise<void>;
  requestPause(): Promise<void>;
}

declare global {
  interface Window {
    searchLifecycle: SearchLifecycleProbe;
  }
}

async function mountSearchDocument(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-11-04T12:00:00Z") });
  await componentDocument(
    page,
    '<label for="search">Ort</label><input id="search" type="search"><ul id="search-options" hidden></ul><p id="search-status" role="status"></p>',
  );
  await page.route("**/__provider_pause", (route) =>
    route.fulfill({
      status: 429,
      headers: {
        "Retry-After": "60",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Retry-After",
      },
      body: "Limited",
    }),
  );
  await page.evaluate(async () => {
    const { PlaceSearch } = await import("/src/search.ts");
    const { PlaceBook } = await import("/src/places.ts");
    const { ApiClient } = await import("/src/transitous.ts");
    const { PlannerError } = await import("/src/model.ts");
    const book = new PlaceBook();
    const api = new ApiClient();
    const counts = { book: 0, pause: 0, selected: 0, errors: 0 };
    // Count actual publisher deliveries while retaining real subscribe/unsubscribe.
    const subscribeBook = book.subscribe.bind(book);
    book.subscribe = (listener) =>
      subscribeBook(() => {
        counts.book++;
        listener();
      });
    const subscribePause = api.onPause.bind(api);
    api.onPause = (listener) =>
      subscribePause((pause) => {
        counts.pause++;
        listener(pause);
      });
    let search: InstanceType<typeof PlaceSearch> | undefined;
    window.searchLifecycle = {
      mount() {
        if (search)
          throw new Error("Dispose the previous search before mounting");
        search = new PlaceSearch(
          "search",
          api,
          document.getElementById("search-status")!,
          () => {
            counts.selected++;
          },
          book,
          () => {
            counts.errors++;
          },
          {
            showCurrentLocation: false,
            focusDriven: true,
            getSearchCenter: () => ({ latitude: 48, longitude: 11 }),
          },
        );
      },
      dispose() {
        search?.dispose();
        search = undefined;
      },
      resetCounts() {
        counts.book = counts.pause = counts.selected = counts.errors = 0;
      },
      counts() {
        return { ...counts };
      },
      async favorite(name) {
        await book.change(
          { name, detail: "Test", latitude: 48, longitude: 11 },
          "favorite",
        );
      },
      async requestPause() {
        try {
          await api.json(
            new URL("/__provider_pause", location.href),
            new AbortController().signal,
          );
          throw new Error("Expected the recorded provider pause");
        } catch (error) {
          if (!(error instanceof PlannerError) || error.code !== "429")
            throw error;
        }
      },
    };
    window.searchLifecycle.mount();
  });
}

test("disposing search rejects a delayed provider response and removes focus/input behavior", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountSearchDocument(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requestSeen!: () => void;
  const requested = new Promise<void>((resolve) => {
    requestSeen = resolve;
  });
  let responseFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    responseFinished = resolve;
  });
  let requests = 0;
  await page.route("**/api/v1/geocode?*", async (route) => {
    requests++;
    requestSeen();
    await gate;
    await route.fulfill({
      headers: { "Access-Control-Allow-Origin": "*" },
      json: [{ name: "Ziel verspätet", lat: 48.1, lon: 11.1 }],
    });
    responseFinished();
  });
  const field = page.locator("#search");
  await field.fill("Ziel");
  await page.clock.runFor(300);
  await requested;
  await expect(page.locator("#search-status")).toHaveText(
    "Orte werden gesucht …",
  );
  await page.evaluate(() => window.searchLifecycle.dispose());
  release();
  await finished;
  await page.clock.runFor(1000);
  await expect(page.locator("#search-options")).toBeHidden();
  await expect(page.locator("#search-options .place-select")).toHaveCount(0);
  await expect(page.locator("#search-status")).toBeEmpty();
  await expect(field).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("body")).not.toHaveClass(/search-focus-mode/);
  await expect(page.locator(".search-focus-back")).toHaveCount(0);
  await field.fill("Andere Suche");
  await page.clock.runFor(1000);
  expect(requests).toBe(1);
  expect(await page.evaluate(() => window.searchLifecycle.counts())).toEqual({
    book: 0,
    pause: 0,
    selected: 0,
    errors: 0,
  });
});

test("repeated search mount/dispose retains one PlaceBook and API pause subscription", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await mountSearchDocument(page);
  await page.route("**/api/v1/geocode?*", (route) =>
    route.fulfill({
      status: 429,
      headers: {
        "Retry-After": "60",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Retry-After",
      },
      body: "Limited",
    }),
  );
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle) await page.evaluate(() => window.searchLifecycle.mount());
    await page.evaluate(() => window.searchLifecycle.resetCounts());
    await page.locator("#search").fill("");
    await page.locator("#search").focus();
    const name = `Favorit ${cycle}`;
    await page.evaluate((name) => window.searchLifecycle.favorite(name), name);
    const favorite = page.getByRole("button", {
      name: `Ort auswählen: ${name}, Test`,
      exact: true,
    });
    await expect(favorite).toHaveCount(1);
    await expect(favorite).toBeVisible();
    expect(
      (await page.evaluate(() => window.searchLifecycle.counts())).book,
    ).toBe(1);
    await page.locator("#search").fill("Ziel");
    await page.clock.runFor(300);
    await expect(page.locator("#search-status")).toContainText(
      "Anfragelimit erreicht",
    );
    await expect(page.locator("#search-status .retry-countdown")).toHaveCount(
      1,
    );
    expect(
      (await page.evaluate(() => window.searchLifecycle.counts())).pause,
    ).toBe(1);
    await page.evaluate(() => {
      window.searchLifecycle.dispose();
      window.searchLifecycle.dispose();
      window.searchLifecycle.resetCounts();
    });
    await page.clock.fastForward(61000);
    await page.evaluate(async (cycle) => {
      await window.searchLifecycle.favorite(`Nach Abbau ${cycle}`);
      await window.searchLifecycle.requestPause();
    }, cycle);
    expect(await page.evaluate(() => window.searchLifecycle.counts())).toEqual({
      book: 0,
      pause: 0,
      selected: 0,
      errors: 0,
    });
    await expect(page.locator("#search-status .retry-countdown")).toHaveCount(
      0,
    );
    await expect(page.locator("#search-options")).toBeHidden();
    await page.clock.fastForward(61000);
  }
});
