import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection, Point, Polygon, MultiPolygon, Position } from "geojson";
import type { FeatureStatus, PlanDoc, PlanFeature } from "@shared/plan";
import { PLAN_DOC_VERSION, toParcelSnapshot } from "@shared/plan";
import type { ParcelProps } from "./types";
import {
  compass,
  eaveEnvelope,
  feetBetween,
  formatFeet,
  inwardSetback,
  minDistToEdgeFt,
  nearestOnPolygonFt,
  parcelBbox,
  parcelCentroid,
  parcelEdges,
  pointInParcel,
  rectanglePolygon,
} from "./geo";
import { fetchZoningAt, ruleForZone, type SetbackRule } from "./setbacks";

export type SiteKind = "structure" | "well" | "septic" | "front_door";
export type PlaceMode = null | SiteKind;

export const DEFAULT_EAVE_FT = 2;
export const DOOR_SNAP_FT = 12;
export const DOOR_REJECT_MSG = "Tap on the building edge (door must sit on the wall/eave).";

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
  status: FeatureStatus;
  widthFt: number;
  lengthFt: number;
  rotationDeg: number;
  eaveFt: number;
  use: string;
  notes: string;
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
  status: "proposed",
  widthFt: 40,
  lengthFt: 60,
  rotationDeg: 0,
  eaveFt: DEFAULT_EAVE_FT,
  use: "Single-family dwelling",
  notes: "",
  draftPin: null,
};

const empty = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });

function draftKey(pin: string) {
  return `bonner-anon-draft:${pin}`;
}

function featureCenter(feature: PlanFeature): Position | null {
  return feature.geom.type === "Point" ? feature.geom.coordinates : null;
}

function defaultLabel(kind: SiteKind, status: FeatureStatus) {
  if (kind === "structure") return status === "existing" ? "Existing structure" : "Proposed structure";
  if (kind === "well") return status === "existing" ? "Existing well" : "Well";
  if (kind === "front_door") return "Front door";
  return status === "existing" ? "Existing septic" : "Septic";
}

function structurePoly(feature: PlanFeature) {
  const center = featureCenter(feature);
  const width = feature.props.widthFt;
  const length = feature.props.lengthFt;
  if (!center || !width || !length) return null;
  return rectanglePolygon(center, width, length, feature.props.rotationDeg ?? 0);
}

function structureEaveFt(feature: PlanFeature) {
  const n = feature.props.eaveFt;
  return n != null && Number.isFinite(n) && n >= 0 ? n : DEFAULT_EAVE_FT;
}

function structureEnvelope(feature: PlanFeature) {
  const poly = structurePoly(feature);
  if (!poly) return null;
  return eaveEnvelope(poly, structureEaveFt(feature));
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
    parsed.features = parsed.features.filter(isDraftFeature).map((f) => ({
      ...f,
      status: f.status === "existing" ? "existing" : "proposed",
      label: f.kind === "front_door" ? "Front door" : f.label || f.kind,
      onPacket: f.onPacket !== false,
      props: {
        ...(f.props ?? {}),
        ...(f.kind === "structure" ? { eaveFt: f.props?.eaveFt ?? DEFAULT_EAVE_FT } : {}),
      },
    }));
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
  const layers: [string, string][] = [
    ["site-parcel", "geojson"],
    ["site-setback", "geojson"],
    ["site-edges", "geojson"],
    ["site-envelope", "geojson"],
    ["site-structure", "geojson"],
    ["site-points", "geojson"],
  ];
  for (const [id] of layers) {
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
      id: "site-envelope-line",
      type: "line",
      source: "site-envelope",
      paint: {
        "line-color": ["match", ["get", "status"], "existing", "#6c757d", "#c1121f"],
        "line-width": ["case", ["boolean", ["get", "selected"], false], 2.2, 1.4],
        "line-dasharray": [3, 2],
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
          "front_door",
          "#c9a227",
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
}

export function clearSiteLayers(map: MapLibreMap) {
  for (const id of [
    "site-parcel",
    "site-setback",
    "site-edges",
    "site-envelope",
    "site-structure",
    "site-points",
  ]) {
    setSrc(map, id, empty());
  }
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
  site.eaveFt = DEFAULT_EAVE_FT;
  site.status = "proposed";
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
  site.status = "proposed";
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
      site.eaveFt = selected.props.eaveFt ?? DEFAULT_EAVE_FT;
    } else {
      site.widthFt = 40;
      site.lengthFt = 60;
      site.rotationDeg = 0;
      site.eaveFt = DEFAULT_EAVE_FT;
    }
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

export function addFeature(kind: SiteKind, center: Position, extras: Partial<PlanFeature> = {}) {
  if (!site.geom) return null;
  if (kind !== "front_door" && !pointInParcel(center, site.geom)) return null;
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
        ? {
            widthFt: site.widthFt,
            lengthFt: site.lengthFt,
            rotationDeg: site.rotationDeg,
            eaveFt: site.eaveFt,
          }
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
  partial: Partial<PlanFeature["props"]> & { status?: FeatureStatus; label?: string },
) {
  const feature = selectedFeature();
  if (!feature) return;
  if (partial.widthFt != null) feature.props.widthFt = partial.widthFt;
  if (partial.lengthFt != null) feature.props.lengthFt = partial.lengthFt;
  if (partial.rotationDeg != null) feature.props.rotationDeg = partial.rotationDeg;
  if (partial.eaveFt != null) feature.props.eaveFt = partial.eaveFt;
  if (partial.useClass != null) feature.props.useClass = partial.useClass;
  if (partial.source != null) feature.props.source = partial.source;
  if (partial.notes != null) feature.props.notes = partial.notes;
  if (partial.status) {
    feature.status = partial.status;
    if (feature.kind === "structure" || feature.kind === "well" || feature.kind === "septic") {
      feature.label = defaultLabel(feature.kind, feature.status);
    }
  }
  if (partial.label) feature.label = partial.label;
  schedulePersist();
}

export function removeSelected() {
  site.features = site.features.filter((f) => f.id !== site.selectedId);
  site.selectedId = site.features.at(-1)?.id ?? null;
  schedulePersist();
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
  const measuredEnv = measured ? structureEnvelope(measured) : null;

  const edges = parcelEdges(site.geom);
  setSrc(map, "site-edges", {
    type: "FeatureCollection",
    features: edges.map((edge) => {
      let label = `${formatFeet(edge.lengthFt)} ${compass(edge.bearing)}`;
      if (measuredEnv) {
        const toBldg = minDistToEdgeFt(measuredEnv, edge);
        label = `${formatFeet(edge.lengthFt)} · ${formatFeet(toBldg)} to projection`;
      }
      return {
        type: "Feature" as const,
        properties: { label },
        geometry: { type: "LineString" as const, coordinates: [edge.start, edge.end] },
      };
    }),
  });

  setSrc(map, "site-envelope", {
    type: "FeatureCollection",
    features: structures.flatMap((feature) => {
      if (structureEaveFt(feature) <= 0) return [];
      const env = structureEnvelope(feature);
      if (!env) return [];
      return [
        {
          ...env,
          properties: {
            id: feature.id,
            status: feature.status,
            selected: feature.id === site.selectedId,
          },
        },
      ];
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
      .filter((f) => f.kind === "well" || f.kind === "septic" || f.kind === "front_door")
      .flatMap((f): Feature<Point>[] => {
        const center = featureCenter(f);
        if (!center) return [];
        return [
          {
            type: "Feature",
            properties: {
              id: f.id,
              kind: f.kind,
              status: f.status,
              selected: f.id === site.selectedId,
              label: f.label,
            },
            geometry: { type: "Point", coordinates: center },
          },
        ];
      }),
  });
}

function pickFeatureAt(lngLat: Position): PlanFeature | null {
  let bestPoint: PlanFeature | null = null;
  let bestFt = Infinity;
  for (const feature of site.features) {
    if (feature.kind === "structure") continue;
    const center = featureCenter(feature);
    if (!center) continue;
    const dist = feetBetween(center, lngLat);
    if (dist < bestFt) {
      bestFt = dist;
      bestPoint = feature;
    }
  }
  // Door sits on the eave envelope; prefer a nearby point so Delete removes the door.
  if (bestPoint && bestFt <= DOOR_SNAP_FT) return bestPoint;

  for (let i = site.features.length - 1; i >= 0; i--) {
    const feature = site.features[i];
    if (feature.kind !== "structure") continue;
    const poly = structurePoly(feature);
    if (poly && pointInParcel(lngLat, poly.geometry)) return feature;
  }

  if (bestPoint && bestFt < 25) return bestPoint;
  return null;
}

function placeFrontDoor(lngLat: Position) {
  const structures = site.features.filter((f) => f.kind === "structure");
  const target = structures.find((f) => f.id === site.selectedId) ?? structures[0];
  const envelope = target ? structureEnvelope(target) : null;
  if (!envelope) return null;
  const snap = nearestOnPolygonFt(lngLat, envelope);
  if (!Number.isFinite(snap.distFt) || snap.distFt > DOOR_SNAP_FT) return null;
  return addFeature("front_door", snap.point, { label: "Front door" });
}

export function handleSiteClick(map: MapLibreMap, lngLat: Position) {
  if (!site.active) return false;
  if (site.placeMode === "front_door") {
    const feature = placeFrontDoor(lngLat);
    if (!feature) {
      const el = document.getElementById("status");
      if (el) el.textContent = DOOR_REJECT_MSG;
      return true;
    }
    site.placeMode = null;
    refreshOverlays(map);
    return true;
  }
  if (site.placeMode) {
    const feature = addFeature(site.placeMode, lngLat);
    site.placeMode = null;
    if (feature) refreshOverlays(map);
    return true;
  }
  const hit = pickFeatureAt(lngLat);
  if (!hit) return false;
  site.selectedId = hit.id;
  site.status = hit.status;
  refreshOverlays(map);
  return true;
}

export interface DistanceRow {
  structureId: string;
  structureLabel: string;
  eaveFt: number;
  side: string;
  lotFt: number;
  toBldgFt: number;
}

/** Envelope → every outer-ring lot edge. Packet uses `{ all: true }`; inspector uses selected. */
export function distanceSummary(opts?: { structureId?: string; all?: boolean }): DistanceRow[] {
  if (!site.geom) return [];
  const structures = site.features.filter((f) => f.kind === "structure");
  const wantedId = opts?.structureId ?? site.selectedId;
  const selectedStruct = structures.find((f) => f.id === wantedId);
  const targets = opts?.all ? structures : selectedStruct ? [selectedStruct] : structures.slice(0, 1);
  const edges = parcelEdges(site.geom);
  const rows: DistanceRow[] = [];
  for (const structure of targets) {
    const envelope = structureEnvelope(structure);
    if (!envelope) continue;
    const chunk = edges
      .map((edge) => ({
        structureId: structure.id,
        structureLabel: structure.label,
        eaveFt: structureEaveFt(structure),
        side: compass(edge.bearing + 90),
        lotFt: edge.lengthFt,
        toBldgFt: minDistToEdgeFt(envelope, edge),
      }))
      .sort((a, b) => a.toBldgFt - b.toBldgFt);
    rows.push(...chunk);
  }
  return rows;
}
