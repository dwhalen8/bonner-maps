/**
 * Join structure addresses onto parcels, then write the map FeatureCollection
 * and compact search index.
 */
import { createReadStream } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GridIndex, geomBBox, pointInGeom } from "./spatial.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARCELS = join(ROOT, "raw", "parcels.geojsonl");
const ADDRESSES = join(ROOT, "raw", "addresses.geojsonl");
const OUTPUT = join(ROOT, "public", "data", "parcels.geojson");
const SEARCH = join(ROOT, "public", "data", "search-index.json");
const META = join(ROOT, "public", "data", "meta.json");

async function readJsonl(path) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function formatAddress(addr, city) {
  if (!addr) return "";
  if (city && city !== "Unincorporated" && !addr.toLowerCase().includes(city.toLowerCase())) {
    return `${addr}, ${city}`;
  }
  return addr;
}

async function main() {
  await access(PARCELS);
  const features = await readJsonl(PARCELS);
  console.log(`Loaded ${features.length} parcels`);

  let addresses = [];
  try {
    await access(ADDRESSES);
    addresses = await readJsonl(ADDRESSES);
    console.log(`Loaded ${addresses.length} addresses`);
  } catch {
    console.warn("No address file — run npm run data:fetch first");
  }

  const grid = new GridIndex(0.012);
  const bboxes = features.map((f) => geomBBox(f.geometry));
  features.forEach((_, i) => grid.insert(i, bboxes[i]));

  const byParcel = new Map();
  let matched = 0;
  const unmatched = [];

  for (const row of addresses) {
    if (row.lng == null || row.lat == null) continue;
    const candidates = grid.query(row.lng, row.lat);
    let hit = -1;
    for (const i of candidates) {
      if (pointInGeom(row.lng, row.lat, features[i].geometry)) {
        hit = i;
        break;
      }
    }
    if (hit < 0) {
      unmatched.push(row);
      continue;
    }
    matched += 1;
    const list = byParcel.get(hit) ?? [];
    list.push(row);
    byParcel.set(hit, list);
  }
  console.log(`Joined ${matched} addresses onto parcels (${unmatched.length} unmatched)`);

  const search = [];
  const land = {};
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties;
    land[props.land] = (land[props.land] || 0) + 1;
    const addrs = byParcel.get(i) ?? [];
    const primary = addrs[0];
    const addr = primary ? formatAddress(primary.addr, primary.city) : "";
    props.addr = addr;
    props.naddr = addrs.length;
    if (addrs.length > 1) {
      props.addrs = addrs
        .slice(0, 6)
        .map((a) => formatAddress(a.addr, a.city))
        .join(" · ");
    } else {
      props.addrs = "";
    }
    search.push({
      pin: props.pin,
      o: props.o1,
      o2: props.o2,
      a: props.acres,
      k: props.land,
      lng: primary?.lng ?? null,
      lat: primary?.lat ?? null,
      addr,
    });
    if (!search[search.length - 1].lng) {
      const geom = features[i].geometry;
      const ring = geom?.type === "Polygon" ? geom.coordinates[0] : geom?.coordinates?.[0]?.[0];
      if (ring?.[0]) {
        search[search.length - 1].lng = Number(ring[0][0].toFixed(5));
        search[search.length - 1].lat = Number(ring[0][1].toFixed(5));
      }
    }
  }

  for (const row of unmatched) {
    search.push({
      pin: "",
      o: "",
      o2: "",
      a: 0,
      k: "private",
      lng: row.lng,
      lat: row.lat,
      addr: formatAddress(row.addr, row.city),
    });
  }

  search.sort((a, b) => (a.addr || a.o).localeCompare(b.addr || b.o) || a.pin.localeCompare(b.pin));

  const fc = {
    type: "FeatureCollection",
    name: "Bonner County Parcels",
    features,
  };
  await writeFile(OUTPUT, JSON.stringify(fc));
  await writeFile(SEARCH, JSON.stringify(search));
  await writeFile(
    META,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        source:
          "Bonner County GIS — Cadastral_Public parcels + Addressing_Public structures",
        sourceUrl:
          "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Cadastral_Public/MapServer/0",
        addressUrl:
          "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/Addressing_Public/MapServer/0",
        count: features.length,
        addresses: addresses.length,
        addressesMatched: matched,
        land,
        disclaimer:
          "Assessor maps are for reference only and are not a legal survey. Do not use them to set fences, corners, or property lines.",
      },
      null,
      2,
    ),
  );

  const mb = (Buffer.byteLength(JSON.stringify(fc)) / (1024 * 1024)).toFixed(1);
  console.log(`Wrote ${features.length} parcels (${mb} MB) and ${search.length} search rows`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
