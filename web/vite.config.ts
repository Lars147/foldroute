import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const landingRoot = fileURLToPath(new URL("../docs", import.meta.url));
const startupMark = fileURLToPath(
  new URL("./public/foldroute-mark.svg", import.meta.url),
);
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
      name: "foldroute-startup-mark",
      async transformIndexHtml(html) {
        const placeholder = "<!-- startup-mark -->";
        if (!html.includes(placeholder)) return;
        const svg = (await readFile(startupMark, "utf8"))
          .replace(/<\?xml[^>]*\?>\s*/, "")
          .replaceAll("#F5F6F3", "currentColor");
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
      name: "foldroute-splash-preview",
      apply: "serve",
      transformIndexHtml() {
        return [
          {
            tag: "meta",
            attrs: { name: "foldroute-dev", content: "true" },
            injectTo: "head-prepend",
          },
        ];
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, "http://localhost");
          if (url.pathname === "/splash-preview") {
            response.writeHead(302, { Location: "/splash-preview/" });
            response.end();
            return;
          }
          if (url.pathname !== "/splash-preview/") return next();
          void readFile(
            new URL("./preview/splash.html", import.meta.url),
            "utf8",
          )
            .then((html) => server.transformIndexHtml(url.pathname, html))
            .then((html) => {
              response.setHeader("Content-Type", "text/html; charset=utf-8");
              response.end(html);
            })
            .catch(next);
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
      name: "foldroute-landing-preview",
      apply: "serve",
      configureServer(server) {
        server.watcher.add(landingRoot);
        server.watcher.on("change", (path) => {
          if (
            path.startsWith(landingRoot + sep) &&
            !path.startsWith(resolve(landingRoot, "plan") + sep)
          )
            server.ws.send({ type: "full-reload", path: "*" });
        });
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, "http://localhost");
          if (
            url.pathname === "/theme.css" ||
            url.pathname === "/appearance.js"
          ) {
            void readFile(resolve(landingRoot, url.pathname.slice(1)))
              .then((buffer) => {
                response.setHeader(
                  "Content-Type",
                  url.pathname.endsWith(".css")
                    ? "text/css"
                    : "text/javascript",
                );
                response.end(buffer);
              })
              .catch(next);
            return;
          }
          if (url.pathname === "/landing") {
            response.writeHead(302, { Location: "/landing/" });
            response.end();
            return;
          }
          if (!url.pathname.startsWith("/landing/")) return next();
          if (url.pathname.startsWith("/landing/plan/")) {
            response.writeHead(302, {
              Location:
                url.pathname.replace("/landing/plan/", "/") + url.search,
            });
            response.end();
            return;
          }
          const path = resolve(
            landingRoot,
            url.pathname.slice("/landing/".length) || "index.html",
          );
          if (!path.startsWith(landingRoot + sep)) return next();
          const types: Record<string, string> = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css",
            ".js": "text/javascript",
            ".svg": "image/svg+xml",
            ".png": "image/png",
          };
          void readFile(path)
            .then(async (buffer) => {
              response.setHeader(
                "Content-Type",
                types[extname(path)] ?? "application/octet-stream",
              );
              response.end(
                extname(path) === ".html"
                  ? await server.transformIndexHtml(
                      url.pathname,
                      buffer.toString(),
                    )
                  : buffer,
              );
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
