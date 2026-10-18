import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

export interface TestRelease {
  revision: number;
  failCheck: boolean;
  installDelay: number;
  checks: number;
  url: string;
}

/** Serve two real generated workers, including an obsolete asset in release one. */
export async function withUpdateServer(
  page: Page,
  run: (release: TestRelease) => Promise<void>,
) {
  const release: TestRelease = {
    revision: 1,
    failCheck: false,
    installDelay: 0,
    checks: 0,
    url: "",
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (!path.startsWith("/pwa/")) {
      response.writeHead(404).end();
      return;
    }
    const name = path.slice(5) || "index.html";
    if (name === "sw.js") {
      release.checks++;
      if (release.failCheck) {
        response.writeHead(503).end();
        return;
      }
    }
    let data: Buffer;
    try {
      data = await readFile(
        resolve(
          process.cwd(),
          "../docs/plan",
          name === "splash/legacy.png" ? "pwa-192x192.png" : name,
        ),
      );
    } catch {
      response.writeHead(404).end();
      return;
    }
    if (name === "sw.js") {
      if (release.revision === 1)
        data = Buffer.from(
          data
            .toString()
            .replace(
              "precacheAndRoute([",
              'precacheAndRoute([{url:"splash/legacy.png",revision:"legacy"},',
            ),
        );
      data = Buffer.concat([
        data,
        Buffer.from(
          `\n// Test release ${release.revision}\n` +
            (release.installDelay
              ? `self.addEventListener('install', event => event.waitUntil(new Promise(resolve => setTimeout(resolve, ${release.installDelay}))));\n`
              : ""),
        ),
      ]);
    }
    const type = name.endsWith(".js")
      ? "text/javascript"
      : name.endsWith(".css")
        ? "text/css"
        : name.endsWith(".html")
          ? "text/html"
          : name.endsWith(".webmanifest")
            ? "application/manifest+json"
            : name.endsWith(".svg")
              ? "image/svg+xml"
              : "image/png";
    response
      .writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" })
      .end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  release.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/pwa/`;
  try {
    await page.goto(release.url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await expect(page.locator("#app-startup")).toBeHidden();
    await run(release);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
