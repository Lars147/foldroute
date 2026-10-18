import type { Page } from "@playwright/test";

// A real raster source makes disappearing basemap pixels observable without external services.
export async function mockRasterBasemap(page: Page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#0c965a";
    context.fillRect(0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const styles: string[] = [];
  await page.route("https://tiles.openfreemap.org/**", (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/styles/")) {
      styles.push(route.request().url());
      return route.fulfill({
        json: {
          version: 8,
          sources: {
            raster: {
              type: "raster",
              tiles: ["https://tiles.openfreemap.org/test/{z}/{x}/{y}.png"],
              tileSize: 256,
              maxzoom: 0,
            },
          },
          layers: [{ id: "raster", type: "raster", source: "raster" }],
        },
      });
    }
    return route.fulfill({
      contentType: "image/png",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: Buffer.from(png, "base64"),
    });
  });
  return styles;
}
