import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { DataMeta, ParcelProps } from "./types";
import { LAND_LABELS } from "./types";
import {
  addDataLayers,
  addLocationDot,
  createMap,
  highlightParcel,
  parcelFeatureByPin,
  queryParcelAt,
  queryParcelFeature,
  setBasemap,
  setLayerVisible,
  updateLocation,
  type BasemapId,
} from "./map";
import {
  distanceSummary,
  exitSitePlan,
  handleSiteClick,
  refreshOverlays,
  removeSelected,
  setLineSetback,
  site,
  startSitePlan,
  updateSelected,
} from "./siteplan";
import { formatFeet } from "./geo";
import type { Polygon, MultiPolygon } from "geojson";
import { findByPin, loadSearchIndex, searchParcels } from "./search";
import {
  formatBytes,
  packStatus,
  registerOfflineWorker,
  saveOfflinePack,
} from "./offline";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function money(value: number) {
  if (!value) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function acres(value: number) {
  if (!value) return "—";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ac`;
}

function showParcel(props: ParcelProps) {
  site.parcel = props;
  $("layers-panel").hidden = true;
  const card = $("parcel-card");
  $("parcel-owner").textContent = props.o1 || props.addr || "Unknown owner";
  const extra = Number(props.naddr) > 1 ? ` (+${Number(props.naddr) - 1} more)` : "";
  $("parcel-addr").textContent = props.addr ? `${props.addr}${extra}` : "";
  $("parcel-owner2").textContent = props.o2 || props.addrs || "";
  $("parcel-pin").textContent = props.pin || "—";
  $("parcel-acres").textContent = acres(Number(props.acres));
  $("parcel-class").textContent = props.cls || "—";
  $("parcel-value").textContent = money(Number(props.value));
  $("parcel-deed").textContent = props.deed || "—";
  const badge = $("parcel-land");
  badge.textContent = LAND_LABELS[props.land] || props.land;
  badge.className = `badge ${props.land}`;
  card.hidden = false;
  $("siteplan-panel").hidden = true;
}

function hideParcel(map: MapLibreMap) {
  $("parcel-card").hidden = true;
  if (!site.active) highlightParcel(map, null);
}

function renderDistances() {
  const list = $("site-distances");
  list.replaceChildren();
  const rows = distanceSummary();
  if (!rows.length) {
    list.innerHTML = "<li>Place a structure to measure setbacks to each lot line.</li>";
    return;
  }
  for (const row of rows.slice(0, 8)) {
    const li = document.createElement("li");
    const ok = row.toBldgFt + 0.5 >= site.lineFt;
    li.textContent = `${row.side} line ${formatFeet(row.lotFt)} · ${formatFeet(row.toBldgFt)} to structure${ok ? "" : " — short of setback"}`;
    if (!ok) li.style.color = "#ffb4a6";
    list.append(li);
  }
}

function fillPrintBlock() {
  const p = site.parcel;
  const when = new Date().toLocaleDateString();
  $("print-meta").textContent = [
    p?.o1,
    p?.addr,
    p?.pin ? `PIN ${p.pin}` : "",
    p?.acres ? acres(Number(p.acres)) : "",
    site.zoning ? `Zoning: ${site.zoning}` : "",
    `Setback used: ${site.lineFt} ft`,
    `Use: ${site.use}`,
    when,
  ]
    .filter(Boolean)
    .join("  ·  ");
  $("print-measures").textContent = distanceSummary()
    .slice(0, 8)
    .map((row) => `${row.side}: ${formatFeet(row.toBldgFt)} to structure`)
    .join("   ");
  $("print-notes").textContent = site.notes;
}

async function openSitePlan(map: MapLibreMap, props: ParcelProps, geom: Polygon | MultiPolygon) {
  $("parcel-card").hidden = true;
  $("layers-panel").hidden = true;
  $("siteplan-panel").hidden = false;
  $("status").textContent = "Site plan · tap Place structure, then tap the lot";
  await startSitePlan(map, props, geom);
  $("site-zone").textContent = site.zoning
    ? `${site.zoning} · typical setback ${site.rule.lineFt} ft (${site.rule.source})`
    : `Zoning unavailable · using ${site.lineFt} ft. Confirm Tables 12-411 / 12-412.`;
  $<HTMLInputElement>("site-setback").value = String(site.lineFt);
  renderDistances();
}

function bindSitePlan(map: MapLibreMap) {
  $("open-siteplan").addEventListener("click", () => {
    const pin = site.parcel?.pin || $("parcel-pin").textContent || "";
    const found = pin ? parcelFeatureByPin(map, pin) : null;
    if (!found) {
      $("status").textContent = "Zoom in on the parcel, then try Make BLP site map again.";
      return;
    }
    const props = { ...found.properties, ...site.parcel };
    void openSitePlan(map, props, found.geometry);
  });

  $("close-siteplan").addEventListener("click", () => {
    $("siteplan-panel").hidden = true;
    exitSitePlan(map);
    highlightParcel(map, null);
  });

  const setback = $<HTMLInputElement>("site-setback");
  const accessory = $<HTMLInputElement>("site-accessory");
  const width = $<HTMLInputElement>("site-width");
  const length = $<HTMLInputElement>("site-length");
  const rot = $<HTMLInputElement>("site-rot");

  setback.addEventListener("change", () => {
    setLineSetback(map, Number(setback.value) || 0);
    renderDistances();
  });
  accessory.addEventListener("change", () => {
    site.accessory = accessory.checked;
    const feet = accessory.checked ? site.rule.accessoryFt : site.rule.lineFt;
    setback.value = String(feet);
    setLineSetback(map, feet);
    renderDistances();
  });
  const syncSize = () => {
    updateSelected({
      widthFt: Number(width.value) || 40,
      lengthFt: Number(length.value) || 60,
      rotationDeg: Number(rot.value) || 0,
    });
    refreshOverlays(map);
    renderDistances();
  };
  width.addEventListener("change", syncSize);
  length.addEventListener("change", syncSize);
  rot.addEventListener("change", syncSize);

  $("site-use").addEventListener("input", (event) => {
    site.use = (event.target as HTMLInputElement).value;
  });
  $("site-notes").addEventListener("input", (event) => {
    site.notes = (event.target as HTMLTextAreaElement).value;
  });

  const arm = (id: string, mode: "structure" | "well" | "septic") => {
    $(id).addEventListener("click", () => {
      site.placeMode = mode;
      for (const btn of document.querySelectorAll(".btn-row .ghost")) {
        btn.classList.toggle("active", btn.id === id);
      }
      $("status").textContent =
        mode === "structure" ? "Tap the lot to place the structure" : `Tap the lot to place the ${mode}`;
    });
  };
  arm("place-structure", "structure");
  arm("place-well", "well");
  arm("place-septic", "septic");

  $("print-sitemap").addEventListener("click", () => {
    fillPrintBlock();
    map.resize();
    window.setTimeout(() => window.print(), 250);
  });

  window.addEventListener("keydown", (event) => {
    if (!site.active) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      if ((event.target as HTMLElement).tagName === "INPUT" || (event.target as HTMLElement).tagName === "TEXTAREA") {
        return;
      }
      removeSelected();
      refreshOverlays(map);
      renderDistances();
    }
  });
}

function bindSearch(map: MapLibreMap) {
  const input = $<HTMLInputElement>("search-input");
  const list = $("search-results");

  const render = () => {
    const hits = searchParcels(input.value);
    list.replaceChildren();
    if (!hits.length) {
      list.hidden = true;
      return;
    }
    for (const hit of hits) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const title = hit.addr || hit.o || "Unknown";
      const sub = [hit.addr ? hit.o : "", hit.pin, hit.a ? acres(hit.a) : "", hit.o ? LAND_LABELS[hit.k] : "Address"]
        .filter(Boolean)
        .join(" · ");
      btn.innerHTML = `<strong>${title}</strong><small>${sub}</small>`;
      btn.addEventListener("click", () => {
        list.hidden = true;
        input.value = hit.addr || hit.o;
        if (hit.lng != null && hit.lat != null) {
          map.flyTo({ center: [hit.lng, hit.lat], zoom: Math.max(map.getZoom(), 15) });
        }
        highlightParcel(map, hit.pin);
        showParcel({
          pin: hit.pin,
          o1: hit.o,
          o2: hit.o2,
          acres: hit.a,
          cls: "",
          value: 0,
          tax: "",
          deed: "",
          land: hit.k,
          addr: hit.addr,
        });
      });
      li.append(btn);
      list.append(li);
    }
    list.hidden = false;
  };

  input.addEventListener("input", render);
  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    render();
  });
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) return;
    if (!$("search-form").contains(event.target)) list.hidden = true;
  });
}

function bindLayers(map: MapLibreMap) {
  const panel = $("layers-panel");
  $("layers-btn").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });
  $("layer-parcels").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    setLayerVisible(map, "parcels-line", on);
    setLayerVisible(map, "parcels-fill-private", on);
  });
  $("layer-public").addEventListener("change", (event) => {
    setLayerVisible(map, "parcels-fill-public", (event.target as HTMLInputElement).checked);
  });
  $("layer-labels").addEventListener("change", (event) => {
    setLayerVisible(map, "parcels-label", (event.target as HTMLInputElement).checked);
  });
  $("layer-county").addEventListener("change", (event) => {
    setLayerVisible(map, "county-outline", (event.target as HTMLInputElement).checked);
  });
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="basemap"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) setBasemap(map, radio.value as BasemapId);
    });
  }
  window.addEventListener("offline", () => {
    const topo = document.querySelector<HTMLInputElement>('input[name="basemap"][value="topo"]');
    if (topo) {
      topo.checked = true;
      setBasemap(map, "topo");
      $("status").textContent = "Offline — using saved USGS topo";
    }
  });
}

async function refreshOfflineLabel() {
  const status = await packStatus();
  if (status.ready) {
    $("offline-status").textContent = `Offline pack ready (${formatBytes(status.bytes)}, ${status.tiles} topo tiles).`;
    $("offline-btn").textContent = "Refresh offline pack";
    return;
  }
  if (status.dataReady) {
    $("offline-status").textContent = `Parcels saved. Topo ${status.tiles}/${status.tileTarget}. Tap to finish the pack.`;
  } else {
    $("offline-status").textContent =
      `Not saved yet. Pack is parcels + ${status.tileTarget} USGS topo tiles. Use Wi‑Fi.`;
  }
  $("offline-btn").textContent = "Save county for offline";
}

function bindOffline() {
  if (import.meta.env.DEV) void registerOfflineWorker();
  $("offline-btn").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("offline-btn");
    btn.disabled = true;
    $("offline-status").textContent = "Saving offline pack…";
    try {
      const result = await saveOfflinePack((done, total, label) => {
        $("offline-status").textContent = `Saving ${label || "pack"}… ${done}/${total}`;
      });
      $("offline-status").textContent = `Saved ${formatBytes(result.bytes)}. Switch to Topo before you lose cell.`;
      btn.textContent = "Refresh offline pack";
    } catch (err) {
      $("offline-status").textContent = err instanceof Error ? err.message : "Offline save failed";
    } finally {
      btn.disabled = false;
    }
  });
}

function bindLocate(map: MapLibreMap) {
  let watch = 0;
  let following = false;
  const btn = $("locate-btn");

  const onPos = (pos: GeolocationPosition) => {
    const { longitude, latitude } = pos.coords;
    updateLocation(map, longitude, latitude);
    if (following) {
      map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 15) });
    }
    const point = map.project([longitude, latitude]);
    const here = queryParcelAt(map, point);
    $("status").textContent = here
      ? `${here.addr || here.o1 || LAND_LABELS[here.land]}`
      : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  };

  btn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      $("status").textContent = "This browser has no GPS.";
      return;
    }
    following = !following;
    btn.classList.toggle("active", following);
    if (following && !watch) {
      watch = navigator.geolocation.watchPosition(onPos, (err) => {
        $("status").textContent = err.message;
      }, { enableHighAccuracy: true, maximumAge: 2000 });
    }
  });
}

function bindInstall() {
  let deferred: BeforeInstallPromptEvent | null = null;
  const btn = $("install-btn");
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    btn.hidden = false;
  });
  btn.addEventListener("click", async () => {
    await deferred?.prompt();
    btn.hidden = true;
  });
}

async function loadMeta() {
  try {
    const meta = (await (await fetch("/data/meta.json")).json()) as DataMeta;
    const when = new Date(meta.fetchedAt).toLocaleDateString();
    $("status").textContent = `${meta.count.toLocaleString()} parcels · ${when}`;
  } catch {
    $("status").textContent = "Parcel file missing. Run npm run data.";
  }
}

async function boot() {
  const map = createMap($("map"));
  bindInstall();
  bindOffline();
  void refreshOfflineLabel();
  void loadMeta();

  map.on("load", async () => {
    addDataLayers(map);
    addLocationDot(map);
    bindLayers(map);
    bindLocate(map);
    bindSitePlan(map);
    $("close-parcel").addEventListener("click", () => hideParcel(map));

    map.on("click", (event) => {
      if (site.active && handleSiteClick(map, [event.lngLat.lng, event.lngLat.lat])) {
        for (const btn of document.querySelectorAll(".btn-row .ghost")) btn.classList.remove("active");
        renderDistances();
        $("status").textContent = site.marks.some((m) => m.kind === "structure")
          ? "Structure placed · print when the distances look right"
          : "Placed · add the structure to measure setbacks";
        return;
      }
      if (site.active) return;
      const feat = queryParcelFeature(map, event.point);
      if (!feat) {
        hideParcel(map);
        return;
      }
      highlightParcel(map, feat.properties.pin);
      const fromIndex = findByPin(feat.properties.pin);
      showParcel({
        ...feat.properties,
        o1: feat.properties.o1 || fromIndex?.o || "",
        o2: feat.properties.o2 || fromIndex?.o2 || "",
        addr: feat.properties.addr || fromIndex?.addr || "",
      });
    });

    map.on("sourcedata", (event) => {
      if (event.sourceId === "parcels" && event.isSourceLoaded) {
        $("status").textContent = "Parcels on the map · tap a lot";
      }
    });

    try {
      const count = await loadSearchIndex();
      bindSearch(map);
      $("status").textContent = `Loaded ${count.toLocaleString()} parcels · drawing…`;
    } catch (err) {
      $("status").textContent = err instanceof Error ? err.message : "Search index missing";
    }
  });
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

void boot();
