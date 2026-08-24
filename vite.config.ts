import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared/plan": path.join(root, "shared/plan.ts"),
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["icons/icon.svg", "icons/apple-touch-icon.png"],
      manifest: false,
      filename: "sw.js",
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,json,geojson,webmanifest}"],
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/data\//,
            handler: "CacheFirst",
            options: {
              cacheName: "bonner-map-data",
              expiration: {
                maxEntries: 12,
                maxAgeSeconds: 60 * 60 * 24 * 180,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/protomaps\.github\.io\/basemaps-assets\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "basemap-assets",
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/basemap\.nationalmap\.gov\/.*\/tile\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "bonner-map-tiles",
              expiration: {
                maxEntries: 8000,
                maxAgeSeconds: 60 * 60 * 24 * 180,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern:
              /^https:\/\/(server|services)\.arcgisonline\.com\/.*\/tile\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "bonner-map-tiles",
              expiration: {
                maxEntries: 8000,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
});
