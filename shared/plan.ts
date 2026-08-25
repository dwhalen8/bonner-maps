import { z } from "zod";

export const PLAN_DOC_VERSION = 1 as const;

export const ParcelSnapshotSchema = z.object({
  pin: z.string(),
  o1: z.string(),
  o2: z.string(),
  acres: z.number(),
  cls: z.string(),
  value: z.number(),
  tax: z.string(),
  deed: z.string(),
  land: z.string(),
  addr: z.string().optional(),
  addrs: z.string().optional(),
  naddr: z.number().optional(),
});
export type ParcelSnapshot = z.infer<typeof ParcelSnapshotSchema>;

export const FeatureStatusSchema = z.enum(["existing", "proposed"]);
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

export const FeatureKindSchema = z.enum([
  "structure",
  "well",
  "septic",
  "leach",
  "driveway",
  "easement",
  "water",
  "wetland",
  "use_area",
  "note",
  "front_door",
]);
export type FeatureKind = z.infer<typeof FeatureKindSchema>;

export const UseAreaClassSchema = z.enum([
  "garden",
  "pasture",
  "timber",
  "shop_yard",
  "orchard",
  "other",
]);
export type UseAreaClass = z.infer<typeof UseAreaClassSchema>;

const PositionSchema = z.array(z.number()).min(2);

const PointSchema = z.object({
  type: z.literal("Point"),
  coordinates: PositionSchema,
  bbox: z.array(z.number()).optional(),
});

const MultiPointSchema = z.object({
  type: z.literal("MultiPoint"),
  coordinates: z.array(PositionSchema),
  bbox: z.array(z.number()).optional(),
});

const LineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(PositionSchema).min(2),
  bbox: z.array(z.number()).optional(),
});

const MultiLineStringSchema = z.object({
  type: z.literal("MultiLineString"),
  coordinates: z.array(z.array(PositionSchema)),
  bbox: z.array(z.number()).optional(),
});

const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(PositionSchema)),
  bbox: z.array(z.number()).optional(),
});

const MultiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(z.array(PositionSchema))),
  bbox: z.array(z.number()).optional(),
});

export const GeometrySchema = z.discriminatedUnion("type", [
  PointSchema,
  MultiPointSchema,
  LineStringSchema,
  MultiLineStringSchema,
  PolygonSchema,
  MultiPolygonSchema,
]);

export const PolygonOrMultiSchema = z.discriminatedUnion("type", [
  PolygonSchema,
  MultiPolygonSchema,
]);

export const GeoJsonFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.union([z.string(), z.number()]).optional(),
  geometry: GeometrySchema.nullable(),
  properties: z.record(z.string(), z.unknown()).nullable(),
});

export const PlanFeatureSchema = z.object({
  id: z.string(),
  kind: FeatureKindSchema,
  status: FeatureStatusSchema,
  label: z.string(),
  geom: GeometrySchema,
  onPacket: z.boolean(),
  props: z.object({
    widthFt: z.number().optional(),
    lengthFt: z.number().optional(),
    rotationDeg: z.number().optional(),
    eaveFt: z.number().optional(),
    useClass: UseAreaClassSchema.optional(),
    source: z.enum(["user", "county", "fema", "nwi", "nhd"]).optional(),
    notes: z.string().optional(),
  }),
});
export type PlanFeature = z.infer<typeof PlanFeatureSchema>;

export const TruncatedReasonSchema = z.enum([
  "feature_cap",
  "byte_cap",
  "timeout",
  "cors",
  "too_large_source",
]);

export const LayerClipSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(GeoJsonFeatureSchema),
  incomplete: z.boolean(),
  fetchedAt: z.string(),
  truncatedReason: TruncatedReasonSchema.optional(),
});
export type LayerClip = z.infer<typeof LayerClipSchema>;

export const ConstraintClipSchema = z.object({
  zoning: z.object({
    zonedesc: z.string().nullable(),
    fetchedAt: z.string(),
  }),
  roads: LayerClipSchema,
  drivewaysCounty: LayerClipSchema,
  row: LayerClipSchema,
  flood: LayerClipSchema,
  wetlands: LayerClipSchema,
  water: LayerClipSchema,
  cityImpact: LayerClipSchema,
});
export type ConstraintClip = z.infer<typeof ConstraintClipSchema>;

export const PacketChecklistItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  required: z.boolean(),
  status: z.enum(["open", "attached", "na", "external"]),
  attachmentId: z.string().optional(),
  href: z.string().optional(),
});
export type PacketChecklistItem = z.infer<typeof PacketChecklistItemSchema>;

export const PlanDocSchema = z.object({
  version: z.literal(PLAN_DOC_VERSION),
  pin: z.string(),
  title: z.string(),
  use: z.string(),
  notes: z.string(),
  lineFt: z.number(),
  accessory: z.boolean(),
  parcel: z.object({
    props: ParcelSnapshotSchema,
    geom: PolygonOrMultiSchema,
    snapshotAt: z.string(),
  }),
  features: z.array(PlanFeatureSchema),
  constraints: ConstraintClipSchema.nullable(),
  checklist: z.array(PacketChecklistItemSchema),
  clientEditedAt: z.string().optional(),
});
export type PlanDoc = z.infer<typeof PlanDocSchema>;

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
