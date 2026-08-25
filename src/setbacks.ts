/** Bonner County Revised Code Tables 12-411 and 12-412, typical residential figures. */

export interface SetbackRule {
  zone: string;
  streetFt: number;
  lineFt: number;
  accessoryFt: number;
  source: string;
}

const RULES: { match: RegExp; rule: Omit<SetbackRule, "zone"> }[] = [
  {
    match: /rural 5|r-5/i,
    rule: { streetFt: 25, lineFt: 25, accessoryFt: 5, source: "BCRC 12-411 / 12-412" },
  },
  {
    match: /rural 10|r-10/i,
    rule: { streetFt: 25, lineFt: 25, accessoryFt: 5, source: "BCRC 12-411" },
  },
  {
    match: /a\/f|agricultural|forestry 10|forestry 20|forest 40/i,
    rule: {
      streetFt: 25,
      lineFt: 25,
      accessoryFt: 5,
      source: "BCRC 12-411 residential 25 ft; ag/nonresidential buildings are often 40 ft",
    },
  },
  {
    match: /suburban|\(s\)/i,
    rule: { streetFt: 25, lineFt: 25, accessoryFt: 5, source: "BCRC 12-412 Suburban" },
  },
  {
    match: /recreation|alpine village/i,
    rule: { streetFt: 25, lineFt: 25, accessoryFt: 5, source: "BCRC 12-412" },
  },
  {
    match: /commercial|industrial|rural service/i,
    rule: { streetFt: 25, lineFt: 25, accessoryFt: 5, source: "BCRC 12-412" },
  },
];

export const DEFAULT_SETBACK: SetbackRule = {
  zone: "Unknown / verify",
  streetFt: 25,
  lineFt: 25,
  accessoryFt: 5,
  source: "Typical BCRC 25 ft property-line setback — confirm for this zone",
};

export function ruleForZone(zonedesc: string | null | undefined): SetbackRule {
  if (!zonedesc) return { ...DEFAULT_SETBACK };
  for (const row of RULES) {
    if (row.match.test(zonedesc)) return { zone: zonedesc, ...row.rule };
  }
  return { ...DEFAULT_SETBACK, zone: zonedesc };
}

const ZONING_URL =
  "https://cloudgis.bonnercountyid.gov/server/rest/services/Map_Services/ZoningLanduse_Public/MapServer/2/query";

export async function fetchZoningAt(lng: number, lat: number): Promise<string | null> {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "zonedesc",
    returnGeometry: "false",
    f: "json",
  });
  const res = await fetch(`${ZONING_URL}?${params}`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    features?: { attributes?: { zonedesc?: string } }[];
  };
  return data.features?.[0]?.attributes?.zonedesc ?? null;
}

/** BCRC 12-711: 40 ft from lakes/ponds and intermittent NHD; 75 ft from other flowing streams. */
export const SHORELINE_WATERBODY_FT = 40;
export const SHORELINE_STREAM_FT = 75;
/** Historical Title 12 figure — advisory only; verify with Planning. */
export const WETLAND_ADVISORY_FT = 40;

/** NHD FCodes treated as intermittent / ephemeral (layer 6). */
export const INTERMITTENT_FLOWLINE_FCODES = new Set([
  46003, // StreamRiver Intermittent
  46007, // StreamRiver Ephemeral
]);

export function nhdFcode(props: Record<string, unknown> | null | undefined): number | null {
  if (!props) return null;
  const raw = props.FCODE ?? props.fcode ?? props.FCode;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function shorelineSetbackFt(nhdLayer: number, props?: Record<string, unknown> | null): number {
  if (nhdLayer === 12) return SHORELINE_WATERBODY_FT;
  const code = nhdFcode(props);
  if (code != null && INTERMITTENT_FLOWLINE_FCODES.has(code)) return SHORELINE_WATERBODY_FT;
  return SHORELINE_STREAM_FT;
}
