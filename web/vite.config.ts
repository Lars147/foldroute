import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  base: "./",
  plugins: [
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
        globPatterns: ["**/*.{html,js,css,svg,png,ico,webmanifest}"],
        navigateFallback: "index.html",
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
