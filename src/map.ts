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

export function highlightParcel(map: maplibregl.Map, pin: string | null) {
  if (!map.getLayer("parcels-selected")) return;
  map.setFilter("parcels-selected", ["==", ["get", "pin"], pin ?? ""]);
}

export function queryParcelAt(map: maplibregl.Map, point: maplibregl.PointLike) {
  const hits = map.queryRenderedFeatures(point, {
    layers: ["parcels-fill-private", "parcels-fill-public", "parcels-line"],
  });
  const hit = hits[0];
  if (!hit?.properties) return null;
  return hit.properties as unknown as ParcelProps;
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
