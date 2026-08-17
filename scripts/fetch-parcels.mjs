/**
 * Download Bonner County parcels from the official public MapServer
 * and write a GeoJSON sequence + compact search index.
 *
 * Source: https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Cadastral_Public/MapServer/0
 */
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyOwner } from "./classify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "raw");
const PUBLIC_DATA = join(ROOT, "public", "data");
const LAYER =
  "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Cadastral_Public/MapServer/0/query";
const ADDRESS_LAYER =
  "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Addressing_Public/MapServer/0/query";
const COUNTY_OUTLINE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query";
const PAGE_SIZE = 2000;
const FIELDS = [
  "pin",
  "owner1",
  "owner2",
  "propclsdescr",
  "lglacres",
  "lastasmvalue",
  "taxcdarea",
  "deed1",
].join(",");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, attempt = 1) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    if (attempt < 6) {
      await sleep(800 * attempt);
      return fetchJson(url, attempt + 1);
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    x += pt[0];
    y += pt[1];
    n += 1;
  }
  if (!n) return null;
  return [x / n, y / n];
}

function featureCenter(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return ringCentroid(geom.coordinates[0] || []);
  if (geom.type === "MultiPolygon") {
    return ringCentroid(geom.coordinates[0]?.[0] || []);
  }
  return null;
}

function clean(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

async function fetchAddresses() {
  const countData = await fetchJson(
    `${ADDRESS_LAYER}?${new URLSearchParams({ where: "1=1", returnCountOnly: "true", f: "json" })}`,
  );
  const expected = Number(countData.count || 0);
  console.log(`County reports ${expected} structure addresses`);

  const outPath = join(RAW_DIR, "addresses.geojsonl");
  const out = createWriteStream(outPath);
  let offset = 0;
  let written = 0;

  while (true) {
    const params = new URLSearchParams({
      where: "1=1",
      outFields: "fulladdr,municipality,msag,Building",
      outSR: "4326",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      geometryPrecision: "6",
      returnGeometry: "true",
    });
    const page = await fetchJson(`${ADDRESS_LAYER}?${params}`);
    const features = page.features || [];
    if (!features.length) break;
    for (const feature of features) {
      const props = feature.properties || {};
      const addr = clean(props.fulladdr);
      if (!addr) continue;
      const geom = feature.geometry;
      let lng = null;
      let lat = null;
      if (geom?.type === "Point") {
        lng = geom.coordinates[0];
        lat = geom.coordinates[1];
      }
      out.write(
        `${JSON.stringify({
          addr,
          city: clean(props.msag) || clean(props.municipality),
          bldg: clean(props.Building),
          lng,
          lat,
        })}\n`,
      );
      written += 1;
    }
    offset += features.length;
    process.stdout.write(`\rDownloaded ${written}${expected ? ` / ${expected}` : ""} addresses`);
    if (features.length < PAGE_SIZE && !page.exceededTransferLimit) break;
    if (expected && offset >= expected) break;
  }

  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
  console.log(`\nWrote ${written} addresses to ${outPath}`);
  return written;
}

async function fetchCountyOutline() {
  const params = new URLSearchParams({
    where: "GEOID='16017'",
    outFields: "NAME,GEOID",
    outSR: "4326",
    f: "geojson",
  });
  const data = await fetchJson(`${COUNTY_OUTLINE}?${params}`);
  if (!data.features?.length) {
    console.warn("County outline download returned no features");
    return;
  }
  await writeFile(
    join(PUBLIC_DATA, "county.geojson"),
    JSON.stringify(data),
    "utf8",
  );
  console.log("Wrote county outline");
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(PUBLIC_DATA, { recursive: true });

  const parcelPath = join(RAW_DIR, "parcels.geojsonl");
  const skipParcels = existsSync(parcelPath) && process.env.FORCE !== "1";
  if (skipParcels) {
    console.log("Using existing parcel download (FORCE=1 to refresh)");
  } else {
  const countData = await fetchJson(
    `${LAYER}?${new URLSearchParams({ where: "1=1", returnCountOnly: "true", f: "json" })}`,
  );
  const expected = Number(countData.count || 0);
  console.log(`County reports ${expected} parcels`);

  const outPath = parcelPath;
  const out = createWriteStream(outPath);
  const search = [];
  const tallies = {};
  let offset = 0;
  let written = 0;

  while (true) {
    const params = new URLSearchParams({
      where: "1=1",
      outFields: FIELDS,
      outSR: "4326",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      geometryPrecision: "6",
      returnGeometry: "true",
    });
    const page = await fetchJson(`${LAYER}?${params}`);
    const features = page.features || [];
    if (!features.length) break;

    for (const feature of features) {
      const props = feature.properties || {};
      const owner1 = clean(props.owner1);
      const owner2 = clean(props.owner2);
      const land = classifyOwner(owner1, owner2);
      tallies[land] = (tallies[land] || 0) + 1;
      const acres = Number(props.lglacres) || 0;
      const value = Number(props.lastasmvalue) || 0;
      const pin = clean(props.pin);
      const slim = {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          pin,
          o1: owner1,
          o2: owner2 && owner2 !== "*" ? owner2 : "",
          acres,
          cls: clean(props.propclsdescr),
          value,
          tax: clean(props.taxcdarea),
          deed: clean(props.deed1),
          land,
        },
      };
      out.write(`${JSON.stringify(slim)}\n`);
      const center = featureCenter(feature.geometry);
      search.push({
        pin,
        o: owner1,
        o2: owner2 && owner2 !== "*" ? owner2 : "",
        a: acres,
        k: land,
        lng: center ? Number(center[0].toFixed(5)) : null,
        lat: center ? Number(center[1].toFixed(5)) : null,
      });
    }

    written += features.length;
    offset += features.length;
    process.stdout.write(`\rDownloaded ${written}${expected ? ` / ${expected}` : ""} parcels`);
    if (features.length < PAGE_SIZE && !page.exceededTransferLimit) break;
    if (expected && written >= expected) break;
  }

  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });
  console.log(`\nWrote ${written} features to ${outPath}`);
  console.log("Land mix:", tallies);
  } // end parcel download

  try {
    await fetchAddresses();
  } catch (err) {
    console.warn("Address download failed:", err.message);
  }

  try {
    await fetchCountyOutline();
  } catch (err) {
    console.warn("County outline failed:", err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
