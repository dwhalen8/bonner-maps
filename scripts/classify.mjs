/** Shared owner classifier used by the data pipeline. */

const PUBLIC_RULES = [
  { key: "usfs", re: /\bU\s*S\s+FOREST SERVICE\b|\bUSDA FOREST\b|\bNATIONAL FOREST\b/ },
  { key: "blm", re: /\bBUREAU OF LAND\b|\b\bBLM\b/ },
  { key: "fws", re: /\bFISH AND WILDLIFE\b|\bU\s*S\s+FWS\b|\bUSFWS\b/ },
  { key: "us", re: /\bUNITED STATES GOVERNMENT\b|\bUNITED STATES OF AMERICA\b|\bU\s*S\s+GOVERNMENT\b|\bUSA\b/ },
  { key: "idfg", re: /\bFISH AND GAME\b|\bIDFG\b|\bDEPT(ARTMENT)? OF FISH\b/ },
  { key: "parks", re: /\bDEPT(ARTMENT)? OF PARKS\b|\bIDAHO STATE PARKS\b|\bSTATE PARKS AND RECREATION\b/ },
  { key: "itd", re: /\bTRANSPORTATION DEPT\b|\bDEPT OF TRANSPORTATION\b|\bDIVISION OF HWYS\b|\bIDAHO TRANSPORTATION\b/ },
  { key: "idl", re: /\bSTATE OF IDAHO\b|\bDEPARTMENT OF LANDS\b|\bIDAHO DEPT OF LANDS\b/ },
  { key: "county", re: /\bBONNER COUNTY\b/ },
  { key: "city", re: /\bCITY OF / },
];

export const LAND_LABELS = {
  usfs: "U.S. Forest Service",
  blm: "BLM",
  fws: "U.S. Fish & Wildlife",
  us: "Federal",
  idfg: "Idaho Fish & Game",
  parks: "State Parks",
  itd: "Idaho Transportation",
  idl: "Idaho Dept. of Lands",
  county: "Bonner County",
  city: "City",
  private: "Private",
};

export function classifyOwner(owner1 = "", owner2 = "") {
  const text = `${owner1} ${owner2}`.replace(/\s+/g, " ").trim().toUpperCase();
  for (const rule of PUBLIC_RULES) {
    if (rule.re.test(text)) return rule.key;
  }
  return "private";
}

export function isPublic(kind) {
  return kind !== "private";
}
