import { COUNTY_BOUNDS } from "./types";

export const DATA_CACHE = "bonner-map-data";
export const TILE_CACHE = "bonner-map-tiles";
export const APP_CACHE = "bonner-map-app";

export const DATA_URLS = [
  "/data/parcels.geojson",
  "/data/search-index.json",
  "/data/meta.json",
  "/data/county.geojson",
];

const APP_URLS = ["/", "/manifest.webmanifest", "/icons/icon.svg"];

const TOPO =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile";

const MIN_ZOOM = 7;
const MAX_ZOOM = 13;

function lon2tile(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function lat2tile(lat: number, z: number) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  );
}

export function topoTileUrls() {
  const [[west, south], [east, north]] = COUNTY_BOUNDS;
  const urls: string[] = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const x0 = lon2tile(west, z);
    const x1 = lon2tile(east, z);
    const y0 = lat2tile(north, z);
    const y1 = lat2tile(south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        urls.push(`${TOPO}/${z}/${y}/${x}`);
      }
    }
  }
  return urls;
}

export function packTileCount() {
  return topoTileUrls().length;
}

async function cacheSize(name: string) {
  if (!("caches" in window)) return 0;
  const cache = await caches.open(name);
  const keys = await cache.keys();
  let bytes = 0;
  for (const req of keys) {
    const match = await cache.match(req);
    if (!match) continue;
    const buf = await match.clone().arrayBuffer();
    bytes += buf.byteLength;
  }
  return bytes;
}

export async function packStatus() {
  if (!("caches" in window)) {
    return { ready: false, bytes: 0, dataReady: false, tiles: 0, tileTarget: packTileCount() };
  }
  const data = await caches.open(DATA_CACHE);
  const tiles = await caches.open(TILE_CACHE);
  let dataReady = true;
  for (const url of DATA_URLS) {
    if (!(await data.match(url))) dataReady = false;
  }
  const tileKeys = await tiles.keys();
  const tileTarget = packTileCount();
  const bytes = (await cacheSize(DATA_CACHE)) + (await cacheSize(TILE_CACHE)) + (await cacheSize(APP_CACHE));
  return {
    ready: dataReady && tileKeys.length >= tileTarget * 0.9,
    dataReady,
    tiles: tileKeys.length,
    tileTarget,
    bytes,
  };
}

async function putAll(
  cache: Cache,
  urls: string[],
  onItem?: (done: number, total: number, label: string) => void,
  label = "",
) {
  let done = 0;
  const total = urls.length;
  const workers = 6;
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const i = cursor;
      cursor += 1;
      const url = urls[i];
      try {
        const res = await fetch(url, { cache: "reload", mode: "cors" });
        if (res.ok) await cache.put(url, res);
      } catch {
        // skip a missing tile
      }
      done += 1;
      onItem?.(done, total, label);
    }
  }

  await Promise.all(Array.from({ length: Math.min(workers, urls.length) }, () => worker()));
}

export async function saveOfflinePack(
  onProgress?: (done: number, total: number, label: string) => void,
) {
  await navigator.storage?.persist?.();
  const data = await caches.open(DATA_CACHE);
  const tiles = await caches.open(TILE_CACHE);
  const app = await caches.open(APP_CACHE);

  onProgress?.(0, 1, "app");
  await putAll(app, APP_URLS);
  await putAll(data, DATA_URLS, onProgress, "parcels");
  await putAll(tiles, topoTileUrls(), onProgress, "topo");
  return packStatus();
}

export async function registerOfflineWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/offline-sw.js");
  } catch {
    // production build may already have a workbox worker
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
