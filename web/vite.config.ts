import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const buildCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  encoding: "utf8",
}).trim();
const shortCommit = buildCommit.slice(0, 7);
const landingRoot = fileURLToPath(new URL("../docs", import.meta.url));
const startupMark = fileURLToPath(
  new URL("./public/foldroute-mark.svg", import.meta.url),
);
const licenseNoticePath = fileURLToPath(
  new URL("./public/licenses.html", import.meta.url),
);
const licensesModule = "virtual:foldroute-licenses";
export default defineConfig({
  optimizeDeps: {
    include: [
      "maplibre-gl",
      "@maplibre/maplibre-gl-leaflet",
      "ol-mapbox-style",
    ],
  },
  cacheDir: process.env.FOLDROUTE_TEST_PORT
    ? `node_modules/.vite-test-${process.env.FOLDROUTE_TEST_PORT}`
    : "node_modules/.vite",
  base: "./",
  plugins: [
    {
      name: "foldroute-license-notices",
      resolveId(id) {
        if (id === licensesModule) return `\0${licensesModule}`;
      },
      async load(id) {
        if (id !== `\0${licensesModule}`) return;
        this.addWatchFile(licenseNoticePath);
        return `export default ${JSON.stringify(await readFile(licenseNoticePath, "utf8"))}`;
      },
    },
    {
      name: "foldroute-build-version",
      transformIndexHtml(html) {
        return html.replace(
          "<!-- build-version -->",
          `<a id="app-version" href="https://github.com/Lars147/foldroute/commit/${buildCommit}" target="_blank" rel="noopener noreferrer" aria-label="Commit ${shortCommit} auf GitHub öffnen (neuer Tab)">${shortCommit}</a>`,
        );
      },
    },
    {
      name: "foldroute-startup-mark",
      async transformIndexHtml(html) {
        const placeholder = "<!-- startup-mark -->";
        if (!html.includes(placeholder)) return;
        let svg = (await readFile(startupMark, "utf8"))
          .replace(/<\?xml[^>]*\?>\s*/, "")
          .replaceAll("#F5F6F3", "currentColor");
        for (const [wheel, center] of [
          ["rear", 280],
          ["front", 740],
        ] as const) {
          const marker = `<g data-wheel="${wheel}">`;
          if (!svg.includes(marker))
            throw new Error(`Startup logo is missing its ${wheel} wheel group`);
          // Spokes belong to the moving splash, not to the shared static mark.
          svg = svg.replace(
            marker,
            `${marker}<path data-startup-spokes d="M${center - 100} 690H${center + 100}M${center} 590V790" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" opacity=".65"/>`,
          );
        }
        return html.replace(placeholder, svg);
      },
      configureServer(server) {
        server.watcher.add(startupMark);
        server.watcher.on("change", (path) => {
          if (path === startupMark)
            server.ws.send({ type: "full-reload", path: "*" });
        });
      },
    },
    {
      name: "foldroute-shared-theme",
      async generateBundle() {
        for (const fileName of ["theme.css", "appearance.js"])
          this.emitFile({
            type: "asset",
            fileName,
            source: await readFile(resolve(landingRoot, fileName), "utf8"),
          });
      },
    },
    {
      name: "foldroute-development-theme",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url!, "http://localhost").pathname;
          if (path !== "/theme.css" && path !== "/appearance.js") return next();
          void readFile(resolve(landingRoot, path.slice(1)))
            .then((buffer) => {
              response.setHeader(
                "Content-Type",
                path.endsWith(".css") ? "text/css" : "text/javascript",
              );
              response.end(buffer);
            })
            .catch(next);
        });
      },
    },
    VitePWA({
      strategies: "generateSW",
      injectRegister: false,
      registerType: "prompt",
      scope: "./",
      manifest: {
        id: "./",
        name: "FoldRoute",
        short_name: "FoldRoute",
        description: "Mit Faltrad und ÖPNV unterwegs.",
        lang: "de",
        start_url: "./",
        scope: "./",
        share_target: {
          action: "./",
          method: "GET",
          params: { title: "shareTitle", text: "shareText", url: "shareUrl" },
        },
        display: "standalone",
        background_color: "#f5f6f3",
        theme_color: "#f5f6f3",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{html,js,css,svg,png,ico,webmanifest,txt}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/\/(licenses|hilfe)\.html(?:\?|$)/],
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: { outDir: "../docs/plan", emptyOutDir: true },
  server: { port: 4173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
