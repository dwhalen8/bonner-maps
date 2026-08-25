import bbox from "@turf/bbox";
import bboxClip from "@turf/bbox-clip";
import buffer from "@turf/buffer";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import type {
  BBox,
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
} from "geojson";
import { asPolygon, parcelBbox } from "./geo";
import {
  shorelineSetbackFt,
  WETLAND_ADVISORY_FT,
} from "./setbacks";

export type TruncatedReason =
  | "feature_cap"
  | "byte_cap"
  | "timeout"
  | "cors"
  | "too_large_source";

export interface LayerClip {
  type: "FeatureCollection";
  features: Feature[];
  incomplete: boolean;
  fetchedAt: string;
  truncatedReason?: TruncatedReason;
}

export interface ConstraintClip {
  zoning: { zonedesc: string | null; fetchedAt: string };
  /** Display-only fill of ZoningLanduse/2. Never written to localStorage. */
  zoningFill: LayerClip;
  roads: LayerClip;
  drivewaysCounty: LayerClip;
  row: LayerClip;
  flood: LayerClip;
  wetlands: LayerClip;
  water: LayerClip;
  cityImpact: LayerClip;
}

const COUNTY =
  "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services";

/** Frozen public GIS layer URLs (no /query). */
export const GIS_LAYERS = {
  row: `${COUNTY}/Cadastral_Public/MapServer/5`,
  driveway: `${COUNTY}/Addressing_Public/MapServer/1`,
  roads: `${COUNTY}/Transportation_Public/MapServer/3`,
  roadsCounty: `${COUNTY}/Transportation_Public/MapServer/4`,
  roadsUsfs: `${COUNTY}/Transportation_Public/MapServer/5`,
  roadsOwner: `${COUNTY}/Transportation_Public/MapServer/7`,
  zoning: `${COUNTY}/ZoningLanduse_Public/MapServer/2`,
  cityImpact: `${COUNTY}/ZoningLanduse_Public/MapServer/0`,
  nfhl: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
  nwi: "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0",
  nhdFlowline: "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6",
  nhdWaterbody: "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12",
} as const;

const PAGE = 200;
const FEATURE_CAP = 200;
const ENCODED_CAP = 500 * 1024;
const RAW_CAP = 2 * 1024 * 1024;
const WALL_MS = 8000;
const OFFSET_DEG = "0.00005";

const emptyFc = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });

function emptyClip(reason?: TruncatedReason, extra?: Partial<LayerClip>): LayerClip {
  return {
    type: "FeatureCollection",
    features: [],
    incomplete: Boolean(reason),
    fetchedAt: new Date().toISOString(),
    truncatedReason: reason,
    ...extra,
  };
}

function nowIso() {
  return new Date().toISOString();
}

export interface QueryEnvelope {
  feature: Feature<Polygon | MultiPolygon>;
  bbox: BBox;
  rings: number[][][] | null;
  incomplete: boolean;
}

export function envelopeFromParcel(geom: Polygon | MultiPolygon): QueryEnvelope {
  try {
    const buffered = buffer(asPolygon(geom), 300, { units: "feet" });
    if (!buffered || (buffered.geometry.type !== "Polygon" && buffered.geometry.type !== "MultiPolygon")) {
      throw new Error("buffer empty");
    }
    const feature = buffered as Feature<Polygon | MultiPolygon>;
    return {
      feature,
      bbox: bbox(feature) as BBox,
      rings: feature.geometry.type === "Polygon" ? feature.geometry.coordinates : null,
      incomplete: false,
    };
  } catch {
    const [w, s, e, n] = parcelBbox(geom);
    const lat = (s + n) / 2;
    const padLat = 300 / 365215;
    const padLon = 300 / (365215 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const box: BBox = [w - padLon, s - padLat, e + padLon, n + padLat];
    const ring = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[2], box[3]],
      [box[0], box[3]],
      [box[0], box[1]],
    ];
    const feature: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [ring] },
    };
    return { feature, bbox: box, rings: [ring], incomplete: true };
  }
}

function hasGeometry(geom: Geometry | null | undefined): geom is Geometry {
  if (!geom) return false;
  switch (geom.type) {
    case "Point":
      return geom.coordinates.length >= 2;
    case "LineString":
      return geom.coordinates.length >= 2;
    case "MultiLineString":
      return geom.coordinates.some((line) => line.length >= 2);
    case "Polygon":
      return (geom.coordinates[0]?.length ?? 0) >= 4;
    case "MultiPolygon":
      return geom.coordinates.some((poly) => (poly[0]?.length ?? 0) >= 4);
    default:
      return false;
  }
}

function asFeature(raw: Feature): Feature | null {
  if (!raw || raw.type !== "Feature" || !hasGeometry(raw.geometry)) return null;
  return {
    type: "Feature",
    id: raw.id,
    properties: raw.properties ?? {},
    geometry: raw.geometry,
  };
}

function clipOne(feature: Feature, envelope: QueryEnvelope): Feature | null {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    const hit = intersect(
      featureCollection([
        feature as Feature<Polygon | MultiPolygon>,
        envelope.feature,
      ]),
      { properties: feature.properties ?? {} },
    );
    if (!hit || !hasGeometry(hit.geometry)) return null;
    return { ...hit, properties: feature.properties ?? {} };
  }
  if (geom.type === "Point") {
    const [x, y] = geom.coordinates;
    const [w, s, e, n] = envelope.bbox;
    if (x < w || x > e || y < s || y > n) return null;
    return feature;
  }
  if (
    geom.type === "LineString" ||
    geom.type === "MultiLineString"
  ) {
    const clipped = bboxClip(feature as Feature<GeoLine>, envelope.bbox);
    if (!clipped || !hasGeometry(clipped.geometry)) return null;
    return { ...clipped, properties: feature.properties ?? {} };
  }
  return null;
}

type GeoLine = import("geojson").LineString | import("geojson").MultiLineString;

interface EsriFc {
  type?: string;
  features?: Feature[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
  error?: { message?: string; code?: number };
}

function transferLimit(data: EsriFc) {
  return Boolean(data.exceededTransferLimit || data.properties?.exceededTransferLimit);
}

function isTypeError(err: unknown) {
  return err instanceof TypeError;
}

function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

const REASON_RANK: TruncatedReason[] = ["cors", "timeout", "too_large_source", "byte_cap", "feature_cap"];

function worseReason(a?: TruncatedReason, b?: TruncatedReason): TruncatedReason | undefined {
  if (!a) return b;
  if (!b) return a;
  return REASON_RANK.indexOf(a) <= REASON_RANK.indexOf(b) ? a : b;
}

async function withTimeout<T>(
  deadline: number,
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw parent.reason ?? new DOMException("Aborted", "AbortError");
  const remain = deadline - Date.now();
  if (remain <= 0) throw new DOMException("Timeout", "AbortError");
  const local = new AbortController();
  const timer = window.setTimeout(() => local.abort(), remain);
  const onParent = () => local.abort();
  parent.addEventListener("abort", onParent);
  try {
    return await run(local.signal);
  } finally {
    window.clearTimeout(timer);
    parent.removeEventListener("abort", onParent);
  }
}

async function probeDirect(layerUrl: string, signal: AbortSignal): Promise<"ok" | "cors"> {
  try {
    await fetch(`${layerUrl}?f=json`, { signal });
    return "ok";
  } catch (err) {
    if (isAbort(err)) throw err;
    if (isTypeError(err)) return "cors";
    throw err;
  }
}

interface LayerSpec {
  url: string;
  outFields: string;
  federal?: boolean;
  tag?: Record<string, unknown>;
}

async function queryPage(
  spec: LayerSpec,
  envelope: QueryEnvelope,
  offset: number,
  signal: AbortSignal,
): Promise<{ text: string; data: EsriFc }> {
  const params = new URLSearchParams({
    where: "1=1",
    geometryType: envelope.rings ? "esriGeometryPolygon" : "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: spec.outFields,
    returnGeometry: "true",
    outSR: "4326",
    geometryPrecision: "6",
    maxAllowableOffset: OFFSET_DEG,
    resultRecordCount: String(PAGE),
    resultOffset: String(offset),
    f: "geojson",
  });
  if (envelope.rings) {
    params.set(
      "geometry",
      JSON.stringify({ rings: envelope.rings, spatialReference: { wkid: 4326 } }),
    );
  } else {
    params.set("geometry", envelope.bbox.join(","));
  }
  const res = await fetch(`${spec.url}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal,
  });
  const text = await res.text();
  let data: EsriFc;
  try {
    data = JSON.parse(text) as EsriFc;
  } catch {
    data = { error: { message: "invalid json" } };
  }
  if (!res.ok || data.error) {
    const err = new Error(data.error?.message || `HTTP ${res.status}`);
    (err as Error & { http: true }).http = true;
    throw err;
  }
  return { text, data };
}

async function clipLayer(spec: LayerSpec, envelope: QueryEnvelope, signal: AbortSignal): Promise<LayerClip> {
  const fetchedAt = nowIso();
  // Clock starts at first network attempt (when the worker picks this layer up).
  const deadline = Date.now() + WALL_MS;
  if (spec.federal) {
    try {
      const probe = await withTimeout(deadline, signal, (s) => probeDirect(spec.url, s));
      if (probe === "cors") return emptyClip("cors", { fetchedAt });
    } catch (err) {
      if (signal.aborted) throw err;
      if (isAbort(err)) return emptyClip("timeout", { fetchedAt });
      if (isTypeError(err)) return emptyClip("cors", { fetchedAt });
      throw err;
    }
  }

  const kept: Feature[] = [];
  let incomplete = envelope.incomplete;
  let truncatedReason: TruncatedReason | undefined = envelope.incomplete ? "too_large_source" : undefined;
  let rawBytes = 0;
  let offset = 0;
  let skipThrows = false;
  let halt = false;

  try {
    while (!halt) {
      if (Date.now() > deadline) {
        incomplete = true;
        truncatedReason = worseReason(truncatedReason, "timeout");
        break;
      }
      const page = await withTimeout(deadline, signal, (s) => queryPage(spec, envelope, offset, s));

      rawBytes += page.text.length;
      const incoming = page.data.features ?? [];
      for (const raw of incoming) {
        const feat = asFeature(raw);
        if (!feat) continue;
        try {
          const clipped = clipOne(feat, envelope);
          if (!clipped) continue;
          if (spec.tag) clipped.properties = { ...(clipped.properties ?? {}), ...spec.tag };
          kept.push(clipped);
          if (kept.length >= FEATURE_CAP) {
            incomplete = true;
            truncatedReason = worseReason(truncatedReason, "feature_cap");
            halt = true;
            break;
          }
          if (JSON.stringify(kept).length >= ENCODED_CAP) {
            kept.pop();
            incomplete = true;
            truncatedReason = worseReason(truncatedReason, "byte_cap");
            halt = true;
            break;
          }
        } catch {
          skipThrows = true;
          incomplete = true;
        }
      }
      if (halt) break;
      if (rawBytes >= RAW_CAP) {
        incomplete = true;
        truncatedReason = worseReason(truncatedReason, "byte_cap");
        break;
      }
      const more = incoming.length >= PAGE || transferLimit(page.data);
      if (!more) break;
      offset += PAGE;
    }
  } catch (err) {
    if (isAbort(err) || signal.aborted) {
      if (!signal.aborted) {
        incomplete = true;
        truncatedReason = worseReason(truncatedReason, "timeout");
      } else throw err;
    } else if (isTypeError(err)) {
      return emptyClip("cors", { fetchedAt, features: kept, incomplete: true });
    } else {
      incomplete = true;
    }
  }

  if (skipThrows) incomplete = true;

  return {
    type: "FeatureCollection",
    features: kept,
    incomplete,
    fetchedAt,
    truncatedReason,
  };
}

function capClip(clip: LayerClip): LayerClip {
  let { features, incomplete, truncatedReason, fetchedAt } = clip;
  if (features.length > FEATURE_CAP) {
    features = features.slice(0, FEATURE_CAP);
    incomplete = true;
    truncatedReason = worseReason(truncatedReason, "feature_cap");
  }
  while (features.length && JSON.stringify(features).length >= ENCODED_CAP) {
    features = features.slice(0, -1);
    incomplete = true;
    truncatedReason = worseReason(truncatedReason, "byte_cap");
  }
  return { type: "FeatureCollection", features, incomplete, fetchedAt, truncatedReason };
}

function mergeClips(parts: LayerClip[], fetchedAt: string): LayerClip {
  const features: Feature[] = [];
  let incomplete = false;
  let truncatedReason: TruncatedReason | undefined;
  for (const part of parts) {
    features.push(...part.features);
    if (part.incomplete) incomplete = true;
    truncatedReason = worseReason(truncatedReason, part.truncatedReason);
  }
  return capClip({ type: "FeatureCollection", features, incomplete, fetchedAt, truncatedReason });
}

function normalizeNhd(feature: Feature, layer: 6 | 12): Feature {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  return {
    ...feature,
    properties: {
      ...props,
      nhdLayer: layer,
      gnis_name: props.gnis_name ?? props.GNIS_NAME ?? null,
      FCODE: props.FCODE ?? props.fcode ?? props.FCode ?? null,
      FTYPE: props.FTYPE ?? props.ftype ?? props.FType ?? null,
    },
  };
}

function normalizeRoad(feature: Feature): Feature {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  return {
    ...feature,
    properties: {
      ...props,
      fullname: props.fullname ?? props.st_name_full ?? props.name ?? props.fullname_abbr ?? null,
      roadclass: props.roadclass ?? props.oper_maint_level ?? props.owned_by ?? props.maint_by ?? null,
    },
  };
}

function normalizeNwi(feature: Feature): Feature {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  return {
    ...feature,
    properties: {
      ...props,
      WETLAND_TYPE: props.WETLAND_TYPE ?? props["Wetlands.WETLAND_TYPE"] ?? null,
      ATTRIBUTE: props.ATTRIBUTE ?? props["Wetlands.ATTRIBUTE"] ?? null,
    },
  };
}

let generation = 0;
let activeAbort: AbortController | null = null;

export function cancelConstraintOverlays() {
  generation += 1;
  activeAbort?.abort();
  activeAbort = null;
}

interface ClipJob {
  spec: LayerSpec;
  apply: (layer: LayerClip) => void;
}

async function runJobs(
  jobs: ClipJob[],
  limit: number,
  envelope: QueryEnvelope,
  signal: AbortSignal,
  gen: number,
) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= jobs.length) return;
      if (gen !== generation || signal.aborted) return;
      const job = jobs[idx];
      try {
        const layer = await clipLayer(job.spec, envelope, signal);
        if (gen !== generation) return;
        job.apply(layer);
      } catch {
        if (gen !== generation || signal.aborted) return;
        job.apply(emptyClip(undefined, { incomplete: true, fetchedAt: nowIso() }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()));
}

export async function fetchConstraintOverlays(
  geom: Polygon | MultiPolygon,
  zoningLabel: string | null = null,
  onPartial?: (clip: ConstraintClip) => void,
): Promise<ConstraintClip | null> {
  const gen = ++generation;
  activeAbort?.abort();
  const abort = new AbortController();
  activeAbort = abort;
  const envelope = envelopeFromParcel(geom);
  const { signal } = abort;
  const fetchedAt = nowIso();

  const clip: ConstraintClip = {
    zoning: { zonedesc: zoningLabel, fetchedAt },
    zoningFill: emptyClip(),
    roads: emptyClip(),
    drivewaysCounty: emptyClip(),
    row: emptyClip(),
    flood: emptyClip(),
    wetlands: emptyClip(),
    water: emptyClip(),
    cityImpact: emptyClip(),
  };

  const roadParts: { layer: number; clip: LayerClip }[] = [];
  const waterParts: { layer: 6 | 12; clip: LayerClip }[] = [];

  const publish = () => {
    if (gen !== generation) return;
    onPartial?.(clip);
  };

  const addRoad = (transLayer: number, part: LayerClip) => {
    roadParts.push({
      layer: transLayer,
      clip: { ...part, features: part.features.map(normalizeRoad) },
    });
    // Prefer Transportation/3 centerlines so the merged 200 / 500 KB cap does not drop them.
    roadParts.sort((a, b) => a.layer - b.layer);
    clip.roads = mergeClips(
      roadParts.map((p) => p.clip),
      fetchedAt,
    );
  };

  const addWater = (nhdLayer: 6 | 12, part: LayerClip) => {
    waterParts.push({
      layer: nhdLayer,
      clip: { ...part, features: part.features.map((f) => normalizeNhd(f, nhdLayer)) },
    });
    // Prefer waterbodies (12) so shoreline 40 ft lakes survive the merged cap.
    waterParts.sort((a, b) => b.layer - a.layer);
    clip.water = mergeClips(
      waterParts.map((p) => p.clip),
      fetchedAt,
    );
  };

  const county: ClipJob[] = [
    { spec: { url: GIS_LAYERS.row, outFields: "objectid" }, apply: (layer) => { clip.row = layer; } },
    { spec: { url: GIS_LAYERS.driveway, outFields: "Permissions" }, apply: (layer) => { clip.drivewaysCounty = layer; } },
    {
      spec: { url: GIS_LAYERS.roads, outFields: "fullname,fullname_abbr,roadclass", tag: { transLayer: 3 } },
      apply: (layer) => addRoad(3, layer),
    },
    {
      spec: { url: GIS_LAYERS.roadsCounty, outFields: "st_name_full,maint_by", tag: { transLayer: 4 } },
      apply: (layer) => addRoad(4, layer),
    },
    {
      spec: { url: GIS_LAYERS.roadsUsfs, outFields: "name,oper_maint_level", tag: { transLayer: 5 } },
      apply: (layer) => addRoad(5, layer),
    },
    {
      spec: { url: GIS_LAYERS.roadsOwner, outFields: "st_name_full,owned_by", tag: { transLayer: 7 } },
      apply: (layer) => addRoad(7, layer),
    },
    { spec: { url: GIS_LAYERS.zoning, outFields: "zonedesc" }, apply: (layer) => { clip.zoningFill = layer; } },
    { spec: { url: GIS_LAYERS.cityImpact, outFields: "city" }, apply: (layer) => { clip.cityImpact = layer; } },
  ];

  const federal: ClipJob[] = [
    {
      spec: { url: GIS_LAYERS.nfhl, outFields: "FLD_ZONE,ZONE_SUBTY", federal: true },
      apply: (layer) => { clip.flood = layer; },
    },
    {
      spec: { url: GIS_LAYERS.nwi, outFields: "Wetlands.WETLAND_TYPE,Wetlands.ATTRIBUTE", federal: true },
      apply: (layer) => { clip.wetlands = { ...layer, features: layer.features.map(normalizeNwi) }; },
    },
    {
      spec: { url: GIS_LAYERS.nhdWaterbody, outFields: "gnis_name,FCODE,FTYPE", federal: true, tag: { nhdLayer: 12 } },
      apply: (layer) => addWater(12, layer),
    },
    {
      spec: { url: GIS_LAYERS.nhdFlowline, outFields: "gnis_name,FCODE,FTYPE", federal: true, tag: { nhdLayer: 6 } },
      apply: (layer) => addWater(6, layer),
    },
  ];

  for (const job of [...county, ...federal]) {
    const apply = job.apply;
    job.apply = (layer) => {
      apply(layer);
      publish();
    };
  }

  try {
    // County shares one host (~6 connections). Cap concurrency; 8 s clock starts per job.
    await Promise.all([runJobs(county, 3, envelope, signal, gen), runJobs(federal, 4, envelope, signal, gen)]);
    if (gen !== generation) return null;
    return clip;
  } catch (err) {
    if (gen !== generation || signal.aborted) return null;
    throw err;
  } finally {
    if (activeAbort === abort) activeAbort = null;
  }
}

export function shorelineSetbackCollection(water: LayerClip): FeatureCollection {
  const features: Feature[] = [];
  for (const feat of water.features) {
    if (!feat.geometry) continue;
    const props = (feat.properties ?? {}) as Record<string, unknown>;
    const layer = Number(props.nhdLayer ?? (feat.geometry.type === "Polygon" || feat.geometry.type === "MultiPolygon" ? 12 : 6));
    const ft = shorelineSetbackFt(layer, props);
    try {
      const buf = buffer(feat, ft, { units: "feet" });
      if (!buf || !hasGeometry(buf.geometry)) continue;
      buf.properties = {
        ...props,
        setbackFt: ft,
        label: `${ft} ft shoreline — verify with Planning`,
      };
      features.push(buf);
    } catch {
      // skip unbufferable scraps
    }
  }
  return { type: "FeatureCollection", features };
}

export function wetlandSetbackCollection(wetlands: LayerClip): FeatureCollection {
  const features: Feature[] = [];
  for (const feat of wetlands.features) {
    if (!feat.geometry) continue;
    try {
      const buf = buffer(feat, WETLAND_ADVISORY_FT, { units: "feet" });
      if (!buf || !hasGeometry(buf.geometry)) continue;
      buf.properties = {
        ...(feat.properties ?? {}),
        setbackFt: WETLAND_ADVISORY_FT,
        label: "verify with Planning",
      };
      features.push(buf);
    } catch {
      // skip
    }
  }
  return { type: "FeatureCollection", features };
}

export function incompleteConstraintMessage(clip: ConstraintClip): string | null {
  const rows: [string, LayerClip][] = [
    ["flood", clip.flood],
    ["wetlands", clip.wetlands],
    ["roads", clip.roads],
    ["ROW", clip.row],
    ["water", clip.water],
  ];
  const parts = rows
    .filter(([, layer]) => layer.incomplete)
    .map(([name, layer]) => `${name} (${layer.truncatedReason ?? "error"})`);
  if (!parts.length) return null;
  return `Constraint overlays incomplete: ${parts.join(", ")}`;
}

export function emptyConstraintSources(): Record<string, FeatureCollection> {
  return {
    "constraint-zoning": emptyFc(),
    "constraint-city": emptyFc(),
    "constraint-flood": emptyFc(),
    "constraint-wetlands": emptyFc(),
    "constraint-wetland-setback": emptyFc(),
    "constraint-roads": emptyFc(),
    "constraint-driveways": emptyFc(),
    "constraint-row": emptyFc(),
    "constraint-water": emptyFc(),
    "constraint-shoreline": emptyFc(),
  };
}

export function constraintSourceData(clip: ConstraintClip): Record<string, FeatureCollection> {
  return {
    "constraint-zoning": clip.zoningFill,
    "constraint-city": clip.cityImpact,
    "constraint-flood": clip.flood,
    "constraint-wetlands": clip.wetlands,
    "constraint-wetland-setback": wetlandSetbackCollection(clip.wetlands),
    "constraint-roads": clip.roads,
    "constraint-driveways": clip.drivewaysCounty,
    "constraint-row": clip.row,
    "constraint-water": clip.water,
    "constraint-shoreline": shorelineSetbackCollection(clip.water),
  };
}
