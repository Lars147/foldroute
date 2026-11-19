import { test, expect } from "./test";
import { setup as setupNavigation } from "./navigation-fixture";
import { waitForAppReady } from "./app-fixture";
async function open(page: import("./test").Page) {
  await page.route("https://tiles.openfreemap.org/**", (r) => r.abort());
  await page.goto("/");
  await waitForAppReady(page);
  await expect(page.getByLabel("Weitere Aktionen: Suche")).toBeVisible();
}
async function report(page: import("./test").Page) {
  await page.getByLabel("Weitere Aktionen: Suche").click();
  await page
    .getByRole("button", { name: "Problem melden", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Problem melden",
    exact: true,
  });
  // A closed dialog remains painted during its exit transition.
  await expect(dialog).toHaveAttribute("open", "");
  await expect(dialog).toBeVisible();
}
test("capture does not erase typed feedback and Back preserves current page", async ({
  page,
}) => {
  await open(page);
  await report(page);
  await page.locator("#feedback-message").fill("Falscher Hinweis");
  await expect(page.locator("#feedback-message")).toHaveValue(
    "Falscher Hinweis",
  );
  await expect(page.locator(".feedback-preview")).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toBeHidden();
  await expect(page.locator("#search-view")).toBeVisible();
});
for (const viewport of [
  { width: 390, height: 664 },
  { width: 844, height: 390 },
  { width: 1280, height: 600 },
])
  test(`search feedback stays tappable with a compact intro at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await open(page);
    await expect(page.locator("#search-view")).toHaveClass(/compact/);
    const menu = await page.getByLabel("Weitere Aktionen: Suche").boundingBox();
    expect(menu).not.toBeNull();
    expect(menu!.y).toBeGreaterThanOrEqual(0);
    expect(menu!.y + menu!.height).toBeLessThanOrEqual(viewport.height);
    expect(menu!.height).toBeGreaterThanOrEqual(44);
    if (viewport.width < 900) {
      const chevron = await page
        .locator("#search-adjust > :last-child")
        .boundingBox();
      expect(chevron).not.toBeNull();
      expect(chevron!.x + chevron!.width).toBeLessThanOrEqual(menu!.x);
    }
    await report(page);
    await expect(page.locator("#feedback-message")).toBeVisible();
  });
test("image preserves horizontal and vertical scroll inside panels", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const panel = document.createElement("div");
    panel.id = "feedback-scroll-probe";
    panel.style.cssText =
      "position:fixed;top:100px;left:40px;width:120px;height:120px;overflow:scroll;z-index:9999";
    const content = document.createElement("div");
    content.style.cssText =
      "display:grid;grid-template-columns:repeat(3,120px);grid-template-rows:repeat(3,120px);width:360px;height:360px";
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement("div");
      cell.style.backgroundColor =
        i === 4 ? "rgb(17,199,83)" : "rgb(240,20,20)";
      content.append(cell);
    }
    panel.append(content);
    document.body.append(panel);
    panel.scrollTop = panel.scrollLeft = 120;
  });
  await report(page);
  const result = await page
    .locator(".feedback-preview")
    .evaluate(async (preview: HTMLImageElement) => {
      await preview.decode();
      const canvas = document.createElement("canvas");
      canvas.width = preview.naturalWidth;
      canvas.height = preview.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(preview, 0, 0);
      const pixel = context.getImageData(
        Math.round((100 * canvas.width) / innerWidth),
        Math.round((160 * canvas.height) / innerHeight),
        1,
        1,
      ).data;
      const panel = document.getElementById("feedback-scroll-probe")!;
      return {
        pixel: [...pixel],
        top: panel.scrollTop,
        left: panel.scrollLeft,
      };
    });
  expect(result).toEqual({ pixel: [17, 199, 83, 255], top: 120, left: 120 });
});
for (const closing of ["button", "back during capture"] as const)
  test(`view changes during capture preserve one history entry per view: ${closing}`, async ({
    page,
  }) => {
    await open(page);
    await page.locator("#tab-settings").click();
    await page.evaluate(async () => {
      const { configureFeedback } = await import("/src/feedback-controller.ts");
      await configureFeedback({
        read: () => ({ origin: "settings" }),
        revision: () => document.body.dataset.view ?? "search",
        frame: () =>
          new Promise<string | undefined>((resolve) => {
            (
              window as Window & { releaseFeedbackFrame?: () => void }
            ).releaseFeedbackFrame = () => resolve(undefined);
          }),
      });
    });
    await page
      .locator("#settings-view")
      .getByRole("button", {
        name: "Weitere Aktionen: Einstellungen",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Problem melden", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        typeof (window as Window & { releaseFeedbackFrame?: () => void })
          .releaseFeedbackFrame === "function",
    );
    await page.locator("#tab-history").click();
    const dialog = page.getByRole("dialog", {
      name: "Problem melden",
      exact: true,
    });
    if (closing === "back during capture") await page.goBack();
    await page.evaluate(() =>
      (
        window as Window & { releaseFeedbackFrame?: () => void }
      ).releaseFeedbackFrame?.(),
    );
    if (closing === "button") {
      await expect(dialog).toHaveAttribute("open", "");
      await dialog
        .getByRole("button", { name: "Schließen", exact: true })
        .click();
    }
    await expect(page.locator("dialog[data-feedback-ui]")).not.toHaveAttribute(
      "open",
    );
    await expect
      .poll(() => page.evaluate(() => history.state?.feedbackId))
      .toBeFalsy();
    await expect(page.locator("#history-view")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => history.state?.view))
      .toBe("history");
    await page.goBack();
    await expect(page.locator("#settings-view")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#search-view")).toBeVisible();
    await page.goForward();
    await expect(page.locator("#settings-view")).toBeVisible();
    await page.goForward();
    await expect(page.locator("#history-view")).toBeVisible();
  });
test("failure from a delayed submission does not overwrite a newer report", async ({
  page,
}) => {
  await open(page);
  await page.route("**/envelope/**", (route) =>
    route.fulfill({
      status: 503,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "Unavailable",
    }),
  );
  await report(page);
  await page.locator("#feedback-message").fill("Bericht A");
  await page.evaluate(async () => {
    let started!: () => void;
    const beginning = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => {
      (
        window as Window & { releaseFeedbackLock?: () => void }
      ).releaseFeedbackLock = resolve;
    });
    void navigator.locks.request("foldroute-feedback", async () => {
      started();
      await gate;
    });
    await beginning;
  });
  await page
    .getByRole("button", { name: "Feedback senden", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.locks.query()).pending?.some(
          (lock) => lock.name === "foldroute-feedback",
        ),
      ),
    )
    .toBe(true);
  const dialog = page.getByRole("dialog", {
    name: "Problem melden",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => history.state?.feedbackId))
    .toBeFalsy();
  await report(page);
  await page.locator("#feedback-message").fill("Bericht B");
  await page.evaluate(() => {
    (
      window as Window & { releaseFeedbackLock?: () => void }
    ).releaseFeedbackLock?.();
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (await import("/src/feedback-outbox.ts")).readOutbox()).error,
      ),
    )
    .toContain("503");
  await expect(dialog.getByRole("status")).not.toContainText("503");
  await expect(page.locator("#feedback-message")).toHaveValue("Bericht B");
});
test("offline report survives reload with its original version and can be deleted", async ({
  page,
  context,
}) => {
  await open(page);
  await report(page);
  await context.setOffline(true);
  await page.locator("#feedback-message").fill("Offlineproblem");
  await page
    .getByRole("button", { name: "Feedback senden", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "vorgemerkt" }),
  ).toBeVisible();
  const read = () =>
    page.evaluate(async () =>
      (await import("/src/feedback-outbox.ts")).readOutbox(),
    );
  const before = await read();
  expect(before.reports).toHaveLength(1);
  expect(before.reports[0].release).toBeTruthy();
  await context.setOffline(false);
  await page.route("**/envelope/**", (r) => r.abort());
  await page.reload();
  await waitForAppReady(page);
  expect((await read()).reports[0].id).toBe(before.reports[0].id);
  await page.locator("#tab-settings").click();
  await expect(
    page.getByRole("region", { name: "Offenes Feedback" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Meldung löschen", exact: true })
    .click();
  await expect.poll(async () => (await read()).reports.length).toBe(0);
});
test("delete a waiting report takes precedence over next queued send", async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { enqueue, drainFeedback, deleteFeedback, readOutbox } =
      await import("/src/feedback-outbox.ts");
    const epoch = (await readOutbox()).epoch;
    const make = (id: string) => ({
      version: 1 as const,
      id: id.repeat(32),
      capturedAt: new Date().toISOString(),
      release: "A",
      environment: "test",
      message: id,
    });
    await enqueue(make("a"), epoch);
    await enqueue(make("b"), epoch);
    let release!: () => void;
    let started!: () => void;
    const beginning = new Promise<void>((r) => (started = r));
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const draining = drainFeedback(async (report) => {
      sent.push(report.message);
      if (report.message === "a") {
        started();
        await gate;
      }
    });
    await beginning;
    const deleting = deleteFeedback("b".repeat(32));
    release();
    await Promise.all([draining, deleting]);
    return { sent, left: (await readOutbox()).reports.length };
  });
  expect(result).toEqual({ sent: ["a"], left: 0 });
});
test("clear invalidates an already captured report", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const { enqueue, readOutbox } = await import("/src/feedback-outbox.ts");
    const { localDatabase } = await import("/src/storage.ts");
    const epoch = (await readOutbox()).epoch;
    await localDatabase.clearAll();
    try {
      await enqueue(
        {
          version: 1,
          id: "a".repeat(32),
          capturedAt: new Date().toISOString(),
          release: "A",
          environment: "test",
          message: "stale",
        },
        epoch,
      );
      return "accepted";
    } catch {
      return "rejected";
    }
  });
  expect(result).toBe("rejected");
});
test("origin captures open mobile suggestions before entering feedback", async ({
  page,
}) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/v1/geocode?*", (r) =>
    r.fulfill({ json: [{ name: "Testort", lat: 48, lon: 11 }] }),
  );
  await page.locator("#destination").fill("Test");
  await expect(page.locator("#destination-options")).toContainText("Testort");
  await expect(page.getByLabel("Weitere Aktionen: Suche")).toBeVisible();
  await report(page);
  const value = await page.evaluate(async () => {
    const { feedbackCapture } = await import("/src/feedback-controller.ts");
    let value: unknown;
    const unsubscribe = feedbackCapture.subscribe((v) => (value = v));
    unsubscribe();
    return value;
  });
  expect(JSON.stringify(value)).toContain("Testort");
});
for (const mode of ["accepted", "failure", "limited"] as const)
  test(`sender requires HTTP acknowledgement and preserves captured release: ${mode}`, async ({
    page,
  }) => {
    await open(page);
    let body = "";
    await page.route("https://feedback.invalid/**", async (r) => {
      body = r.request().postData() ?? "";
      await r.fulfill({
        status: mode === "failure" ? 500 : 200,
        headers:
          mode === "limited"
            ? {
                "X-Sentry-Rate-Limits": "60:feedback:organization",
                "Access-Control-Expose-Headers":
                  "X-Sentry-Rate-Limits,Retry-After",
              }
            : {},
        body: "{}",
      });
    });
    const result = await page.evaluate(async () => {
      const { sendFeedback } = await import("/src/feedback-sender.ts");
      try {
        await sendFeedback({
          version: 1,
          id: "e".repeat(32),
          capturedAt: new Date().toISOString(),
          release: "original-build",
          environment: "test",
          message: "synthetic",
          context: { value: "original-context" },
          image: new Blob(["image-fixture"], { type: "image/png" }),
        });
        return "accepted";
      } catch {
        return "rejected";
      }
    });
    expect(result).toBe(mode === "accepted" ? "accepted" : "rejected");
    expect(body).toContain("original-build");
    expect(body).toContain("diagnose.json");
    expect(body).toContain("ansicht.png");
    expect(body).not.toContain("shareText");
  });
test("manual retry cannot bypass a persisted server backoff", async ({
  page,
}) => {
  await open(page);
  const calls = await page.evaluate(async () => {
    const { enqueue, drainFeedback, readOutbox, FeedbackRetry } =
      await import("/src/feedback-outbox.ts");
    const epoch = (await readOutbox()).epoch;
    await enqueue(
      {
        version: 1,
        id: "f".repeat(32),
        capturedAt: new Date().toISOString(),
        release: "test",
        environment: "test",
        message: "limited",
      },
      epoch,
    );
    let calls = 0;
    const sender = async () => {
      calls++;
      throw new FeedbackRetry(60000);
    };
    await drainFeedback(sender).catch(() => {});
    await drainFeedback(sender, true).catch(() => {});
    return calls;
  });
  expect(calls).toBe(1);
  await page.locator("#tab-settings").click();
  await expect(
    page.getByRole("region", { name: "Offenes Feedback" }),
  ).toContainText("Versand pausiert bis");
});
test("a reduced visual viewport sends diagnosis without an inaccurate image", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    Object.defineProperty(window, "visualViewport", {
      value: {
        width: 390,
        height: 300,
        offsetTop: 80,
        offsetLeft: 0,
        scale: 1,
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
    }),
  );
  await report(page);
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toContainText("Bild bei Bildschirmtastatur");
  await expect(page.locator(".feedback-preview")).toHaveCount(0);
});
test("Back closes feedback before the active navigation end confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupNavigation(page);
  await page.getByLabel("Weitere Aktionen: Navigation").click();
  await page
    .getByRole("button", { name: "Problem melden", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toBeHidden();
  await expect(page.locator("#navigation-instruction")).toBeVisible();
  await expect(page.locator("#navigation-end-dialog")).not.toBeVisible();
});
test("a view change during capture discards the image without replacing the origin", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const { configureFeedback } = await import("/src/feedback-controller.ts");
    await configureFeedback({
      read: () => ({ origin: "search" }),
      revision: () => document.body.dataset.view ?? "search",
      frame: () =>
        new Promise<string | undefined>(
          (r) => ((window as any).releaseFeedbackFrame = () => r(undefined)),
        ),
    });
  });
  await page.getByLabel("Weitere Aktionen: Suche").click();
  await page
    .getByRole("button", { name: "Problem melden", exact: true })
    .click();
  await expect(page.getByText("Ansicht wird erfasst …")).toBeVisible();
  await page.waitForFunction(
    () => typeof (window as any).releaseFeedbackFrame === "function",
  );
  await page.locator("#tab-history").click();
  await page.evaluate(() => (window as any).releaseFeedbackFrame());
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toContainText("inzwischen gewechselt");
  await expect(page.locator(".feedback-preview")).toHaveCount(0);
});
test("no network before Send and text-only feedback excludes image, context and URL queries", async ({
  page,
}) => {
  let body = "";
  let requests = 0;
  await page.route("https://feedback.invalid/**", (r) => {
    requests++;
    body = r.request().postData() ?? "";
    return r.fulfill({ status: 200, body: "{}" });
  });
  await open(page);
  await page.evaluate(() =>
    history.replaceState(
      history.state,
      "",
      "?shareText=private-query-sentinel",
    ),
  );
  await report(page);
  expect(requests).toBe(0);
  await page.getByRole("checkbox", { name: "Diagnose mitsenden" }).uncheck();
  await page.getByRole("checkbox", { name: "Bild mitsenden" }).uncheck();
  await page.locator("#feedback-message").fill("Nur Text");
  await page
    .getByRole("button", { name: "Feedback senden", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toContainText("Feedback gesendet.");
  expect(requests).toBe(1);
  expect(body).not.toContain("diagnose.json");
  expect(body).not.toContain("ansicht.png");
  expect(body).not.toContain("private-query-sentinel");
});
for (const interrupted of ["hidden", "offline"] as const)
  test(`waiting sender rechecks ${interrupted} after acquiring the lock`, async ({
    page,
  }) => {
    await open(page);
    const sent = await page.evaluate(async (interrupted) => {
      const { enqueue, drainFeedback, readOutbox } =
        await import("/src/feedback-outbox.ts");
      const epoch = (await readOutbox()).epoch;
      await enqueue(
        {
          version: 1,
          id: "d".repeat(32),
          capturedAt: new Date().toISOString(),
          release: "test",
          environment: "test",
          message: "pending",
        },
        epoch,
      );
      let release!: () => void;
      let grant!: () => void;
      const granted = new Promise<void>((r) => (grant = r));
      const gate = new Promise<void>((r) => (release = r));
      const holder = navigator.locks.request("foldroute-feedback", async () => {
        grant();
        await gate;
      });
      await granted;
      let calls = 0;
      const draining = drainFeedback(async () => {
        calls++;
      });
      if (interrupted === "hidden")
        Object.defineProperty(document, "hidden", {
          value: true,
          configurable: true,
        });
      else
        Object.defineProperty(navigator, "onLine", {
          value: false,
          configurable: true,
        });
      release();
      await Promise.all([holder, draining]);
      return calls;
    }, interrupted);
    expect(sent).toBe(0);
  });
test("viewport changes while awaiting the map frame discard the image", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    const { configureFeedback } = await import("/src/feedback-controller.ts");
    await configureFeedback({
      read: () => ({ origin: "search" }),
      revision: () => "",
      frame: () =>
        new Promise<string | undefined>(
          (r) => ((window as any).releaseFeedbackFrame = () => r(undefined)),
        ),
    });
  });
  await page.getByLabel("Weitere Aktionen: Suche").click();
  await page
    .getByRole("button", { name: "Problem melden", exact: true })
    .click();
  await page.waitForFunction(
    () => typeof (window as any).releaseFeedbackFrame === "function",
  );
  await page.evaluate(() => {
    Object.defineProperty(window, "visualViewport", {
      value: {
        width: 390,
        height: 300,
        offsetTop: 80,
        offsetLeft: 0,
        scale: 1,
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
    });
    (window as any).releaseFeedbackFrame();
  });
  await expect(
    page.getByRole("dialog", { name: "Problem melden", exact: true }),
  ).toContainText("Bild bei Bildschirmtastatur");
  await expect(page.locator(".feedback-preview")).toHaveCount(0);
});
