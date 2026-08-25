import maplibregl from "maplibre-gl";
import type { ParcelProps } from "./types";
import { COUNTY_BOUNDS, COUNTY_CENTER } from "./types";

export type BasemapId = "hybrid" | "satellite" | "topo" | "dark";

const SAT_TILES =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const TOPO_TILES =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}";

function baseStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: "Bonner Bounds",
    glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#0f1c16" },
      },
    ],
  };
}

export function createMap(container: HTMLElement) {
  const map = new maplibregl.Map({
    container,
    style: baseStyle(),
    center: COUNTY_CENTER,
    zoom: 9.2,
    maxBounds: [
      [COUNTY_BOUNDS[0][0] - 0.4, COUNTY_BOUNDS[0][1] - 0.3],
      [COUNTY_BOUNDS[1][0] + 0.4, COUNTY_BOUNDS[1][1] + 0.3],
    ],
    attributionControl: { compact: true },
    hash: true,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  return map;
}

export function addDataLayers(map: maplibregl.Map) {
  map.addSource("satellite", {
    type: "raster",
    tiles: [SAT_TILES],
    tileSize: 256,
    attribution: "Imagery © Esri",
    maxzoom: 19,
  });
  map.addSource("topo", {
    type: "raster",
    tiles: [TOPO_TILES],
    tileSize: 256,
    attribution: "USGS The National Map",
    maxzoom: 16,
  });

  map.addLayer({
    id: "topo-layer",
    type: "raster",
    source: "topo",
    layout: { visibility: "none" },
  });
  map.addLayer({
    id: "satellite-layer",
    type: "raster",
    source: "satellite",
    layout: { visibility: "visible" },
  });

  map.addSource("parcels", {
    type: "geojson",
    data: "/data/parcels.geojson",
    attribution: "Parcels © Bonner County GIS / Assessor",
    generateId: true,
  });

  map.addLayer({
    id: "parcels-fill-public",
    type: "fill",
    source: "parcels",
    minzoom: 9,
    filter: ["!=", ["get", "land"], "private"],
    paint: {
      "fill-color": [
        "match",
        ["get", "land"],
        "usfs",
        "#2d6a4f",
        "us",
        "#2d6a4f",
        "fws",
        "#40916c",
        "idfg",
        "#52b788",
        "blm",
        "#e9c46a",
        "idl",
        "#e76f51",
        "parks",
        "#f4a261",
        "county",
        "#6c757d",
        "city",
        "#8d99ae",
        "itd",
        "#adb5bd",
        "#2d6a4f",
      ],
      "fill-opacity": 0.32,
    },
  });

  map.addLayer({
    id: "parcels-fill-private",
    type: "fill",
    source: "parcels",
    minzoom: 12,
    filter: ["==", ["get", "land"], "private"],
    paint: {
      "fill-color": "#ff4d2e",
      "fill-opacity": 0.02,
    },
  });

  map.addLayer({
    id: "parcels-line",
    type: "line",
    source: "parcels",
    minzoom: 8,
    paint: {
      "line-color": [
        "case",
        ["==", ["get", "land"], "private"],
        "#ff4d2e",
        "#d8f3dc",
      ],
      "line-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        0.2,
        12,
        0.8,
        16,
        1.8,
      ],
      "line-opacity": 0.95,
    },
  });

  map.addLayer({
    id: "parcels-selected",
    type: "line",
    source: "parcels",
    filter: ["==", ["get", "pin"], ""],
    paint: {
      "line-color": "#ffd166",
      "line-width": 3,
    },
  });

  map.addLayer({
    id: "parcels-label",
    type: "symbol",
    source: "parcels",
    minzoom: 14.2,
    layout: {
      "text-field": ["get", "o1"],
      "text-size": 11,
      "text-font": ["Noto Sans Regular"],
      "text-max-width": 10,
      visibility: "visible",
    },
    paint: {
      "text-color": "#f8f4e3",
      "text-halo-color": "#111813",
      "text-halo-width": 1.2,
    },
  });

  map.addSource("county", {
    type: "geojson",
    data: "/data/county.geojson",
  });
  map.addLayer({
    id: "county-outline",
    type: "line",
    source: "county",
    paint: {
      "line-color": "#d4b46a",
      "line-width": 2.2,
      "line-dasharray": [3, 2],
    },
  });
}

export function setBasemap(map: maplibregl.Map, mode: BasemapId) {
  map.setLayoutProperty(
    "satellite-layer",
    "visibility",
    mode === "hybrid" || mode === "satellite" ? "visible" : "none",
  );
  map.setLayoutProperty("topo-layer", "visibility", mode === "topo" ? "visible" : "none");
}

export function setLayerVisible(map: maplibregl.Map, id: string, on: boolean) {
  if (!map.getLayer(id)) return;
  map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

/** Same ids as `fill-pattern` on `site-use-area-hatch`. */
export const USE_AREA_HATCH_IDS = {
  garden: "hatch-garden",
  pasture: "hatch-pasture",
  timber: "hatch-timber",
  shop_yard: "hatch-shop-yard",
  orchard: "hatch-orchard",
  other: "hatch-other",
} as const;

const HATCH_SIZE = 32;

type HatchSpec = {
  id: string;
  color: string;
  angle: 0 | 45 | 90 | 135;
  spacing: number;
  cross?: boolean;
};

const HATCH_SPECS: HatchSpec[] = [
  { id: USE_AREA_HATCH_IDS.garden, color: "#2d6a4f", angle: 45, spacing: 8 },
  { id: USE_AREA_HATCH_IDS.pasture, color: "#6a994e", angle: 0, spacing: 8 },
  { id: USE_AREA_HATCH_IDS.timber, color: "#1b4332", angle: 90, spacing: 8 },
  { id: USE_AREA_HATCH_IDS.shop_yard, color: "#6c584c", angle: 45, spacing: 8, cross: true },
  { id: USE_AREA_HATCH_IDS.orchard, color: "#bc4749", angle: 135, spacing: 8 },
  { id: USE_AREA_HATCH_IDS.other, color: "#b08968", angle: 45, spacing: 10 },
];

function makeHatchImage(spec: HatchSpec): ImageData {
  const size = HATCH_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return new ImageData(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = spec.color;
  ctx.lineWidth = 1.75;
  ctx.lineCap = "butt";

  const stroke = (angle: 0 | 45 | 90 | 135) => {
    ctx.beginPath();
    if (angle === 0) {
      for (let y = spec.spacing / 2; y < size; y += spec.spacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(size, y);
      }
    } else if (angle === 90) {
      for (let x = spec.spacing / 2; x < size; x += spec.spacing) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size);
      }
    } else if (angle === 45) {
      for (let i = -size; i <= size; i += spec.spacing) {
        ctx.moveTo(i, size);
        ctx.lineTo(i + size, 0);
      }
    } else {
      for (let i = -size; i <= size; i += spec.spacing) {
        ctx.moveTo(i, 0);
        ctx.lineTo(i + size, size);
      }
    }
    ctx.stroke();
  };

  stroke(spec.angle);
  if (spec.cross) stroke(((spec.angle + 90) % 180) as 0 | 45 | 90 | 135);
  return ctx.getImageData(0, 0, size, size);
}

/** Transparent tiled hatches for use-area fills. Idempotent. */
export function addHatchPatterns(map: maplibregl.Map) {
  for (const spec of HATCH_SPECS) {
    if (map.hasImage(spec.id)) continue;
    map.addImage(spec.id, makeHatchImage(spec));
  }
}

/** Vertex-draw uses double-tap to finish; disable the map's zoom while drawing. */
export function setDoubleClickZoom(map: maplibregl.Map, on: boolean) {
  if (on) map.doubleClickZoom.enable();
  else map.doubleClickZoom.disable();
}

export function highlightParcel(map: maplibregl.Map, pin: string | null) {
  if (!map.getLayer("parcels-selected")) return;
  map.setFilter("parcels-selected", ["==", ["get", "pin"], pin ?? ""]);
}

export function queryParcelAt(map: maplibregl.Map, point: maplibregl.PointLike) {
  const feat = queryParcelFeature(map, point);
  return feat?.properties ?? null;
}

export function queryParcelFeature(map: maplibregl.Map, point: maplibregl.PointLike) {
  const hits = map.queryRenderedFeatures(point, {
    layers: ["parcels-fill-private", "parcels-fill-public", "parcels-line"],
  });
  const hit = hits[0];
  if (!hit?.properties) return null;
  const pin = String(hit.properties.pin ?? "");
  const fromSource = pin
    ? map.querySourceFeatures("parcels", { filter: ["==", ["get", "pin"], pin] })[0]
    : null;
  const feature = fromSource ?? hit;
  const geom = feature.geometry;
  if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") return null;
  return {
    properties: feature.properties as unknown as ParcelProps,
    geometry: geom,
  };
}

export function parcelFeatureByPin(map: maplibregl.Map, pin: string) {
  const hit = map.querySourceFeatures("parcels", { filter: ["==", ["get", "pin"], pin] })[0];
  if (!hit || (hit.geometry.type !== "Polygon" && hit.geometry.type !== "MultiPolygon")) {
    return null;
  }
  return {
    properties: hit.properties as unknown as ParcelProps,
    geometry: hit.geometry,
  };
}

export function addLocationDot(map: maplibregl.Map) {
  map.addSource("me", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "me-dot",
    type: "circle",
    source: "me",
    paint: {
      "circle-radius": 7,
      "circle-color": "#4cc9f0",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
}

export function updateLocation(map: maplibregl.Map, lng: number, lat: number) {
  const source = map.getSource("me") as maplibregl.GeoJSONSource | undefined;
  source?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [lng, lat] },
      },
    ],
  });
}
