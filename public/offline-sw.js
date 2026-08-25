const DATA_CACHE = "bonner-map-data";
const TILE_CACHE = "bonner-map-tiles";
const APP_CACHE = "bonner-map-app";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function cacheNameFor(url) {
  const u = new URL(url);
  if (u.pathname.startsWith("/data/")) return DATA_CACHE;
  if (u.hostname.includes("nationalmap.gov") || u.hostname.includes("arcgisonline.com")) {
    return TILE_CACHE;
  }
  if (u.origin === self.location.origin) return APP_CACHE;
  return null;
}

async function cacheFirst(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) await cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const fallback = await cache.match("/");
    if (fallback) return fallback;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return;
  const name = cacheNameFor(event.request.url);
  if (!name) return;
  // Keep Vite module graph live while developing.
  if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@") || url.pathname.includes("node_modules")) {
    return;
  }
  event.respondWith(cacheFirst(event.request, name));
});
