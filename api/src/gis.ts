import bbox from "@turf/bbox";
import bboxClip from "@turf/bbox-clip";
import buffer from "@turf/buffer";
import { featureCollection } from "@turf/helpers";
import intersect from "@turf/intersect";
import type { Context, Hono } from "hono";
import type {
  BBox,
  Feature,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
} from "geojson";
import { z } from "zod";
import { PolygonOrMultiSchema } from "../../shared/plan";
import { userFromRequest } from "./auth";
import type { Db } from "./db";

const GEOM_MAX_BYTES = 1_000_000;
const PAGE = 200;
const FEATURE_CAP = 200;
const ENCODED_CAP = 500 * 1024;
const RAW_CAP = 2 * 1024 * 1024;
const WALL_MS = 8000;
const OFFSET_DEG = "0.00005";

const COUNTY =
  "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services";

/** Frozen allowlist. No user URL. Layer ids are integers only. */
const ALLOWLIST = {
  "county-cadastral": {
    base: `${COUNTY}/Cadastral_Public/MapServer/`,
    layers: {
      5: "objectid",
      1: "objectid",
      3: "objectid",
      4: "objectid",
    },
  },
  "county-address": {
    base: `${COUNTY}/Addressing_Public/MapServer/`,
    layers: {
      0: "fulladdr,Permissions",
      1: "fulladdr,Permissions",
    },
  },
  "county-trans": {
    base: `${COUNTY}/Transportation_Public/MapServer/`,
    layers: {
      3: "fullname,fullname_abbr,roadclass",
      4: "st_name_full,maint_by",
      5: "name,oper_maint_level",
      7: "st_name_full,owned_by",
    },
  },
  "county-zoning": {
    base: `${COUNTY}/ZoningLanduse_Public/MapServer/`,
    layers: {
      0: "city",
      1: "zonedesc",
      2: "zonedesc",
    },
  },
  nfhl: {
    base: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/",
    layers: { 28: "FLD_ZONE,ZONE_SUBTY" },
  },
  nwi: {
    base: "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/",
    layers: { 0: "Wetlands.WETLAND_TYPE,Wetlands.ATTRIBUTE" },
  },
  nhd: {
    base: "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/",
    layers: {
      6: "gnis_name,FCODE,FTYPE",
      12: "gnis_name,FCODE,FTYPE",
    },
  },
} as const;

type Src = keyof typeof ALLOWLIST;
type TruncatedReason =
  | "feature_cap"
  | "byte_cap"
  | "timeout"
  | "cors"
  | "too_large_source";

interface LayerClip {
  type: "FeatureCollection";
  features: Feature[];
  incomplete: boolean;
  fetchedAt: string;
  truncatedReason?: TruncatedReason;
}

interface QueryEnvelope {
  feature: Feature<Polygon | MultiPolygon>;
  bbox: BBox;
  rings: number[][][] | null;
  incomplete: boolean;
}

const ClipBody = z.object({
  src: z.string(),
  layer: z.number().int(),
  planId: z.string().min(1).max(64).optional(),
  geom: PolygonOrMultiSchema.optional(),
});

const REASON_RANK: TruncatedReason[] = [
  "cors",
  "timeout",
  "too_large_source",
  "byte_cap",
  "feature_cap",
];

function worseReason(
  a?: TruncatedReason,
  b?: TruncatedReason,
): TruncatedReason | undefined {
  if (!a) return b;
  if (!b) return a;
  return REASON_RANK.indexOf(a) <= REASON_RANK.indexOf(b) ? a : b;
}

function fail(c: Context, status: 400 | 401 | 404 | 413, error: string, code: string) {
  return c.json({ error, code }, status);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function emptyClip(reason?: TruncatedReason, extra?: Partial<LayerClip>): LayerClip {
  return {
    type: "FeatureCollection",
    features: [],
    incomplete: Boolean(reason),
    fetchedAt: nowIso(),
    truncatedReason: reason,
    ...extra,
  };
}

function asPolygon(geom: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return { type: "Feature", properties: {}, geometry: geom };
}

function envelopeFromParcel(geom: Polygon | MultiPolygon): QueryEnvelope {
  try {
    const buffered = buffer(asPolygon(geom), 300, { units: "feet" });
    if (
      !buffered ||
      (buffered.geometry.type !== "Polygon" && buffered.geometry.type !== "MultiPolygon")
    ) {
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
    const [w, s, e, n] = bbox(asPolygon(geom)) as [number, number, number, number];
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
  if (geom.type === "LineString" || geom.type === "MultiLineString") {
    const clipped = bboxClip(
      feature as Feature<LineString | MultiLineString>,
      envelope.bbox,
    );
    if (!clipped || !hasGeometry(clipped.geometry)) return null;
    return { ...clipped, properties: feature.properties ?? {} };
  }
  return null;
}

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

function isAbort(err: unknown) {
  return (
    (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError")
  );
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
  const timer = setTimeout(() => local.abort(), remain);
  const onParent = () => local.abort();
  parent.addEventListener("abort", onParent);
  try {
    return await run(local.signal);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParent);
  }
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    const err = new Error("upstream too large");
    (err as Error & { truncated: TruncatedReason }).truncated = "byte_cap";
    throw err;
  }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > cap) {
        await reader.cancel().catch(() => undefined);
        const err = new Error("upstream too large");
        (err as Error & { truncated: TruncatedReason }).truncated = "byte_cap";
        throw err;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function queryUrl(base: string, layer: number): string {
  return `${base}${layer}/query`;
}

async function queryPage(
  url: string,
  outFields: string,
  envelope: QueryEnvelope,
  offset: number,
  signal: AbortSignal,
): Promise<{ text: string; data: EsriFc }> {
  const params = new URLSearchParams({
    where: "1=1",
    geometryType: envelope.rings ? "esriGeometryPolygon" : "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal,
    redirect: "error",
  });
  const text = await readCapped(res, RAW_CAP);
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

async function clipLayer(
  url: string,
  outFields: string,
  envelope: QueryEnvelope,
  signal: AbortSignal,
): Promise<LayerClip> {
  const fetchedAt = nowIso();
  const deadline = Date.now() + WALL_MS;
  const kept: Feature[] = [];
  let incomplete = envelope.incomplete;
  let truncatedReason: TruncatedReason | undefined = envelope.incomplete
    ? "too_large_source"
    : undefined;
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
      const page = await withTimeout(deadline, signal, (s) =>
        queryPage(url, outFields, envelope, offset, s),
      );
      rawBytes += page.text.length;
      const incoming = page.data.features ?? [];
      for (const raw of incoming) {
        const feat = asFeature(raw);
        if (!feat) continue;
        try {
          const clipped = clipOne(feat, envelope);
          if (!clipped) continue;
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
    const truncated = (err as { truncated?: TruncatedReason }).truncated;
    if (isAbort(err) || signal.aborted) {
      incomplete = true;
      truncatedReason = worseReason(truncatedReason, "timeout");
    } else if (truncated) {
      incomplete = true;
      truncatedReason = worseReason(truncatedReason, truncated);
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

function geomTooLarge(geom: unknown): boolean {
  try {
    return JSON.stringify(geom).length > GEOM_MAX_BYTES;
  } catch {
    return true;
  }
}

function rejectOpenRelay(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const body = json as Record<string, unknown>;
  if ("url" in body || "bbox" in body) return "URL and bbox are not allowed";
  if (Array.isArray(body.envelope)) return "Free bbox envelope is not allowed";
  return null;
}

function isSrc(value: string): value is Src {
  return Object.prototype.hasOwnProperty.call(ALLOWLIST, value);
}

function resolveOutFields(src: Src, layer: number): string | null {
  const fields = ALLOWLIST[src].layers as Record<number, string>;
  return fields[layer] ?? null;
}

type PlanRow = { id: string; user_id: string; doc: string; deleted_at: string | null };

function loadOwnedGeom(db: Db, userId: string, planId: string): Polygon | MultiPolygon | "missing" | "bad" {
  const row = db
    .prepare(
      `SELECT id, user_id, doc, deleted_at FROM plans WHERE id = ? LIMIT 1`,
    )
    .get(planId) as PlanRow | undefined;
  if (!row || row.deleted_at || row.user_id !== userId) return "missing";
  let doc: unknown;
  try {
    doc = JSON.parse(row.doc);
  } catch {
    return "bad";
  }
  const geom = (doc as { parcel?: { geom?: unknown } })?.parcel?.geom;
  const parsed = PolygonOrMultiSchema.safeParse(geom);
  return parsed.success ? parsed.data : "bad";
}

export function mountGis(api: Hono, db: Db): void {
  api.post("/gis/clip", async (c) => {
    const started = Date.now();
    const user = userFromRequest(db, c);
    if (!user) {
      return fail(c, 401, "Not signed in", "unauthorized");
    }

    const json = await readJson(c);
    const relay = rejectOpenRelay(json);
    if (relay) return fail(c, 400, relay, "bad_request");

    const parsed = ClipBody.safeParse(json);
    if (!parsed.success) {
      return fail(c, 400, "Invalid request", "bad_request");
    }

    const { src, layer, planId } = parsed.data;
    if (!isSrc(src)) {
      return fail(c, 400, "Unknown GIS source", "bad_request");
    }
    const outFields = resolveOutFields(src, layer);
    if (!outFields) {
      return fail(c, 400, "Layer not allowlisted", "bad_request");
    }

    let geom: Polygon | MultiPolygon | undefined = parsed.data.geom;
    if (planId) {
      const loaded = loadOwnedGeom(db, user.id, planId);
      if (loaded === "missing") return fail(c, 404, "Plan not found", "not_found");
      if (loaded === "bad") return fail(c, 400, "Plan has no parcel geometry", "bad_request");
      geom = loaded;
    }
    if (!geom) {
      return fail(c, 400, "Parcel geometry required", "bad_request");
    }
    if (geomTooLarge(geom)) {
      return fail(c, 413, "Geometry too large", "payload_too_large");
    }

    const url = queryUrl(ALLOWLIST[src].base, layer);
    const envelope = envelopeFromParcel(geom);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), WALL_MS);
    let clip: LayerClip;
    try {
      clip = await clipLayer(url, outFields, envelope, abort.signal);
    } catch (err) {
      console.error(JSON.stringify({ msg: "gis.clip failed", src, layer, err: String(err) }));
      return c.json({ error: "Clip failed", code: "clip_failed" }, 500);
    } finally {
      clearTimeout(timer);
    }

    console.log(
      JSON.stringify({
        msg: "gis.clip",
        src,
        layer,
        ms: Date.now() - started,
        status: 200,
        incomplete: clip.incomplete,
      }),
    );
    return c.json(clip);
  });
}
