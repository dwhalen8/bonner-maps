import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection, Point, Polygon, MultiPolygon, Position } from "geojson";
import type { ParcelProps } from "./types";
import {
  compass,
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

export type SiteKind = "structure" | "well" | "septic";
export type PlaceMode = null | SiteKind;

export interface SiteMark {
  id: string;
  kind: SiteKind;
  label: string;
  center: Position;
  widthFt?: number;
  lengthFt?: number;
  rotationDeg?: number;
}

export interface SiteState {
  active: boolean;
  parcel: ParcelProps | null;
  geom: Polygon | MultiPolygon | null;
  zoning: string | null;
  rule: SetbackRule;
  lineFt: number;
  accessory: boolean;
  marks: SiteMark[];
  selectedId: string | null;
  placeMode: PlaceMode;
  use: string;
  notes: string;
}

export const site: SiteState = {
  active: false,
  parcel: null,
  geom: null,
  zoning: null,
  rule: ruleForZone(null),
  lineFt: 25,
  accessory: false,
  marks: [],
  selectedId: null,
  placeMode: null,
  use: "Single-family dwelling",
  notes: "",
};

const empty = (): FeatureCollection => ({ type: "FeatureCollection", features: [] });

function setSrc(map: MapLibreMap, id: string, data: FeatureCollection) {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  src?.setData(data);
}

export function addSiteLayers(map: MapLibreMap) {
  const layers: [string, string][] = [
    ["site-parcel", "geojson"],
    ["site-setback", "geojson"],
    ["site-edges", "geojson"],
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
      id: "site-structure-fill",
      type: "fill",
      source: "site-structure",
      paint: { "fill-color": "#c1121f", "fill-opacity": 0.35 },
    });
    map.addLayer({
      id: "site-structure-line",
      type: "line",
      source: "site-structure",
      paint: { "line-color": "#6a040f", "line-width": 2 },
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
        "circle-radius": 6,
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
}

export function clearSiteLayers(map: MapLibreMap) {
  for (const id of ["site-parcel", "site-setback", "site-edges", "site-structure", "site-points"]) {
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

export async function startSitePlan(
  map: MapLibreMap,
  parcel: ParcelProps,
  geom: Polygon | MultiPolygon,
) {
  site.active = true;
  site.parcel = parcel;
  site.geom = geom;
  site.marks = [];
  site.selectedId = null;
  site.placeMode = null;
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
  const [lng, lat] = parcelCentroid(geom);
  try {
    site.zoning = await fetchZoningAt(lng, lat);
  } catch {
    site.zoning = null;
  }
  site.rule = ruleForZone(site.zoning);
  if (!site.accessory) site.lineFt = site.rule.lineFt;
  refreshOverlays(map);
}

export function exitSitePlan(map: MapLibreMap) {
  site.active = false;
  site.parcel = null;
  site.geom = null;
  site.placeMode = null;
  site.marks = [];
  clearSiteLayers(map);
  for (const id of ["parcels-line", "parcels-fill-private", "parcels-fill-public", "parcels-label", "county-outline"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
  }
}

export function setLineSetback(map: MapLibreMap, feet: number) {
  site.lineFt = Math.max(0, feet);
  refreshOverlays(map);
}

export function addMark(kind: SiteKind, center: Position, extras: Partial<SiteMark> = {}) {
  if (!site.geom || !pointInParcel(center, site.geom)) return null;
  const id = `${kind}-${Date.now()}`;
  const mark: SiteMark = {
    id,
    kind,
    label:
      extras.label ??
      (kind === "structure" ? "Proposed structure" : kind === "well" ? "Well" : "Septic"),
    center,
    widthFt: extras.widthFt ?? (kind === "structure" ? 40 : undefined),
    lengthFt: extras.lengthFt ?? (kind === "structure" ? 60 : undefined),
    rotationDeg: extras.rotationDeg ?? 0,
  };
  site.marks.push(mark);
  site.selectedId = id;
  return mark;
}

export function updateSelected(partial: Partial<SiteMark>) {
  const mark = site.marks.find((m) => m.id === site.selectedId);
  if (!mark) return;
  Object.assign(mark, partial);
}

export function removeSelected() {
  site.marks = site.marks.filter((m) => m.id !== site.selectedId);
  site.selectedId = site.marks.at(-1)?.id ?? null;
}

export function refreshOverlays(map: MapLibreMap) {
  if (!site.geom) return;
  const setback = inwardSetback(site.geom, site.lineFt);
  setSrc(map, "site-setback", {
    type: "FeatureCollection",
    features: setback ? [setback] : [],
  });

  const structure = site.marks.find((m) => m.kind === "structure");
  const structurePoly =
    structure && structure.widthFt && structure.lengthFt
      ? rectanglePolygon(
          structure.center,
          structure.widthFt,
          structure.lengthFt,
          structure.rotationDeg ?? 0,
        )
      : null;

  const edges = parcelEdges(site.geom);
  setSrc(map, "site-edges", {
    type: "FeatureCollection",
    features: edges.map((edge) => {
      let label = `${formatFeet(edge.lengthFt)} ${compass(edge.bearing)}`;
      if (structurePoly) {
        const toBldg = minDistToEdgeFt(structurePoly, edge);
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
    features: structurePoly
      ? [
          {
            ...structurePoly,
            properties: {
              label: `${structure?.label ?? "Structure"} ${structure?.widthFt}×${structure?.lengthFt} ft`,
            },
          },
        ]
      : [],
  });

  setSrc(map, "site-points", {
    type: "FeatureCollection",
    features: site.marks
      .filter((m) => m.kind !== "structure")
      .map(
        (m): Feature<Point> => ({
          type: "Feature",
          properties: { kind: m.kind, label: m.label },
          geometry: { type: "Point", coordinates: m.center },
        }),
      ),
  });
}

export function handleSiteClick(map: MapLibreMap, lngLat: Position) {
  if (!site.active || !site.placeMode) return false;
  const mark = addMark(site.placeMode, lngLat);
  site.placeMode = null;
  if (mark) refreshOverlays(map);
  return true;
}

export function distanceSummary() {
  if (!site.geom) return [];
  const structure = site.marks.find((m) => m.kind === "structure");
  if (!structure?.widthFt || !structure.lengthFt) return [];
  const poly = rectanglePolygon(
    structure.center,
    structure.widthFt,
    structure.lengthFt,
    structure.rotationDeg ?? 0,
  );
  return parcelEdges(site.geom)
    .filter((e) => e.lengthFt >= 15)
    .map((edge) => ({
      side: compass(edge.bearing + 90),
      lotFt: edge.lengthFt,
      toBldgFt: minDistToEdgeFt(poly, edge),
    }))
    .sort((a, b) => a.toBldgFt - b.toBldgFt);
}
