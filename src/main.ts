import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { DataMeta, ParcelProps } from "./types";
import { LAND_LABELS } from "./types";
import { logout, me, requestOtp, verifyOtp, type Me } from "./auth";
import { toParcelSnapshot } from "@shared/plan";
import {
  claimPlan,
  draftHasWork,
  planByPin,
  pullPlans,
  setPlanStoreHooks,
  type ConflictChoice,
  type RevConflict,
  type StoredPlan,
} from "./plan-store";
import {
  addDataLayers,
  addLocationDot,
  applyConstraintLayers,
  CONSTRAINT_TOGGLES,
  createMap,
  highlightParcel,
  parcelFeatureByPin,
  queryParcelAt,
  queryParcelFeature,
  setBasemap,
  setLayerVisible,
  stripLoginQuery,
  updateLocation,
  type BasemapId,
} from "./map";
import { fetchConstraintOverlays, incompleteConstraintMessage, type ConstraintClip } from "./constraints";
import {
  ackServerRev,
  applyClaimedPlan,
  canFinishDraw,
  clearAnonDraft,
  DEFAULT_EAVE_FT,
  distanceSummary,
  docForClaim,
  drawPrompt,
  dropClaimed,
  exitSitePlan,
  finishDrawing,
  flushPersist,
  handleSiteClick,
  isDrawKind,
  parseUseClass,
  peekAnonDraft,
  shouldPreventDrawZoom,
  refreshOverlays,
  refreshSiteZoning,
  removeSelected,
  schedulePersist,
  selectedFeature,
  setClaimed,
  setLineSetback,
  setPlaceMode,
  setView,
  site,
  startSitePlan,
  updateSelected,
  wellSepticAdvisory,
  encroachmentAdvisory,
  type PlanView,
  type SiteKind,
} from "./siteplan";
import { formatFeet } from "./geo";
import {
  deleteAttachment,
  downloadAttachmentsZip,
  listAttachments,
  uploadAttachment,
  type AttachmentKind,
} from "./attachments";
import { PRINT_IOS_HINT, renderPrintBlock } from "./packet";
import type { Polygon, MultiPolygon } from "geojson";
import { findByPin, loadSearchIndex, searchParcels } from "./search";
import {
  formatBytes,
  packStatus,
  registerOfflineWorker,
  saveOfflinePack,
} from "./offline";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let currentUser: Me | null = null;
let siteMap: MapLibreMap | null = null;

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

function showParcel(map: MapLibreMap, props: ParcelProps) {
  if (site.active) {
    $("siteplan-panel").hidden = true;
    $("constraint-layers").hidden = true;
    exitSitePlan(map);
    syncSiteForm();
  }
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
  const advisories = [...wellSepticAdvisory(), ...encroachmentAdvisory(site.constraints?.roads ?? null)];
  if (!rows.length && !advisories.length) {
    list.innerHTML = "<li>Place a structure to measure setbacks to each lot line.</li>";
    return;
  }
  for (const row of rows.slice(0, 8)) {
    const li = document.createElement("li");
    const ok = row.toBldgFt + 0.5 >= site.lineFt;
    li.textContent = `${row.side} line ${formatFeet(row.lotFt)} · ${formatFeet(row.toBldgFt)} to projection${ok ? "" : " — short of setback"}`;
    if (!ok) li.classList.add("warn");
    list.append(li);
  }
  for (const msg of advisories) {
    const li = document.createElement("li");
    li.textContent = msg;
    li.classList.add("warn");
    list.append(li);
  }
}

function fillPrintBlock(map: MapLibreMap) {
  document.documentElement.classList.toggle("print-letter", $<HTMLInputElement>("print-letter").checked);
  renderPrintBlock(map, {
    disturbance: $<HTMLInputElement>("site-disturbance").checked,
    steepSlopes: $<HTMLInputElement>("site-slopes").checked,
  });
}

function syncViewToggle() {
  const isPlan = site.view === "plan";
  const drawingUse = site.placeMode === "use_area";
  $("view-plan").classList.toggle("active", isPlan);
  $("view-packet").classList.toggle("active", !isPlan);
  $("view-plan").setAttribute("aria-pressed", String(isPlan));
  $("view-packet").setAttribute("aria-pressed", String(!isPlan));
  $<HTMLButtonElement>("view-packet").disabled = drawingUse;
  $("view-hint").textContent = drawingUse
    ? "Finish the use area before switching to Packet — new polygons stay off the packet unless Show on packet is checked."
    : isPlan
      ? "Plan is the working map. Packet hides use areas unless Show on packet is checked."
      : "Packet preview — use areas hidden unless Show on packet is checked.";
}

function syncUseAreaFields() {
  const selected = selectedFeature();
  const placing = site.placeMode === "use_area";
  const editing = !site.placeMode && selected?.kind === "use_area";
  $("use-area-fields").hidden = !placing && !editing;
  $("site-on-packet-wrap").hidden = !editing;
  if (editing) site.useClass = parseUseClass(selected.props.useClass);
  $<HTMLSelectElement>("site-use-class").value = site.useClass;
  $<HTMLInputElement>("site-on-packet").checked = editing ? selected.onPacket : false;
}

function syncSiteForm() {
  $<HTMLInputElement>("site-use").value = site.use;
  $<HTMLTextAreaElement>("site-notes").value = site.notes;
  $<HTMLInputElement>("site-accessory").checked = site.accessory;
  $<HTMLInputElement>("site-setback").value = String(site.lineFt);
  const selected = selectedFeature();
  $<HTMLInputElement>("site-existing").checked = (selected?.status ?? site.status) === "existing";
  if (selected?.kind === "structure") {
    if (selected.props.widthFt != null) site.widthFt = selected.props.widthFt;
    if (selected.props.lengthFt != null) site.lengthFt = selected.props.lengthFt;
    if (selected.props.rotationDeg != null) site.rotationDeg = selected.props.rotationDeg;
    if (selected.props.eaveFt != null) site.eaveFt = selected.props.eaveFt;
  }
  $<HTMLInputElement>("site-width").value = String(site.widthFt);
  $<HTMLInputElement>("site-length").value = String(site.lengthFt);
  $<HTMLInputElement>("site-rot").value = String(site.rotationDeg);
  $<HTMLInputElement>("site-eave").value = String(site.eaveFt);
  syncViewToggle();
  syncUseAreaFields();
}

function fillZoneHint() {
  $("site-zone").textContent = site.zoning
    ? `${site.zoning} · typical setback ${site.rule.lineFt} ft (${site.rule.source})`
    : `Looking up zoning · using ${site.lineFt} ft until county GIS answers.`;
}

async function loadSiteConstraints(map: MapLibreMap, sessionPin: string, geom: Polygon | MultiPolygon) {
  const status = $("status");
  const loading = "Site plan · loading constraint overlays…";
  const idle = "Site plan · tap Place structure, then tap the lot";
  if (!status.textContent || status.textContent.startsWith("Site plan")) status.textContent = loading;
  try {
    const apply = (clip: ConstraintClip) => {
      if (!site.active || site.draftPin !== sessionPin) return;
      site.constraints = clip;
      if (site.zoning) clip.zoning = { zonedesc: site.zoning, fetchedAt: clip.zoning.fetchedAt };
      applyConstraintLayers(map, clip);
      applyConstraintToggles(map);
    };
    const clip = await fetchConstraintOverlays(geom, site.zoning, apply);
    if (!site.active || site.draftPin !== sessionPin || !clip) return;
    apply(clip);
    const incomplete = incompleteConstraintMessage(clip);
    if (incomplete) {
      status.textContent = incomplete;
    } else if (status.textContent === loading) {
      status.textContent = idle;
    }
  } catch {
    if (!site.active || site.draftPin !== sessionPin) return;
    status.textContent = "Constraint overlays incomplete · site plan still usable";
  }
}

async function openSitePlan(map: MapLibreMap, props: ParcelProps, geom: Polygon | MultiPolygon) {
  $("parcel-card").hidden = true;
  $("layers-panel").hidden = true;
  $("siteplan-panel").hidden = false;
  $("constraint-layers").hidden = false;
  $("status").textContent = "Site plan · tap Place structure, then tap the lot";
  const claimed = props.pin ? await planByPin(props.pin).catch(() => null) : null;
  const session = startSitePlan(map, props, geom, claimed);
  fillZoneHint();
  syncSiteForm();
  syncDrawUi();
  renderDistances();
  void loadSiteConstraints(map, session.pin, geom);
  await refreshSiteZoning(map, session);
  if (!site.active || site.draftPin !== session.pin) return;
  $("site-zone").textContent = site.zoning
    ? `${site.zoning} · typical setback ${site.rule.lineFt} ft (${site.rule.source})`
    : `Zoning unavailable · using ${site.lineFt} ft. Confirm Tables 12-411 / 12-412.`;
  syncSiteForm();
  renderDistances();
  void refreshAttachments();
}

function clearPlaceButtons() {
  for (const btn of document.querySelectorAll(".btn-row .ghost")) btn.classList.remove("active");
}

function syncDrawUi() {
  const finish = $<HTMLButtonElement>("finish-draw");
  finish.disabled = !canFinishDraw();
}

function promptSignIn(message: string) {
  $("auth-panel").hidden = false;
  $("auth-status").textContent = message;
  $("status").textContent = message;
}

function applyRemotePlan(plan: StoredPlan) {
  const sameOpenPin = site.active && site.draftPin === plan.doc.pin;
  const claimed = site.planId === plan.id;
  const emptyAnon = sameOpenPin && !site.planId && !draftHasWork(peekAnonDraft(plan.doc.pin));
  if (!claimed && !emptyAnon) return;
  applyClaimedPlan(plan);
  const map = siteMap;
  if (site.active && map) {
    refreshOverlays(map);
    syncSiteForm();
    renderDistances();
  }
  void refreshAttachments();
}

function bindClaimed(plan: StoredPlan) {
  if (site.active && site.draftPin === plan.doc.pin) setClaimed(plan);
  void refreshAttachments();
}

function bindSyncConflict() {
  const queue: { resolve: (choice: ConflictChoice) => void }[] = [];

  const show = () => {
    const open = queue.length > 0;
    $("sync-conflict").hidden = !open;
    if (open) {
      $("sync-conflict-msg").textContent = "Newer copy on server — Keep mine / Take server";
      $("status").textContent = "Newer copy on server — Keep mine / Take server";
    }
  };

  const choose = (choice: ConflictChoice) => {
    queue.shift()?.resolve(choice);
    show();
  };

  $("keep-mine").addEventListener("click", () => choose("keep"));
  $("take-server").addEventListener("click", () => choose("take"));

  return (_conflict: RevConflict) =>
    new Promise<ConflictChoice>((resolve) => {
      queue.push({ resolve });
      show();
    });
}

async function claimCurrentParcel(map: MapLibreMap) {
  if (!currentUser) {
    promptSignIn("Sign in to claim this parcel.");
    return;
  }
  const pin = site.parcel?.pin || $("parcel-pin").textContent || "";
  const found = pin ? parcelFeatureByPin(map, pin) : null;
  if (!found) {
    $("status").textContent = "Zoom in on the parcel, then try Claim this parcel again.";
    return;
  }
  const props = { ...found.properties, ...site.parcel };
  const geom = found.geometry;
  $("status").textContent = "Claiming parcel…";
  try {
    const doc = docForClaim(props, geom);
    const plan = await claimPlan({
      pin: props.pin,
      parcel: { props: toParcelSnapshot(props), geom },
      doc,
    });
    clearAnonDraft(props.pin);
    if (site.active && site.draftPin === props.pin) setClaimed(plan);
    $("status").textContent = `Claimed PIN ${props.pin} · saved to this account`;
  } catch (err) {
    $("status").textContent = err instanceof Error ? err.message : "Could not claim parcel";
  }
  void refreshAttachments();
}

async function refreshAttachments() {
  const panel = $("attachment-panel");
  const list = $("att-list");
  const planId = site.planId;
  if (!currentUser || !planId) {
    panel.hidden = true;
    list.replaceChildren();
    return;
  }
  panel.hidden = false;
  try {
    const rows = await listAttachments(planId);
    list.replaceChildren();
    if (!rows.length) {
      const li = document.createElement("li");
      li.textContent = "No uploads yet.";
      list.append(li);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.textContent = `${row.kind} · ${row.filename}`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        try {
          await deleteAttachment(planId, row.id);
          await refreshAttachments();
        } catch (err) {
          $("status").textContent = err instanceof Error ? err.message : "Could not delete";
        }
      });
      li.append(del);
      list.append(li);
    }
  } catch {
    panel.hidden = true;
  }
}

function bindAttachments() {
  $("att-upload").addEventListener("click", async () => {
    const planId = site.planId;
    if (!planId) {
      $("status").textContent = "Claim this parcel to upload drawings.";
      return;
    }
    const input = $<HTMLInputElement>("att-file");
    const file = input.files?.[0];
    if (!file) {
      $("status").textContent = "Choose a PDF or image first.";
      return;
    }
    const kind = $<HTMLSelectElement>("att-kind").value as AttachmentKind;
    try {
      $("status").textContent = "Uploading…";
      await uploadAttachment(planId, kind, file);
      input.value = "";
      await refreshAttachments();
      $("status").textContent = "Uploaded";
    } catch (err) {
      $("status").textContent = err instanceof Error ? err.message : "Upload failed";
    }
  });
  $("att-zip").addEventListener("click", async () => {
    const planId = site.planId;
    if (!planId) {
      $("status").textContent = "Claim this parcel to download attachments.";
      return;
    }
    try {
      await downloadAttachmentsZip(planId);
    } catch (err) {
      $("status").textContent = err instanceof Error ? err.message : "Download failed";
    }
  });
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

  $("claim-parcel").addEventListener("click", () => {
    void claimCurrentParcel(map);
  });

  $("close-siteplan").addEventListener("click", () => {
    $("siteplan-panel").hidden = true;
    $("constraint-layers").hidden = true;
    exitSitePlan(map);
    syncSiteForm();
    syncDrawUi();
    clearPlaceButtons();
    highlightParcel(map, null);
  });

  const applyView = (view: PlanView) => {
    if (site.placeMode === "use_area" && view === "packet") return;
    setView(map, view);
    syncViewToggle();
  };
  $("view-plan").addEventListener("click", () => applyView("plan"));
  $("view-packet").addEventListener("click", () => applyView("packet"));

  const setback = $<HTMLInputElement>("site-setback");
  const accessory = $<HTMLInputElement>("site-accessory");
  const width = $<HTMLInputElement>("site-width");
  const length = $<HTMLInputElement>("site-length");
  const rot = $<HTMLInputElement>("site-rot");
  const eave = $<HTMLInputElement>("site-eave");
  const existing = $<HTMLInputElement>("site-existing");

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
  const readSize = () => {
    site.widthFt = Number(width.value) || 40;
    site.lengthFt = Number(length.value) || 60;
    site.rotationDeg = Number(rot.value) || 0;
    const eaveN = Number(eave.value);
    site.eaveFt = Number.isFinite(eaveN) && eaveN >= 0 ? eaveN : DEFAULT_EAVE_FT;
  };
  const syncSize = () => {
    readSize();
    updateSelected({
      widthFt: site.widthFt,
      lengthFt: site.lengthFt,
      rotationDeg: site.rotationDeg,
      eaveFt: site.eaveFt,
    });
    refreshOverlays(map);
    renderDistances();
  };
  width.addEventListener("input", readSize);
  length.addEventListener("input", readSize);
  rot.addEventListener("input", readSize);
  eave.addEventListener("input", readSize);
  width.addEventListener("change", syncSize);
  length.addEventListener("change", syncSize);
  rot.addEventListener("change", syncSize);
  eave.addEventListener("change", syncSize);
  existing.addEventListener("change", () => {
    site.status = existing.checked ? "existing" : "proposed";
    updateSelected({ status: site.status });
    refreshOverlays(map);
  });

  $("site-use").addEventListener("input", (event) => {
    site.use = (event.target as HTMLInputElement).value;
    schedulePersist();
  });
  $("site-notes").addEventListener("input", (event) => {
    site.notes = (event.target as HTMLTextAreaElement).value;
    schedulePersist();
  });

  $("site-use-class").addEventListener("change", (event) => {
    site.useClass = parseUseClass((event.target as HTMLSelectElement).value);
    if (!site.placeMode && selectedFeature()?.kind === "use_area") {
      updateSelected({ useClass: site.useClass });
      refreshOverlays(map);
    }
  });
  $("site-on-packet").addEventListener("change", (event) => {
    if (site.placeMode || selectedFeature()?.kind !== "use_area") return;
    updateSelected({ onPacket: (event.target as HTMLInputElement).checked });
    refreshOverlays(map);
  });

  const arm = (id: string, mode: SiteKind, prompt: string) => {
    $(id).addEventListener("click", () => {
      if (mode === "use_area" && site.view === "packet") applyView("plan");
      setPlaceMode(map, mode);
      for (const btn of document.querySelectorAll(".btn-row .ghost")) {
        btn.classList.toggle("active", btn.id === id);
      }
      $("status").textContent = prompt;
      syncDrawUi();
      syncViewToggle();
      syncUseAreaFields();
    });
  };
  arm("place-structure", "structure", "Tap the lot to place a structure");
  arm("place-well", "well", "Tap the lot to place the well");
  arm("place-septic", "septic", "Tap the lot to place the septic");
  arm("place-door", "front_door", "Tap the building edge to place the front door");
  arm(
    "place-driveway",
    "driveway",
    "Tap driveway vertices. May start off the lot. Finish or double-tap to complete.",
  );
  arm("place-leach", "leach", "Tap leach field vertices on the lot. Finish or double-tap to close.");
  arm("place-easement", "easement", "Tap easement vertices. Finish or double-tap to complete.");
  arm("place-use-area", "use_area", "Tap use-area vertices on the lot. Finish or double-tap to close.");

  $("finish-draw").addEventListener("click", () => {
    const kind = site.placeMode;
    const feature = finishDrawing(map);
    syncDrawUi();
    syncSiteForm();
    renderDistances();
    if (feature) {
      clearPlaceButtons();
      const warn = wellSepticAdvisory()[0];
      $("status").textContent = warn ?? `${feature.label} drawn`;
      return;
    }
    if (isDrawKind(kind)) {
      $("status").textContent =
        kind === "driveway" ? "Need at least two vertices" : "Need at least three vertices to close";
    }
  });

  $("print-letter").addEventListener("change", () => {
    document.documentElement.classList.toggle("print-letter", $<HTMLInputElement>("print-letter").checked);
  });
  $("print-hint").textContent = PRINT_IOS_HINT;
  let printRestoreView: PlanView | null = null;
  $("print-sitemap").addEventListener("click", () => {
    printRestoreView = site.view;
    site.view = "packet";
    refreshOverlays(map);
    syncViewToggle();
    fillPrintBlock(map);
    map.resize();
    window.setTimeout(() => window.print(), 250);
  });
  window.addEventListener("afterprint", () => {
    if (!printRestoreView) return;
    site.view = printRestoreView;
    printRestoreView = null;
    if (!site.active) return;
    refreshOverlays(map);
    syncViewToggle();
  });

  window.addEventListener("keydown", (event) => {
    if (!site.active) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      const tag = (event.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }
      removeSelected();
      refreshOverlays(map);
      renderDistances();
      syncSiteForm();
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
        showParcel(map, {
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

function applyConstraintToggles(map: MapLibreMap) {
  for (const [key, layerIds] of Object.entries(CONSTRAINT_TOGGLES)) {
    const input = document.getElementById(`layer-${key}`) as HTMLInputElement | null;
    const on = input?.checked ?? true;
    for (const id of layerIds) setLayerVisible(map, id, on);
  }
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
  for (const [key, layerIds] of Object.entries(CONSTRAINT_TOGGLES)) {
    $(`layer-${key}`).addEventListener("change", (event) => {
      const on = (event.target as HTMLInputElement).checked;
      for (const id of layerIds) setLayerVisible(map, id, on);
    });
  }
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

function isStandalonePwa(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function renderAuth(user: Me | null) {
  $("signin-btn").hidden = Boolean(user);
  $("signed-in").hidden = !user;
  $("auth-panel").hidden = true;
  if (user) $("signed-email").textContent = user.email;
}

async function refreshSession() {
  const user = await me();
  currentUser = user;
  renderAuth(user);
  if (sessionStorage.getItem("loginOk")) sessionStorage.removeItem("loginOk");
  if (sessionStorage.getItem("loginError")) {
    sessionStorage.removeItem("loginError");
    if (!user) {
      $("auth-panel").hidden = false;
      $("auth-status").textContent = "That sign-in link is invalid or already used.";
    }
  }
  if (user) {
    void flushPersist()
      .then(() => pullPlans())
      .catch(() => undefined);
  }
}

function bindAuthChrome() {
  const panel = $("auth-panel");
  const status = $("auth-status");
  const emailInput = $<HTMLInputElement>("auth-email");
  const codeInput = $<HTMLInputElement>("auth-code");
  const sendBtn = $<HTMLButtonElement>("auth-send");
  const verifyBtn = $<HTMLButtonElement>("auth-verify");
  const linkWrap = $("auth-link-wrap");
  const standalone = isStandalonePwa();
  if (!standalone) linkWrap.hidden = false;

  const includeLink = () =>
    !standalone && $<HTMLInputElement>("auth-include-link").checked;

  $("signin-btn").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });
  $("close-auth").addEventListener("click", () => {
    panel.hidden = true;
  });

  async function sendCode() {
    const email = emailInput.value.trim();
    if (!email) {
      status.textContent = "Enter your email.";
      return;
    }
    sendBtn.disabled = true;
    status.textContent = "Sending code…";
    try {
      await requestOtp(email, includeLink() || undefined);
      status.textContent = "Code sent. Check email and type it here.";
      codeInput.focus();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Could not send code.";
    } finally {
      sendBtn.disabled = false;
    }
  }

  async function doVerify() {
    const email = emailInput.value.trim();
    const code = codeInput.value.trim();
    if (!email || !code) {
      status.textContent = "Email and code required.";
      return;
    }
    verifyBtn.disabled = true;
    status.textContent = "Verifying…";
    try {
      await verifyOtp(email, code);
      status.textContent = "";
      await refreshSession();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Could not verify.";
    } finally {
      verifyBtn.disabled = false;
    }
  }

  $("auth-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (codeInput.value.trim()) void doVerify();
    else void sendCode();
  });
  sendBtn.addEventListener("click", () => void sendCode());
  verifyBtn.addEventListener("click", () => void doVerify());

  $("signout-btn").addEventListener("click", async () => {
    await logout();
    currentUser = null;
    renderAuth(null);
  });
}

async function boot() {
  stripLoginQuery();
  const map = createMap($("map"));
  siteMap = map;
  setPlanStoreHooks({
    onStatus(msg) {
      $("status").textContent = msg;
    },
    onConflict: bindSyncConflict(),
    onReplace: applyRemotePlan,
    onAck: ackServerRev,
    onBound: bindClaimed,
    onDropped: dropClaimed,
    peekAnonDraft,
    onUnauthorized() {
      currentUser = null;
      renderAuth(null);
      promptSignIn("Sign in again to sync.");
    },
  });
  bindAuthChrome();
  bindAttachments();
  void refreshSession();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentUser) {
      void flushPersist()
        .then(() => pullPlans())
        .catch(() => undefined);
    }
  });
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
      if (site.active) {
        const placing = site.placeMode;
        const result = handleSiteClick(map, [event.lngLat.lng, event.lngLat.lat]);
        if (result) {
          if (result === "rejected") {
            $("status").textContent =
              placing === "leach"
                ? "Stay on the lot for the leach field"
                : placing === "use_area"
                  ? "Stay on the lot for the use area"
                  : placing === "front_door"
                    ? "Tap on the building edge (door must sit on the wall/eave)."
                    : "Stay on the lot";
            return;
          }
          if (site.placeMode === "front_door") return;
          if (!site.placeMode) clearPlaceButtons();
          syncDrawUi();
          syncSiteForm();
          renderDistances();
          const warn = wellSepticAdvisory()[0];
          if (isDrawKind(site.placeMode)) {
            $("status").textContent = drawPrompt();
          } else if (isDrawKind(placing)) {
            $("status").textContent = warn ?? "Drawn · print when the distances look right";
          } else if (placing === "front_door") {
            $("status").textContent = "Front door placed";
          } else if (placing) {
            $("status").textContent =
              warn ??
              (site.features.some((f) => f.kind === "structure")
                ? "Structure placed · print when the distances look right"
                : "Placed · add the structure to measure setbacks");
          } else {
            const selected = selectedFeature();
            if (selected) $("status").textContent = warn ?? `${selected.label} selected`;
          }
        }
        return;
      }
      const feat = queryParcelFeature(map, event.point);
      if (!feat) {
        hideParcel(map);
        return;
      }
      highlightParcel(map, feat.properties.pin);
      const fromIndex = findByPin(feat.properties.pin);
      showParcel(map, {
        ...feat.properties,
        o1: feat.properties.o1 || fromIndex?.o || "",
        o2: feat.properties.o2 || fromIndex?.o2 || "",
        addr: feat.properties.addr || fromIndex?.addr || "",
      });
    });

    map.on("dblclick", (event) => {
      if (!site.active) return;
      if (shouldPreventDrawZoom()) event.preventDefault();
      if (!isDrawKind(site.placeMode)) return;
      const feature = finishDrawing(map);
      syncDrawUi();
      syncSiteForm();
      renderDistances();
      if (feature) {
        clearPlaceButtons();
        const warn = wellSepticAdvisory()[0];
        $("status").textContent = warn ?? `${feature.label} drawn`;
      } else {
        $("status").textContent = drawPrompt();
      }
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
