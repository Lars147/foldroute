import { expect, test } from "./test";
import { previewNavigation } from "./navigation-preview";

test("speech is intercepted before document scripts in pages, frames and popups", async ({
  context,
  page,
}) => {
  await context.route("**/silent-speech*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
        if (!window.testSpeech) throw new Error("Speech mock missing");
        speechSynthesis.speak(new SpeechSynthesisUtterance(location.search));
      </script><a href="/silent-speech?popup" target="_blank">Open popup</a>`,
    }),
  );
  await page.goto("/silent-speech?page");
  expect(await page.evaluate(() => window.testSpeech.spoken)).toEqual([
    "?page",
  ]);
  await page.reload();
  expect(await page.evaluate(() => window.testSpeech.spoken)).toEqual([
    "?page",
  ]);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.src = "/silent-speech?frame";
    document.body.append(frame);
  });
  const frame = page.frameLocator("iframe");
  await expect
    .poll(() => frame.locator("body").evaluate(() => window.testSpeech.spoken))
    .toEqual(["?frame"]);
  const popupReady = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open popup" }).click();
  const popup = await popupReady;
  await expect
    .poll(() => popup.evaluate(() => window.testSpeech?.spoken))
    .toEqual(["?popup"]);
  expect(await page.evaluate(() => window.testSpeech.spoken)).toEqual([
    "?page",
  ]);
});

test("prepared navigation records speech while its audio controls remain enabled", async ({
  page,
}) => {
  await previewNavigation(page);
  const audio = page.locator("#navigation-audio");
  await expect(audio).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.testSpeech.spoken)).toContain(
    "Navigation wird vorbereitet",
  );
  await audio.click();
  await expect(audio).toHaveAttribute("aria-pressed", "false");
  const muted = await page.evaluate(() => window.testSpeech.spoken.length);
  await audio.click();
  await expect(audio).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.testSpeech.spoken.length)).toBe(
    muted + 1,
  );
});
