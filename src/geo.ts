import { point, polygon, lineString } from "@turf/helpers";
import distance from "@turf/distance";
import length from "@turf/length";
import centroid from "@turf/centroid";
import bbox from "@turf/bbox";
import buffer from "@turf/buffer";
import nearestPointOnLine from "@turf/nearest-point-on-line";
import polygonToLine from "@turf/polygon-to-line";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon, MultiPolygon, Position } from "geojson";

export type Ring = Position[];

export function asPolygon(geom: Polygon | MultiPolygon): Feature<Polygon | MultiPolygon> {
  return { type: "Feature", properties: {}, geometry: geom };
}

export function outerRings(geom: Polygon | MultiPolygon): Ring[] {
  if (geom.type === "Polygon") return [geom.coordinates[0]];
  return geom.coordinates.map((poly) => poly[0]);
}

export function feetBetween(a: Position, b: Position) {
  return distance(point(a), point(b), { units: "feet" });
}

export function ringLengthFt(ring: Ring) {
  return length(lineString(ring), { units: "feet" });
}

export function parcelCentroid(geom: Polygon | MultiPolygon): Position {
  return centroid(asPolygon(geom)).geometry.coordinates;
}

export function parcelBbox(geom: Polygon | MultiPolygon): [number, number, number, number] {
  return bbox(asPolygon(geom)) as [number, number, number, number];
}

export function destination(from: Position, feet: number, bearingDeg: number): Position {
  const earth = 20902231;
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (from[1] * Math.PI) / 180;
  const lon1 = (from[0] * Math.PI) / 180;
  const ang = feet / earth;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(br),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}

export function rectanglePolygon(
  center: Position,
  widthFt: number,
  lengthFt: number,
  rotationDeg: number,
): Feature<Polygon> {
  const halfW = widthFt / 2;
  const halfL = lengthFt / 2;
  const corners = [
    destination(destination(center, halfL, rotationDeg), halfW, rotationDeg + 90),
    destination(destination(center, halfL, rotationDeg), halfW, rotationDeg - 90),
    destination(destination(center, halfL, rotationDeg + 180), halfW, rotationDeg - 90),
    destination(destination(center, halfL, rotationDeg + 180), halfW, rotationDeg + 90),
  ];
  corners.push(corners[0]);
  return polygon([corners]);
}

export function inwardSetback(geom: Polygon | MultiPolygon, feet: number) {
  if (feet <= 0) return asPolygon(geom);
  try {
    return buffer(asPolygon(geom), -feet, { units: "feet" }) ?? null;
  } catch {
    return null;
  }
}

/** Outward permit envelope: eaves/decks around a structure rectangle. */
export function eaveEnvelope(
  poly: Feature<Polygon>,
  eaveFt: number,
): Feature<Polygon | MultiPolygon> {
  const feet = Number.isFinite(eaveFt) ? Math.max(0, eaveFt) : 0;
  if (feet === 0) return poly;
  try {
    return buffer(poly, feet, { units: "feet" }) ?? poly;
  } catch {
    return poly;
  }
}

export function pointInParcel(lngLat: Position, geom: Polygon | MultiPolygon) {
  return booleanPointInPolygon(point(lngLat), asPolygon(geom));
}

export interface EdgeMeasure {
  index: number;
  start: Position;
  end: Position;
  mid: Position;
  lengthFt: number;
  bearing: number;
}

export function parcelEdges(geom: Polygon | MultiPolygon): EdgeMeasure[] {
  const edges: EdgeMeasure[] = [];
  let i = 0;
  for (const ring of outerRings(geom)) {
    for (let k = 0; k < ring.length - 1; k++) {
      const start = ring[k];
      const end = ring[k + 1];
      const len = feetBetween(start, end);
      if (len < 2) continue;
      edges.push({
        index: i++,
        start,
        end,
        mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
        lengthFt: len,
        bearing: bearing(start, end),
      });
    }
  }
  return edges;
}

export function bearing(a: Position, b: Position) {
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const Δλ = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function compass(bearingDeg: number) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(bearingDeg / 45) % 8];
}

export function minDistToEdgeFt(from: Feature<Polygon | MultiPolygon>, edge: EdgeMeasure) {
  const line = lineString([edge.start, edge.end]);
  let min = Infinity;
  for (const ring of outerRings(from.geometry)) {
    for (const pt of ring) {
      const snapped = nearestPointOnLine(line, point(pt), { units: "feet" });
      min = Math.min(min, snapped.properties.dist ?? Infinity);
    }
  }
  return min;
}

export function nearestOnPolygonFt(
  from: Position,
  poly: Feature<Polygon | MultiPolygon>,
): { point: Position; distFt: number } {
  const line = polygonToLine(poly);
  const features = line.type === "FeatureCollection" ? line.features : [line];
  let best: Position = from;
  let min = Infinity;
  for (const feat of features) {
    if (feat.geometry.type !== "LineString" && feat.geometry.type !== "MultiLineString") continue;
    const snapped = nearestPointOnLine(feat as never, point(from), { units: "feet" });
    const d = snapped.properties.dist ?? Infinity;
    if (d < min) {
      min = d;
      best = snapped.geometry.coordinates;
    }
  }
  return { point: best, distFt: min };
}

export function minDistToParcelFt(from: Position, geom: Polygon | MultiPolygon) {
  const line = polygonToLine(asPolygon(geom));
  const features = line.type === "FeatureCollection" ? line.features : [line];
  let min = Infinity;
  for (const feat of features) {
    if (feat.geometry.type !== "LineString" && feat.geometry.type !== "MultiLineString") continue;
    const snapped = nearestPointOnLine(feat as never, point(from), { units: "feet" });
    min = Math.min(min, snapped.properties.dist ?? Infinity);
  }
  return min;
}

export function formatFeet(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value)} ft`;
}
