import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { featureCollection } from "@turf/helpers";
import buffer from "@turf/buffer";
import intersect from "@turf/intersect";
import type { LayerClip } from "./constraints";
import { asPolygon, formatFeet, minDistToParcelFt, pointInParcel } from "./geo";
import {
  distanceSummary,
  drivewayMeetsRoad,
  site,
  wellSepticAdvisory,
} from "./siteplan";

export const SETBACK_BUFFER_SENTENCE =
  "Street and property-line setbacks are drawn as a single inward buffer (typical 25 ft in this zone). v1 does not split street frontage from side/rear lines.";

export const PRINT_IOS_HINT =
  "On iPhone: Print → Paper Size → Tabloid / 11×17 if you want that sheet. Letter still works; use the labeled distances.";

const BLP_URL = "https://www.bonnercountyid.gov/building-location-permit";
const FEES_URL = "https://www.bonnercountyid.gov/departments/Planning/official-fee-schedules";
const HEALTH_URL = "https://panhandlehealthdistrict.org/";
const EXTRA_USE = /\b(adu|accessory dwelling|rv|recreational vehicle|commercial|industrial)\b/i;

export type ChecklistStatus = "open" | "attached" | "na" | "external";

export interface PacketChecklistItem {
  id: string;
  label: string;
  required: boolean;
  status: ChecklistStatus;
  href?: string;
  note?: string;
}

export interface PrintFlags {
  disturbance: boolean;
  steepSlopes: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function acresLabel(value: number | string | undefined) {
  const n = Number(value);
  if (!n) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ac`;
}

function layerOpenIfIncomplete(layer: LayerClip | null | undefined, hit: boolean): ChecklistStatus {
  if (hit) return "open";
  // Incomplete clips must not auto-clear; only a complete miss may be N/A.
  if (!layer || layer.incomplete) return "open";
  return "na";
}

function incompleteNote(layer: LayerClip | null | undefined, hit: boolean) {
  if (hit) return undefined;
  if (!layer || layer.incomplete) return "verify — overlay incomplete";
  return undefined;
}

function isSfha(props: Record<string, unknown> | null | undefined) {
  const raw = String(props?.FLD_ZONE ?? props?.fld_zone ?? "")
    .toUpperCase()
    .replace(/^ZONE\s+/, "")
    .trim();
  if (!raw || raw === "X" || raw === "D" || raw.includes("NOT INCLUDED")) return false;
  return /^(A|V)/.test(raw);
}

function coordsOf(geom: Feature["geometry"] | null | undefined): Position[] {
  if (!geom) return [];
  switch (geom.type) {
    case "Point":
      return [geom.coordinates];
    case "MultiPoint":
    case "LineString":
      return geom.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geom.coordinates.flat();
    case "MultiPolygon":
      return geom.coordinates.flat(2);
    default:
      return [];
  }
}

function nearParcel(feat: Feature, geom: Polygon | MultiPolygon, ft: number) {
  const g = feat.geometry;
  if (!g) return false;
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    try {
      const buf = buffer(asPolygon(geom), ft, { units: "feet" });
      if (!buf) return false;
      const hit = intersect(featureCollection([feat as Feature<Polygon | MultiPolygon>, buf]));
      return Boolean(hit?.geometry);
    } catch {
      return false;
    }
  }
  return coordsOf(g).some((c) => pointInParcel(c, geom) || minDistToParcelFt(c, geom) <= ft);
}

function intersectsParcel(feat: Feature, geom: Polygon | MultiPolygon) {
  const g = feat.geometry;
  if (!g) return false;
  if (g.type === "Point") return pointInParcel(g.coordinates, geom);
  if (g.type === "Polygon" || g.type === "MultiPolygon") {
    try {
      const hit = intersect(featureCollection([feat as Feature<Polygon | MultiPolygon>, asPolygon(geom)]));
      return Boolean(hit?.geometry);
    } catch {
      return false;
    }
  }
  return coordsOf(g).some((c) => pointInParcel(c, geom));
}

function item(
  id: string,
  label: string,
  required: boolean,
  status: ChecklistStatus,
  extra?: Pick<PacketChecklistItem, "href" | "note">,
): PacketChecklistItem {
  return { id, label, required, status, ...extra };
}

/** Screen canvas width is not the printed map; labeled distances are the source of truth. */
export function scaleStatement(_map?: MapLibreMap) {
  return "NOT TO SCALE — use labeled distances. Assessor geometry — distances approximate, not to survey scale.";
}

function waterFeatureLabels(water: LayerClip) {
  return water.features.map((feat) => {
    const props = (feat.properties ?? {}) as Record<string, unknown>;
    const name = String(props.gnis_name || props.GNIS_NAME || "unnamed");
    const fcode = props.FCODE ?? props.fcode;
    return fcode != null && String(fcode) ? `${name} (FCODE ${fcode})` : name;
  });
}

/** Negative “no water” only after a finished, complete NHD clip. */
export function waterCaption() {
  const water = site.constraints?.water;
  if (!water || water.incomplete) {
    const names = water ? waterFeatureLabels(water) : [];
    return names.length
      ? `Water within ~300 ft (clipped NHD): ${names.join("; ")} (verify — overlay incomplete)`
      : "Water within 300 ft: verify — overlay incomplete.";
  }
  const names = waterFeatureLabels(water);
  return names.length
    ? `Water within ~300 ft (clipped NHD): ${names.join("; ")}`
    : "No clipped NHD water within 300 ft of the parcel envelope.";
}

export function buildChecklist(flags: PrintFlags): PacketChecklistItem[] {
  const p = site.parcel;
  const clip = site.constraints;
  const geom = site.geom;
  const hasAddr = Boolean(p?.addr?.trim()) && Number(p?.naddr ?? 1) > 0;
  const proposedDrive = site.features.filter((f) => f.kind === "driveway" && f.status === "proposed");
  const meetsRoad = proposedDrive.some((f) => drivewayMeetsRoad(f, clip?.roads ?? null));
  const shoreHit = Boolean(geom && clip && clip.water.features.some((f) => nearParcel(f, geom, 200)));
  const wetlandHit = Boolean(geom && clip && clip.wetlands.features.some((f) => intersectsParcel(f, geom)));
  const floodHit = Boolean(
    clip && clip.flood.features.some((f) => isSfha((f.properties ?? {}) as Record<string, unknown>)),
  );
  const healthHit = site.features.some((f) => f.kind === "well" || f.kind === "septic" || f.kind === "leach");
  const extraUse = EXTRA_USE.test(site.use);
  const cityHit = Boolean(clip && clip.cityImpact.features.length);
  const deed = p?.deed?.trim();

  return [
    item("site-plan", "Site plan per BCRC 11-105 & 11-216 (this print)", true, "open", {
      note: "Print / save PDF from this screen. Not a survey.",
    }),
    item("floor-plan", "Diagrammatic floor plan (BCRC 11-105 & 11-204) — upload PDF/JPEG/PNG/HEIC", true, "open"),
    item("elevations", "Elevation drawings (BCRC 11-105) — upload", true, "open"),
    item(
      "deed",
      deed
        ? `Deed or recorded legal description — assessor label ${deed} (attach the recorded instrument)`
        : "Deed or recorded legal description — upload",
      true,
      "open",
    ),
    item("fire", "Fire District approval (BCRC 11-110)", true, "external", {
      href: BLP_URL,
      note: "Verify sign-off on the county site; this app does not issue fire approval.",
    }),
    item("fees", "Fees (Title 11 schedule)", true, "external", {
      href: FEES_URL,
    }),
    item("easements", "All easements of record — confirm against the deed; GIS ROW is not a title report.", true, "open"),

    item(
      "address",
      "Address assignment (BCRC 13-120)",
      false,
      hasAddr ? "na" : "open",
      hasAddr ? undefined : { note: "No 911 address on this parcel." },
    ),
    item(
      "encroach",
      "Encroachment permit (Road & Bridge / IHD / ITD)",
      false,
      proposedDrive.length ? layerOpenIfIncomplete(clip?.roads, meetsRoad) : "na",
      {
        note: meetsRoad
          ? "Proposed driveway within 30 ft of a clipped road."
          : proposedDrive.length
            ? incompleteNote(clip?.roads, meetsRoad)
            : undefined,
      },
    ),
    item("erosion", "Erosion / stormwater plan (BCRC 12-720)", false, flags.disturbance ? "open" : "na", {
      note: flags.disturbance ? "Disturbance above threshold marked by owner." : undefined,
    }),
    item(
      "shore",
      "Shore Land Development Worksheet (BCRC 12-710)",
      false,
      layerOpenIfIncomplete(clip?.water, shoreHit),
      {
        note: shoreHit
          ? "Clipped NHD water within 200 ft of the parcel."
          : incompleteNote(clip?.water, shoreHit),
      },
    ),
    item(
      "wetland",
      "Wetland delineation (BCRC 12-730) — NWI is inventory, not a delineation",
      false,
      layerOpenIfIncomplete(clip?.wetlands, wetlandHit),
      {
        note: wetlandHit
          ? "Clipped NWI intersects the parcel."
          : incompleteNote(clip?.wetlands, wetlandHit),
      },
    ),
    item(
      "flood",
      "Floodplain Development Permit + stamped plans (Title 14)",
      false,
      layerOpenIfIncomplete(clip?.flood, floodHit),
      {
        note: floodHit
          ? "Clipped NFHL SFHA intersects the parcel envelope."
          : incompleteNote(clip?.flood, floodHit),
      },
    ),
    item("geotech", "Geotech (BCRC 12-760) — mapped steep slopes?", false, flags.steepSlopes ? "open" : "na", {
      note: flags.steepSlopes ? "Owner marked steep slopes on site." : undefined,
    }),
    item("health", "Panhandle Health / sewer district", false, healthHit ? "open" : "na", {
      href: healthHit ? HEALTH_URL : undefined,
      note: healthHit ? "Well, septic, or leach field is on this draft." : undefined,
    }),
    item("extra-use", "ADU / RV / commercial extra standards", false, extraUse ? "open" : "na"),
    item(
      "city",
      "Area of city impact — city standards may apply",
      false,
      layerOpenIfIncomplete(clip?.cityImpact, cityHit),
      {
        note: cityHit ? "Clipped city-impact overlay is present." : incompleteNote(clip?.cityImpact, cityHit),
      },
    ),
  ];
}

function statusLabel(status: ChecklistStatus) {
  if (status === "external") return "External";
  if (status === "na") return "Not indicated";
  if (status === "attached") return "Attached";
  return "Needed";
}

function fillDl(dl: HTMLElement, rows: [string, string][]) {
  dl.replaceChildren();
  for (const [term, value] of rows) {
    if (!value) continue;
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function fillTable(tbody: HTMLElement, compact: boolean) {
  tbody.replaceChildren();
  let rows = distanceSummary({ all: true });
  if (compact) {
    const seen = new Set<string>();
    rows = rows.filter((row) => {
      if (seen.has(row.structureId)) return false;
      seen.add(row.structureId);
      return true;
    });
  }
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "Place a structure to measure envelope distances to every outer-ring lot line.";
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      row.structureLabel,
      formatFeet(row.eaveFt),
      `${row.side} line`,
      formatFeet(row.lotFt),
      formatFeet(row.toBldgFt),
    ];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function fillList(ul: HTMLElement, items: PacketChecklistItem[]) {
  ul.replaceChildren();
  for (const row of items) {
    const li = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = `print-check-status is-${row.status}`;
    mark.textContent = statusLabel(row.status);
    const body = document.createElement("span");
    body.textContent = row.label;
    if (row.note) {
      const note = document.createElement("small");
      note.textContent = row.note;
      body.append(document.createElement("br"), note);
    }
    if (row.href) {
      const link = document.createElement("small");
      link.textContent = row.href.replace(/^https:\/\//, "");
      body.append(document.createElement("br"), link);
    }
    li.append(mark, body);
    ul.append(li);
  }
}

/** Called from fillPrintBlock() in main.ts. window.print() remains the only site-plan PDF path. */
export function renderPrintBlock(map: MapLibreMap, flags: PrintFlags) {
  const p = site.parcel;
  const when = new Date().toLocaleDateString();
  const owner = [p?.o1, p?.o2].filter(Boolean).join(" / ") || "—";
  fillDl($("print-meta") ?? document.createElement("dl"), [
    ["Owner", owner],
    ["Address", p?.addr || "—"],
    ["PIN", p?.pin || "—"],
    ["Acres", p?.acres ? acresLabel(p.acres) : "—"],
    ["Zoning", site.zoning || "—"],
    ["Use", site.use || "—"],
    ["Setback used", `${site.lineFt} ft`],
    ["Date", when],
  ]);

  const scale = $("print-scale");
  if (scale) scale.textContent = scaleStatement(map);

  const setback = $("print-setback-note");
  if (setback) setback.textContent = SETBACK_BUFFER_SENTENCE;

  const compact = $("print-measures");
  if (compact) fillTable(compact, true);
  const all = $("print-measures-all");
  if (all) fillTable(all, false);
  const tableNote = $("print-measures-note");
  if (tableNote) {
    tableNote.textContent = distanceSummary({ all: true }).length
      ? "Closest lot line per structure. Every outer-ring edge is on the checklist page."
      : "";
  }

  const advisories = $("print-advisories");
  if (advisories) {
    advisories.textContent = [
      ...wellSepticAdvisory(),
      "Architectural projections cannot enter the setback.",
    ].join(" ");
  }

  const water = $("print-water");
  if (water) water.textContent = waterCaption();

  const notes = $("print-notes");
  if (notes) notes.textContent = site.notes ? `Notes: ${site.notes}` : "";

  const checklist = buildChecklist(flags);
  const always = $("print-check-always");
  const often = $("print-check-often");
  if (always) fillList(always, checklist.filter((row) => row.required));
  if (often) fillList(often, checklist.filter((row) => !row.required));
}
