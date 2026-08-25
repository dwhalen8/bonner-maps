import type { Geometry, MultiPolygon, Polygon } from "geojson";

export const PLAN_DOC_VERSION = 1 as const;

export interface ParcelSnapshot {
  pin: string;
  o1: string;
  o2: string;
  acres: number;
  cls: string;
  value: number;
  tax: string;
  deed: string;
  land: string;
  addr?: string;
  addrs?: string;
  naddr?: number;
}

export type FeatureStatus = "existing" | "proposed";
export type FeatureKind =
  | "structure"
  | "well"
  | "septic"
  | "leach"
  | "driveway"
  | "easement"
  | "water"
  | "wetland"
  | "use_area"
  | "note"
  | "front_door";

export type UseAreaClass =
  | "garden"
  | "pasture"
  | "timber"
  | "shop_yard"
  | "orchard"
  | "other";

export interface PlanFeature {
  id: string;
  kind: FeatureKind;
  status: FeatureStatus;
  label: string;
  geom: Geometry;
  onPacket: boolean;
  props: {
    widthFt?: number;
    lengthFt?: number;
    rotationDeg?: number;
    eaveFt?: number;
    useClass?: UseAreaClass;
    source?: "user" | "county" | "fema" | "nwi" | "nhd";
    notes?: string;
  };
}

export interface PlanDoc {
  version: typeof PLAN_DOC_VERSION;
  pin: string;
  title: string;
  use: string;
  notes: string;
  lineFt: number;
  accessory: boolean;
  parcel: {
    props: ParcelSnapshot;
    geom: Polygon | MultiPolygon;
    snapshotAt: string;
  };
  features: PlanFeature[];
  constraints: null;
  checklist: [];
  clientEditedAt?: string;
}

export function toParcelSnapshot(fields: ParcelSnapshot): ParcelSnapshot {
  return {
    pin: fields.pin,
    o1: fields.o1,
    o2: fields.o2,
    acres: fields.acres,
    cls: fields.cls,
    value: fields.value,
    tax: fields.tax,
    deed: fields.deed,
    land: fields.land,
    addr: fields.addr,
    addrs: fields.addrs,
    naddr: fields.naddr,
  };
}
