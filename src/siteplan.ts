import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  Point,
  Polygon,
  MultiPolygon,
  Position,
} from "geojson";
import { lineString, point } from "@turf/helpers";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import type { FeatureKind, FeatureStatus, PlanDoc, PlanFeature, UseAreaClass } from "@shared/plan";
import { PLAN_DOC_VERSION, toParcelSnapshot } from "@shared/plan";
import type { ParcelProps } from "./types";
import {
  compass,
  feetBetween,
  formatFeet,
  inwardSetback,
  minDistToEdgeFt,
  parcelBbox,
  parcelCentroid,
  parcelEdges,
  pointInParcel,
  rectanglePolygon,
} from "./geo";
import { fetchZoningAt, ruleForZone, type SetbackRule } from "./setbacks";
import { addHatchPatterns, setDoubleClickZoom, USE_AREA_HATCH_IDS } from "./map";

export type PointKind = "structure" | "well" | "septic";
export type DrawKind = "driveway" | "leach" | "easement" | "use_area";
export type SiteKind = PointKind | DrawKind;
export type PlaceMode = null | SiteKind;
export type PlanView = "plan" | "packet";
export type { UseAreaClass };

export const USE_AREA_CLASSES: UseAreaClass[] = [
  "garden",
  "pasture",
  "timber",
  "shop_yard",
  "orchard",
  "other",
];

export const USE_AREA_LABELS: Record<UseAreaClass, string> = {
  garden: "Garden",
  pasture: "Pasture",
  timber: "Timber",
  shop_yard: "Shop yard",
  orchard: "Orchard",
  other: "Use area",
};

export function parseUseClass(value: string | undefined | null): UseAreaClass {
  return USE_AREA_CLASSES.includes(value as UseAreaClass) ? (value as UseAreaClass) : "other";
}

/** Panhandle Health commonly wants 100 ft well→septic. Advisory only. */
export const WELL_SEPTIC_ADVISORY_FT = 100;
/** Proposed driveway "meets" a road at this distance (PR 6 checklist). */
export const DRIVEWAY_MEETS_ROAD_FT = 30;

export interface SiteState {
  active: boolean;
  parcel: ParcelProps | null;
  geom: Polygon | MultiPolygon | null;
  zoning: string | null;
  rule: SetbackRule;
  lineFt: number;
  accessory: boolean;
  features: PlanFeature[];
  selectedId: string | null;
  placeMode: PlaceMode;
  /** In-progress vertex-draw ring/line. Not persisted until Finish. */
  drawVertices: Position[];
  status: FeatureStatus;
  widthFt: number;
  lengthFt: number;
  rotationDeg: number;
  use: string;
  notes: string;
  /** Plan = working map; Packet = BLP preview. Filters overlays only — not a second document. */
  view: PlanView;
  useClass: UseAreaClass;
  /** Frozen at startSitePlan; persist key. Not the inspector parcel. */
  draftPin: string | null;
}

export interface SitePlanSession {
  pin: string;
  hadDraft: boolean;
  lineFtAtStart: number;
}

export const site: SiteState = {
  active: false,
  parcel: null,
  geom: null,
  zoning: null,
  rule: ruleForZone(null),
  lineFt: 25,
  accessory: false,
  features: [],
  selectedId: null,
  placeMode: null,
  drawVertices: [],
  status: "proposed",
  widthFt: 40,
  lengthFt: 60,
  rotationDeg: 0,
  use: "Single-family dwelling",
  notes: "",
  view: "plan",
  useClass: "garden",
  draftPin: null,
};

const empty = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });

const SITE_SOURCES = [
  "site-parcel",
  "site-setback",
  "site-edges",
  "site-structure",
  "site-points",
  "site-driveway",
  "site-leach",
  "site-easement",
  "site-use-area",
  "site-draw",
] as const;

const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_PX = 18;
/** Keep map zoom off until after the finishing dblclick / tap-zoom window. */
const DRAW_ZOOM_HOLD_MS = 450;

let lastTapAt = 0;
let lastTapPos: Position | null = null;
let zoomHoldTimer = 0;
let zoomHoldUntil = 0;

export function isDrawKind(kind: string | null | undefined): kind is DrawKind {
  return kind === "driveway" || kind === "leach" || kind === "easement" || kind === "use_area";
}

export function isPointKind(kind: string | null | undefined): kind is PointKind {
  return kind === "structure" || kind === "well" || kind === "septic";
}

export function minDrawVertices(kind: DrawKind) {
  return kind === "driveway" ? 2 : 3;
}

export function canFinishDraw() {
  return isDrawKind(site.placeMode) && stripTailDuplicate(site.drawVertices).length >= minDrawVertices(site.placeMode);
}

export function shouldPreventDrawZoom() {
  return isDrawKind(site.placeMode) || performance.now() < zoomHoldUntil;
}

export function drawPrompt() {
  const kind = site.placeMode;
  if (!isDrawKind(kind)) return "";
  const n = site.drawVertices.length;
  const min = minDrawVertices(kind);
  const start =
    kind === "driveway"
      ? "Tap driveway vertices. May start off the lot."
      : kind === "leach"
        ? "Tap leach field vertices on the lot."
        : kind === "use_area"
          ? "Tap use-area vertices on the lot."
          : "Tap easement vertices.";
  if (n === 0) return `${start} Finish or double-tap to complete.`;
  if (n < min) return `${n} vertex${n === 1 ? "" : "es"} · need ${min} to finish`;
  return `${n} vertices · Finish or double-tap to complete`;
}

function draftKey(pin: string) {
  return `bonner-anon-draft:${pin}`;
}

function featureCenter(feature: PlanFeature): Position | null {
  return feature.geom.type === "Point" ? feature.geom.coordinates : null;
}

function defaultLabel(kind: FeatureKind, status: FeatureStatus, useClass?: string) {
  const existing = status === "existing";
  switch (kind) {
    case "structure":
      return existing ? "Existing structure" : "Proposed structure";
    case "well":
      return existing ? "Existing well" : "Well";
    case "septic":
      return existing ? "Existing septic" : "Septic";
    case "driveway":
      return existing ? "Existing driveway" : "Driveway";
    case "leach":
      return existing ? "Existing leach field" : "Leach field";
    case "easement":
      return existing ? "Existing easement" : "Easement";
    case "use_area": {
      const name = USE_AREA_LABELS[parseUseClass(useClass)];
      return existing ? `Existing ${name.toLowerCase()}` : name;
    }
    default:
      return kind;
  }
}

function minDistToLineFt(from: Position, coords: Position[]) {
  if (coords.length < 2) return Infinity;
  const snapped = nearestPointOnLine(lineString(coords), point(from), { units: "feet" });
  return snapped.properties.dist ?? Infinity;
}

function orient(a: Position, b: Position, c: Position) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsCross(a: Position, b: Position, c: Position, d: Position) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function segmentDistFt(a: Position, b: Position, c: Position, d: Position) {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(
    minDistToLineFt(a, [c, d]),
    minDistToLineFt(b, [c, d]),
    minDistToLineFt(c, [a, b]),
    minDistToLineFt(d, [a, b]),
  );
}

function drivewayCoords(
  driveway: Feature<LineString> | LineString | PlanFeature,
): Position[] | null {
  if ("geom" in driveway) {
    return driveway.geom.type === "LineString" ? driveway.geom.coordinates : null;
  }
  if (driveway.type === "Feature") {
    return driveway.geometry.type === "LineString" ? driveway.geometry.coordinates : null;
  }
  return driveway.coordinates;
}

function roadLineCoords(geom: Geometry | null | undefined): Position[][] {
  if (!geom) return [];
  if (geom.type === "LineString") return [geom.coordinates];
  if (geom.type === "MultiLineString") return geom.coordinates;
  return [];
}

/** True when any driveway segment is ≤ 30 ft from any road segment (including crossings). */
export function drivewayMeetsRoad(
  driveway: Feature<LineString> | LineString | PlanFeature,
  roadFeatures?: FeatureCollection | Feature[] | null,
): boolean {
  if (!roadFeatures) return false;
  const roads = Array.isArray(roadFeatures) ? roadFeatures : roadFeatures.features;
  if (!roads.length) return false;
  const coords = drivewayCoords(driveway);
  if (!coords || coords.length < 2) return false;
  for (const road of roads) {
    const geom = "geometry" in road ? road.geometry : null;
    for (const line of roadLineCoords(geom)) {
      if (line.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        for (let j = 0; j < line.length - 1; j++) {
          if (segmentDistFt(coords[i], coords[i + 1], line[j], line[j + 1]) <= DRIVEWAY_MEETS_ROAD_FT) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function wellSepticAdvisory(): string[] {
  const wells = site.features.filter((f) => f.kind === "well").map(featureCenter).filter(Boolean) as Position[];
  const septics = site.features.filter((f) => f.kind === "septic").map(featureCenter).filter(Boolean) as Position[];
  if (!wells.length || !septics.length) return [];
  let min = Infinity;
  for (const well of wells) {
    for (const septic of septics) {
      min = Math.min(min, feetBetween(well, septic));
    }
  }
  if (min >= WELL_SEPTIC_ADVISORY_FT) return [];
  return [`Well–septic ${formatFeet(min)} — Panhandle Health commonly wants ${WELL_SEPTIC_ADVISORY_FT} ft`];
}

/** PR 6 will pass clipped road LineStrings. No overlay yet → false / no warning. */
export function encroachmentAdvisory(roadFeatures?: FeatureCollection | Feature[] | null): string[] {
  const out: string[] = [];
  for (const feature of site.features) {
    if (feature.kind !== "driveway" || feature.status !== "proposed") continue;
    if (drivewayMeetsRoad(feature, roadFeatures)) {
      out.push("Proposed driveway is within 30 ft of a road — encroachment permit may be needed");
    }
  }
  return out;
}

function structurePoly(feature: PlanFeature) {
  const center = featureCenter(feature);
  const width = feature.props.widthFt;
  const length = feature.props.lengthFt;
  if (!center || !width || !length) return null;
  return rectanglePolygon(center, width, length, feature.props.rotationDeg ?? 0);
}

function isDraftFeature(value: unknown): value is PlanFeature {
  if (!value || typeof value !== "object") return false;
  const f = value as PlanFeature;
  return typeof f.id === "string" && typeof f.kind === "string" && !!f.geom;
}

function loadDraft(pin: string): PlanDoc | null {
  try {
    const raw = localStorage.getItem(draftKey(pin));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlanDoc;
    if (!parsed || parsed.pin !== pin) return null;
    if (parsed.version != null && parsed.version !== PLAN_DOC_VERSION) return null;
    if (!Array.isArray(parsed.features)) parsed.features = [];
    parsed.features = parsed.features.filter(isDraftFeature).map((f) => {
      const props = { ...(f.props ?? {}) };
      if (f.kind === "use_area") props.useClass = parseUseClass(props.useClass);
      return {
        ...f,
        status: f.status === "existing" ? "existing" : "proposed",
        label: f.label || defaultLabel(f.kind, f.status === "existing" ? "existing" : "proposed", props.useClass),
        onPacket: f.kind === "use_area" ? f.onPacket === true : f.onPacket !== false,
        props,
      };
    });
    return parsed;
  } catch {
    return null;
  }
}

let persistTimer = 0;
let sessionParcel: ParcelProps | null = null;

export function persistDraft() {
  window.clearTimeout(persistTimer);
  persistTimer = 0;
  const pin = site.draftPin;
  if (!pin || !site.geom || !sessionParcel) return;
  const now = new Date().toISOString();
  const doc: PlanDoc = {
    version: PLAN_DOC_VERSION,
    pin,
    title: site.use,
    use: site.use,
    notes: site.notes,
    lineFt: site.lineFt,
    accessory: site.accessory,
    parcel: {
      props: toParcelSnapshot(sessionParcel),
      geom: site.geom,
      snapshotAt: now,
    },
    features: site.features,
    constraints: null,
    checklist: [],
    clientEditedAt: now,
  };
  try {
    localStorage.setItem(draftKey(pin), JSON.stringify(doc));
  } catch {
    // private mode / quota — keep working in memory
  }
}

export function schedulePersist() {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => persistDraft(), 400);
}

window.addEventListener("pagehide", () => persistDraft());

function setSrc(map: MapLibreMap, id: string, data: FeatureCollection) {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  src?.setData(data);
}

export function addSiteLayers(map: MapLibreMap) {
  addHatchPatterns(map);
  for (const id of SITE_SOURCES) {
    if (map.getSource(id)) continue;
    map.addSource(id, { type: "geojson", data: empty() });
  }

  if (!map.getLayer("site-parcel-fill")) {
    map.addLayer({
      id: "site-parcel-fill",
      type: "fill",
      source: "site-parcel",
      paint: { "fill-color": "#f8f1d8", "fill-opacity": 0.12 },
    });
    map.addLayer({
      id: "site-parcel-line",
      type: "line",
      source: "site-parcel",
      paint: { "line-color": "#111", "line-width": 2.4 },
    });
    map.addLayer({
      id: "site-setback-fill",
      type: "fill",
      source: "site-setback",
      paint: { "fill-color": "#2d6a4f", "fill-opacity": 0.14 },
    });
    map.addLayer({
      id: "site-setback-line",
      type: "line",
      source: "site-setback",
      paint: { "line-color": "#2d6a4f", "line-width": 1.5, "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: "site-edges-line",
      type: "line",
      source: "site-edges",
      paint: { "line-color": "#333", "line-width": 1 },
    });
    map.addLayer({
      id: "site-edges-label",
      type: "symbol",
      source: "site-edges",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-font": ["Noto Sans Regular"],
        "symbol-placement": "line",
        "text-offset": [0, 0.8],
      },
      paint: {
        "text-color": "#111",
        "text-halo-color": "#fff",
        "text-halo-width": 1.6,
      },
    });
    map.addLayer({
      id: "site-structure-fill",
      type: "fill",
      source: "site-structure",
      paint: {
        "fill-color": ["match", ["get", "status"], "existing", "#6c757d", "#c1121f"],
        "fill-opacity": 0.35,
      },
    });
    map.addLayer({
      id: "site-structure-line",
      type: "line",
      source: "site-structure",
      paint: {
        "line-color": ["match", ["get", "status"], "existing", "#343a40", "#6a040f"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 3.2, 2],
      },
    });
    map.addLayer({
      id: "site-structure-label",
      type: "symbol",
      source: "site-structure",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-font": ["Noto Sans Regular"],
      },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.4 },
    });
    map.addLayer({
      id: "site-points",
      type: "circle",
      source: "site-points",
      paint: {
        "circle-radius": ["case", ["boolean", ["get", "selected"], false], 7.5, 6],
        "circle-color": [
          "match",
          ["get", "kind"],
          "well",
          "#0077b6",
          "septic",
          "#9c6644",
          "#333",
        ],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "site-points-label",
      type: "symbol",
      source: "site-points",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-offset": [0, 1.2],
        "text-font": ["Noto Sans Regular"],
      },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.3 },
    });
  }

  if (!map.getLayer("site-driveway-line")) {
    map.addLayer({
      id: "site-driveway-line",
      type: "line",
      source: "site-driveway",
      paint: {
        "line-color": ["match", ["get", "status"], "existing", "#8d6e63", "#e09f3e"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 5, 3.2],
      },
    });
    map.addLayer({
      id: "site-driveway-label",
      type: "symbol",
      source: "site-driveway",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
        "symbol-placement": "line",
      },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.3 },
    });
  }

  if (!map.getLayer("site-leach-fill")) {
    map.addLayer({
      id: "site-leach-fill",
      type: "fill",
      source: "site-leach",
      paint: {
        "fill-color": ["match", ["get", "status"], "existing", "#a98467", "#c9a227"],
        "fill-opacity": 0.32,
      },
    });
    map.addLayer({
      id: "site-leach-line",
      type: "line",
      source: "site-leach",
      paint: {
        "line-color": ["match", ["get", "status"], "existing", "#6f4e37", "#9c6644"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 2.8, 1.6],
        "line-dasharray": [2, 1],
      },
    });
    map.addLayer({
      id: "site-leach-label",
      type: "symbol",
      source: "site-leach",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
      },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.3 },
    });
  }

  if (!map.getLayer("site-easement-fill")) {
    map.addLayer({
      id: "site-easement-fill",
      type: "fill",
      source: "site-easement",
      paint: {
        "fill-color": "#7b2cbf",
        "fill-opacity": 0.16,
      },
    });
    map.addLayer({
      id: "site-easement-line",
      type: "line",
      source: "site-easement",
      paint: {
        "line-color": ["case", ["boolean", ["get", "selected"], false], "#5a189a", "#7b2cbf"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 2.8, 1.6],
        "line-dasharray": [4, 2],
      },
    });
    map.addLayer({
      id: "site-easement-label",
      type: "symbol",
      source: "site-easement",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
      },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.3 },
    });
  }

  if (!map.getLayer("site-use-area-fill")) {
    const under = map.getLayer("site-structure-fill") ? "site-structure-fill" : undefined;
    map.addLayer(
      {
        id: "site-use-area-fill",
        type: "fill",
        source: "site-use-area",
        paint: {
          "fill-color": [
            "match",
            ["get", "useClass"],
            "garden",
            "#52b788",
            "pasture",
            "#a7c957",
            "timber",
            "#2d6a4f",
            "shop_yard",
            "#8d6e63",
            "orchard",
            "#e76f51",
            "#d4b46a",
          ],
          "fill-opacity": 0.22,
        },
      },
      under,
    );
    map.addLayer(
      {
        id: "site-use-area-hatch",
        type: "fill",
        source: "site-use-area",
        paint: {
          "fill-pattern": [
            "match",
            ["get", "useClass"],
            "garden",
            USE_AREA_HATCH_IDS.garden,
            "pasture",
            USE_AREA_HATCH_IDS.pasture,
            "timber",
            USE_AREA_HATCH_IDS.timber,
            "shop_yard",
            USE_AREA_HATCH_IDS.shop_yard,
            "orchard",
            USE_AREA_HATCH_IDS.orchard,
            USE_AREA_HATCH_IDS.other,
          ],
        },
      },
      under,
    );
    map.addLayer(
      {
        id: "site-use-area-line",
        type: "line",
        source: "site-use-area",
        paint: {
          "line-color": [
            "match",
            ["get", "useClass"],
            "garden",
            "#2d6a4f",
            "pasture",
            "#6a994e",
            "timber",
            "#1b4332",
            "shop_yard",
            "#6c584c",
            "orchard",
            "#bc4749",
            "#b08968",
          ],
          "line-width": ["case", ["boolean", ["get", "selected"], false], 2.8, 1.6],
        },
      },
      under,
    );
    map.addLayer({
      id: "site-use-area-label",
      type: "symbol",
      source: "site-use-area",
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-font": ["Noto Sans Regular"],
      },
      paint: { "text-color": "#111", "text-halo-color": "#fff", "text-halo-width": 1.4 },
    });
  }

  if (!map.getLayer("site-draw-fill")) {
    map.addLayer({
      id: "site-draw-fill",
      type: "fill",
      source: "site-draw",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#ffd166", "fill-opacity": 0.14 },
    });
    map.addLayer({
      id: "site-draw-line",
      type: "line",
      source: "site-draw",
      filter: [
        "any",
        ["==", ["geometry-type"], "LineString"],
        ["==", ["geometry-type"], "Polygon"],
      ],
      paint: { "line-color": "#ffd166", "line-width": 2.2, "line-dasharray": [2, 1] },
    });
    map.addLayer({
      id: "site-draw-vertices",
      type: "circle",
      source: "site-draw",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 5,
        "circle-color": "#ffd166",
        "circle-stroke-color": "#111",
        "circle-stroke-width": 1.2,
      },
    });
  }
}

export function clearSiteLayers(map: MapLibreMap) {
  for (const id of SITE_SOURCES) setSrc(map, id, empty());
}

export function fitParcel(map: MapLibreMap, geom: Polygon | MultiPolygon) {
  const [w, s, e, n] = parcelBbox(geom);
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 72, duration: 600, maxZoom: 19 },
  );
}

function resetFormDefaults() {
  site.use = "Single-family dwelling";
  site.notes = "";
  site.accessory = false;
  site.lineFt = 25;
  site.widthFt = 40;
  site.lengthFt = 60;
  site.rotationDeg = 0;
  site.status = "proposed";
  site.useClass = "garden";
  site.zoning = null;
  site.rule = ruleForZone(null);
}

export function startSitePlan(
  map: MapLibreMap,
  parcel: ParcelProps,
  geom: Polygon | MultiPolygon,
): SitePlanSession {
  persistDraft();

  site.active = true;
  site.draftPin = parcel.pin;
  sessionParcel = parcel;
  site.parcel = parcel;
  site.geom = geom;
  site.selectedId = null;
  site.placeMode = null;
  site.drawVertices = [];
  lastTapAt = 0;
  lastTapPos = null;
  clearZoomHold();
  setDoubleClickZoom(map, true);
  site.status = "proposed";
  site.view = "plan";
  site.useClass = "garden";
  site.zoning = null;
  site.rule = ruleForZone(null);

  const draft = parcel.pin ? loadDraft(parcel.pin) : null;
  if (draft) {
    site.use = typeof draft.use === "string" && draft.use ? draft.use : "Single-family dwelling";
    site.notes = typeof draft.notes === "string" ? draft.notes : "";
    site.lineFt = typeof draft.lineFt === "number" ? draft.lineFt : 25;
    site.accessory = Boolean(draft.accessory);
    site.features = draft.features;
    const lastStruct = [...site.features].reverse().find((f) => f.kind === "structure");
    site.selectedId = lastStruct?.id ?? site.features.at(-1)?.id ?? null;
    const selected = site.features.find((f) => f.id === site.selectedId);
    if (selected) site.status = selected.status;
    if (selected?.kind === "structure") {
      site.widthFt = selected.props.widthFt ?? 40;
      site.lengthFt = selected.props.lengthFt ?? 60;
      site.rotationDeg = selected.props.rotationDeg ?? 0;
    } else {
      site.widthFt = 40;
      site.lengthFt = 60;
      site.rotationDeg = 0;
    }
    if (selected?.kind === "use_area") site.useClass = parseUseClass(selected.props.useClass);
  } else {
    site.features = [];
    resetFormDefaults();
  }

  addSiteLayers(map);
  for (const id of ["parcels-line", "parcels-fill-private", "parcels-fill-public", "parcels-label", "county-outline"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }
  setSrc(map, "site-parcel", {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: geom }],
  });
  fitParcel(map, geom);
  refreshOverlays(map);
  return {
    pin: parcel.pin,
    hadDraft: Boolean(draft),
    lineFtAtStart: site.lineFt,
  };
}

export async function refreshSiteZoning(map: MapLibreMap, session: SitePlanSession) {
  if (!site.geom || site.draftPin !== session.pin) return;
  const [lng, lat] = parcelCentroid(site.geom);
  let zoning: string | null = null;
  try {
    zoning = await fetchZoningAt(lng, lat);
  } catch {
    zoning = null;
  }
  if (!site.active || site.draftPin !== session.pin) return;
  site.zoning = zoning;
  site.rule = ruleForZone(site.zoning);
  if (!session.hadDraft && !site.accessory && site.lineFt === session.lineFtAtStart) {
    site.lineFt = site.rule.lineFt;
  }
  refreshOverlays(map);
}

export function exitSitePlan(map: MapLibreMap) {
  persistDraft();
  site.active = false;
  site.draftPin = null;
  sessionParcel = null;
  site.parcel = null;
  site.geom = null;
  site.placeMode = null;
  site.drawVertices = [];
  site.view = "plan";
  lastTapAt = 0;
  lastTapPos = null;
  clearZoomHold();
  setDoubleClickZoom(map, true);
  site.features = [];
  site.selectedId = null;
  resetFormDefaults();
  clearSiteLayers(map);
  for (const id of ["parcels-line", "parcels-fill-private", "parcels-fill-public", "parcels-label", "county-outline"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  }
}

export function setLineSetback(map: MapLibreMap, feet: number) {
  site.lineFt = Math.max(0, feet);
  schedulePersist();
  refreshOverlays(map);
}

export function selectedFeature(): PlanFeature | undefined {
  return site.features.find((f) => f.id === site.selectedId);
}

export function addFeature(kind: PointKind, center: Position, extras: Partial<PlanFeature> = {}) {
  if (!site.geom || !pointInParcel(center, site.geom)) return null;
  const status = extras.status ?? site.status;
  const id = extras.id ?? `${kind}-${Date.now()}`;
  const feature: PlanFeature = {
    id,
    kind,
    status,
    label: extras.label ?? defaultLabel(kind, status),
    geom: { type: "Point", coordinates: center },
    onPacket: extras.onPacket ?? true,
    props: {
      ...(kind === "structure"
        ? { widthFt: site.widthFt, lengthFt: site.lengthFt, rotationDeg: site.rotationDeg }
        : {}),
      source: "user",
      ...extras.props,
    },
  };
  site.features.push(feature);
  site.selectedId = id;
  schedulePersist();
  return feature;
}

export function updateSelected(
  partial: Partial<PlanFeature["props"]> & { status?: FeatureStatus; label?: string; onPacket?: boolean },
) {
  const feature = selectedFeature();
  if (!feature) return;
  if (partial.widthFt != null) feature.props.widthFt = partial.widthFt;
  if (partial.lengthFt != null) feature.props.lengthFt = partial.lengthFt;
  if (partial.rotationDeg != null) feature.props.rotationDeg = partial.rotationDeg;
  if (partial.eaveFt != null) feature.props.eaveFt = partial.eaveFt;
  if (partial.useClass != null) {
    feature.props.useClass = parseUseClass(partial.useClass);
    if (feature.kind === "use_area" && !partial.label) {
      feature.label = defaultLabel(feature.kind, feature.status, feature.props.useClass);
    }
  }
  if (partial.source != null) feature.props.source = partial.source;
  if (partial.notes != null) feature.props.notes = partial.notes;
  if (partial.onPacket != null) feature.onPacket = partial.onPacket;
  if (partial.status) {
    feature.status = partial.status;
    feature.label = defaultLabel(feature.kind, feature.status, feature.props.useClass);
  }
  if (partial.label) feature.label = partial.label;
  schedulePersist();
}

export function setView(map: MapLibreMap, view: PlanView) {
  site.view = view;
  refreshOverlays(map);
}

function featureVisible(feature: PlanFeature) {
  if (site.view === "packet" && feature.kind === "use_area" && !feature.onPacket) return false;
  return true;
}

export function removeSelected() {
  site.features = site.features.filter((f) => f.id !== site.selectedId);
  site.selectedId = site.features.at(-1)?.id ?? null;
  schedulePersist();
}

function pixelsApart(map: MapLibreMap, a: Position, b: Position) {
  const pa = map.project(a as [number, number]);
  const pb = map.project(b as [number, number]);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

function noteTap(lngLat: Position) {
  lastTapAt = performance.now();
  lastTapPos = lngLat;
}

function isDoubleTap(map: MapLibreMap, lngLat: Position) {
  if (!lastTapPos || performance.now() - lastTapAt > DOUBLE_TAP_MS) return false;
  return pixelsApart(map, lastTapPos, lngLat) <= DOUBLE_TAP_PX;
}

function clearZoomHold() {
  window.clearTimeout(zoomHoldTimer);
  zoomHoldTimer = 0;
  zoomHoldUntil = 0;
}

function holdDrawZoom(map: MapLibreMap) {
  setDoubleClickZoom(map, false);
  zoomHoldUntil = performance.now() + DRAW_ZOOM_HOLD_MS;
  window.clearTimeout(zoomHoldTimer);
  zoomHoldTimer = window.setTimeout(() => {
    zoomHoldTimer = 0;
    zoomHoldUntil = 0;
    if (!isDrawKind(site.placeMode)) setDoubleClickZoom(map, true);
  }, DRAW_ZOOM_HOLD_MS);
}

function closedRing(verts: Position[]): Position[] {
  const ring = verts.map((v) => [v[0], v[1]] as Position);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function stripTailDuplicate(verts: Position[]) {
  if (verts.length < 2) return verts;
  const a = verts[verts.length - 2];
  const b = verts[verts.length - 1];
  if (feetBetween(a, b) < 2) return verts.slice(0, -1);
  return verts;
}

export function setPlaceMode(map: MapLibreMap, mode: PlaceMode) {
  site.placeMode = mode;
  site.drawVertices = [];
  lastTapAt = 0;
  lastTapPos = null;
  if (isDrawKind(mode)) setDoubleClickZoom(map, false);
  else if (performance.now() >= zoomHoldUntil) setDoubleClickZoom(map, true);
  refreshDrawPreview(map);
}

export function finishDrawing(map: MapLibreMap): PlanFeature | null {
  const kind = site.placeMode;
  if (!isDrawKind(kind)) return null;
  const verts = stripTailDuplicate(site.drawVertices);
  if (verts.length < minDrawVertices(kind)) return null;

  const status = site.status;
  const geom: Geometry =
    kind === "driveway"
      ? { type: "LineString", coordinates: verts }
      : { type: "Polygon", coordinates: [closedRing(verts)] };

  const useClass = kind === "use_area" ? site.useClass : undefined;
  const feature: PlanFeature = {
    id: `${kind}-${Date.now()}`,
    kind,
    status,
    label: defaultLabel(kind, status, useClass),
    geom,
    onPacket: kind !== "use_area",
    props: { source: "user", ...(useClass ? { useClass } : {}) },
  };
  site.features.push(feature);
  site.selectedId = feature.id;
  site.placeMode = null;
  site.drawVertices = [];
  lastTapAt = 0;
  lastTapPos = null;
  holdDrawZoom(map);
  schedulePersist();
  refreshOverlays(map);
  return feature;
}

export function addDrawVertex(map: MapLibreMap, lngLat: Position): "vertex" | "finished" | "rejected" {
  const kind = site.placeMode;
  if (!isDrawKind(kind)) return "rejected";
  const min = minDrawVertices(kind);
  const doubled = isDoubleTap(map, lngLat);
  const last = site.drawVertices.at(-1);
  const closeToLast = last != null && pixelsApart(map, last, lngLat) <= DOUBLE_TAP_PX;

  if (doubled) {
    // First click of the pair already committed a vertex; drop it if we already had enough.
    if (last && lastTapPos && pixelsApart(map, last, lastTapPos) <= DOUBLE_TAP_PX && site.drawVertices.length - 1 >= min) {
      site.drawVertices.pop();
    }
    lastTapAt = 0;
    lastTapPos = null;
    if (stripTailDuplicate(site.drawVertices).length >= min) {
      return finishDrawing(map) ? "finished" : "vertex";
    }
    refreshDrawPreview(map);
    return "vertex";
  }

  if (closeToLast) {
    if (stripTailDuplicate(site.drawVertices).length >= min) {
      return finishDrawing(map) ? "finished" : "vertex";
    }
    noteTap(lngLat);
    refreshDrawPreview(map);
    return "vertex";
  }

  const allowOffParcel = kind === "driveway" || kind === "easement";
  if (!allowOffParcel && site.geom && !pointInParcel(lngLat, site.geom)) return "rejected";

  site.drawVertices.push([lngLat[0], lngLat[1]]);
  noteTap(lngLat);
  setDoubleClickZoom(map, false);
  refreshDrawPreview(map);
  return "vertex";
}

function mapProps(feature: PlanFeature) {
  return {
    id: feature.id,
    kind: feature.kind,
    status: feature.status,
    selected: feature.id === site.selectedId,
    label: feature.label,
    useClass: parseUseClass(feature.props.useClass),
  };
}

function refreshDrawPreview(map: MapLibreMap) {
  const verts = site.drawVertices;
  const kind = site.placeMode;
  const features: Feature[] = [];
  if (verts.length >= 2) {
    if (isDrawKind(kind) && kind !== "driveway" && verts.length >= 3) {
      features.push({
        type: "Feature",
        properties: { kind: "fill" },
        geometry: { type: "Polygon", coordinates: [closedRing(verts)] },
      });
    } else {
      features.push({
        type: "Feature",
        properties: { kind: "line" },
        geometry: { type: "LineString", coordinates: verts },
      });
    }
  }
  for (const v of verts) {
    features.push({
      type: "Feature",
      properties: { kind: "vertex" },
      geometry: { type: "Point", coordinates: v },
    });
  }
  setSrc(map, "site-draw", { type: "FeatureCollection", features });
}

export function refreshOverlays(map: MapLibreMap) {
  if (!site.geom) return;
  const setback = inwardSetback(site.geom, site.lineFt);
  setSrc(map, "site-setback", {
    type: "FeatureCollection",
    features: setback ? [setback] : [],
  });

  const structures = site.features.filter((f) => f.kind === "structure");
  const measured =
    structures.find((f) => f.id === site.selectedId) ?? structures[0];
  const measuredPoly = measured ? structurePoly(measured) : null;

  const edges = parcelEdges(site.geom);
  setSrc(map, "site-edges", {
    type: "FeatureCollection",
    features: edges.map((edge) => {
      let label = `${formatFeet(edge.lengthFt)} ${compass(edge.bearing)}`;
      if (measuredPoly) {
        const toBldg = minDistToEdgeFt(measuredPoly, edge);
        label = `${formatFeet(edge.lengthFt)} · ${formatFeet(toBldg)} to bldg`;
      }
      return {
        type: "Feature" as const,
        properties: { label },
        geometry: { type: "LineString" as const, coordinates: [edge.start, edge.end] },
      };
    }),
  });

  setSrc(map, "site-structure", {
    type: "FeatureCollection",
    features: structures.flatMap((feature) => {
      const poly = structurePoly(feature);
      if (!poly) return [];
      return [
        {
          ...poly,
          properties: {
            id: feature.id,
            status: feature.status,
            selected: feature.id === site.selectedId,
            label: `${feature.label} ${feature.props.widthFt}×${feature.props.lengthFt} ft`,
          },
        },
      ];
    }),
  });

  setSrc(map, "site-points", {
    type: "FeatureCollection",
    features: site.features
      .filter((f) => f.kind === "well" || f.kind === "septic")
      .flatMap((f): Feature<Point>[] => {
        const center = featureCenter(f);
        if (!center) return [];
        return [
          {
            type: "Feature",
            properties: mapProps(f),
            geometry: { type: "Point", coordinates: center },
          },
        ];
      }),
  });

  setSrc(map, "site-driveway", {
    type: "FeatureCollection",
    features: site.features.flatMap((f): Feature<LineString>[] => {
      if (f.kind !== "driveway" || f.geom.type !== "LineString") return [];
      return [{ type: "Feature", properties: mapProps(f), geometry: f.geom }];
    }),
  });

  setSrc(map, "site-leach", {
    type: "FeatureCollection",
    features: site.features.flatMap((f): Feature<Polygon>[] => {
      if (f.kind !== "leach" || f.geom.type !== "Polygon") return [];
      return [{ type: "Feature", properties: mapProps(f), geometry: f.geom }];
    }),
  });

  setSrc(map, "site-easement", {
    type: "FeatureCollection",
    features: site.features.flatMap((f): Feature<Polygon | LineString>[] => {
      if (f.kind !== "easement") return [];
      if (f.geom.type === "Polygon" || f.geom.type === "LineString") {
        return [{ type: "Feature", properties: mapProps(f), geometry: f.geom }];
      }
      return [];
    }),
  });

  setSrc(map, "site-use-area", {
    type: "FeatureCollection",
    features: site.features.flatMap((f): Feature<Polygon>[] => {
      if (f.kind !== "use_area" || f.geom.type !== "Polygon" || !featureVisible(f)) return [];
      return [{ type: "Feature", properties: mapProps(f), geometry: f.geom }];
    }),
  });

  refreshDrawPreview(map);
}

function pickFeatureAt(lngLat: Position): PlanFeature | null {
  for (let i = site.features.length - 1; i >= 0; i--) {
    const feature = site.features[i];
    if (feature.kind === "structure") {
      const poly = structurePoly(feature);
      if (poly && pointInParcel(lngLat, poly.geometry)) return feature;
    }
    if (
      (feature.kind === "leach" || feature.kind === "easement" || feature.kind === "use_area") &&
      feature.geom.type === "Polygon" &&
      pointInParcel(lngLat, feature.geom)
    ) {
      if (featureVisible(feature)) return feature;
    }
  }
  let best: PlanFeature | null = null;
  let bestFt = 25;
  for (const feature of site.features) {
    if (feature.kind === "structure") continue;
    if (feature.geom.type === "Polygon") continue;
    if (feature.geom.type === "Point") {
      const dist = feetBetween(feature.geom.coordinates, lngLat);
      if (dist < bestFt) {
        bestFt = dist;
        best = feature;
      }
    } else if (feature.geom.type === "LineString") {
      const dist = minDistToLineFt(lngLat, feature.geom.coordinates);
      if (dist < bestFt) {
        bestFt = dist;
        best = feature;
      }
    }
  }
  return best;
}

export type SiteClickResult = false | "vertex" | "finished" | "rejected" | "placed" | "selected";

export function handleSiteClick(map: MapLibreMap, lngLat: Position): SiteClickResult {
  if (!site.active) return false;
  if (isDrawKind(site.placeMode)) return addDrawVertex(map, lngLat);
  if (isPointKind(site.placeMode)) {
    const feature = addFeature(site.placeMode, lngLat);
    site.placeMode = null;
    if (feature) refreshOverlays(map);
    return "placed";
  }
  const hit = pickFeatureAt(lngLat);
  if (!hit) return false;
  site.selectedId = hit.id;
  site.status = hit.status;
  if (hit.kind === "use_area") site.useClass = parseUseClass(hit.props.useClass);
  refreshOverlays(map);
  return "selected";
}

export function distanceSummary() {
  if (!site.geom) return [];
  const structures = site.features.filter((f) => f.kind === "structure");
  const structure = structures.find((f) => f.id === site.selectedId) ?? structures[0];
  const poly = structure ? structurePoly(structure) : null;
  if (!poly) return [];
  return parcelEdges(site.geom)
    .filter((e) => e.lengthFt >= 15)
    .map((edge) => ({
      side: compass(edge.bearing + 90),
      lotFt: edge.lengthFt,
      toBldgFt: minDistToEdgeFt(poly, edge),
    }))
    .sort((a, b) => a.toBldgFt - b.toBldgFt);
}
