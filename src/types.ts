export type LandKind =
  | "private"
  | "usfs"
  | "blm"
  | "fws"
  | "us"
  | "idfg"
  | "parks"
  | "itd"
  | "idl"
  | "county"
  | "city";

export interface ParcelProps {
  pin: string;
  o1: string;
  o2: string;
  acres: number;
  cls: string;
  value: number;
  tax: string;
  deed: string;
  land: LandKind;
  addr?: string;
  addrs?: string;
  naddr?: number;
}

export interface SearchHit {
  pin: string;
  o: string;
  o2: string;
  a: number;
  k: LandKind;
  lng: number | null;
  lat: number | null;
  addr?: string;
}

export interface DataMeta {
  fetchedAt: string;
  source: string;
  count: number;
  addresses?: number;
  addressesMatched?: number;
  land: Record<string, number>;
  disclaimer: string;
}

export const LAND_LABELS: Record<LandKind, string> = {
  private: "Private",
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
};

export const COUNTY_BOUNDS: [[number, number], [number, number]] = [
  [-117.05, 47.88],
  [-116.04, 48.86],
];

export const COUNTY_CENTER: [number, number] = [-116.55, 48.28];
