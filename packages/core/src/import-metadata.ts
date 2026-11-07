import { z } from "zod";
import type { Building, Place, Project } from "./index";
import { projectWithWorkforceVersion } from "./workforce-scenario";
export const BUILDING_QUANTITY_FIELDS = [
  "height",
  "floors",
  "units",
  "jobs",
  "parkingSpaces",
] as const;
export type BuildingQuantityField = (typeof BUILDING_QUANTITY_FIELDS)[number];
export type KnownBuilding = Building & Record<BuildingQuantityField, number>;
export interface AttributeEvidence {
  status: "supplied" | "derived" | "assumed" | "missing";
  sourceId: string;
  sourceField?: string;
  sourceUnit?: string;
  rawValue?: string | number | boolean | null;
  method?: string;
}
export interface BuildingAttributeProvenance {
  version: 1;
  fields: Partial<Record<BuildingQuantityField, AttributeEvidence>>;
  use?: AttributeEvidence;
}
export interface SourceRights {
  version: 1;
  privateUse: boolean;
  cache: boolean;
  analyze: boolean;
  privateDisplay: boolean;
  export: boolean;
  historicalRetention: boolean;
  publicRedistribution: boolean;
  declaredBy: string;
  declaredAt: string;
}
export type ImportRecipeValue =
  | null
  | boolean
  | number
  | string
  | ImportRecipeValue[]
  | { [key: string]: ImportRecipeValue };
export interface SourceImportMetadata {
  version: 1;
  format: "geojson" | "shapefile" | "dxf";
  upload: {
    name: string;
    sha256: string;
    bytes: number;
    members: { name: string; sha256: string; bytes: number }[];
  };
  selection: { layer: string; entityIds?: string[] };
  crs: {
    source: string;
    sourceWkt?: string;
    axisOrder: "xy" | "authority";
    coordinateUnit?: string;
    target: "OGC:CRS84";
  };
  operation: {
    name: string;
    pipeline?: string;
    accuracyMeters: number | null;
    grids?: { name: string; sha256: string }[];
  };
  converter: {
    name: string;
    version: string;
    projVersion?: string;
    imageDigest?: string;
  };
  normalizedSha256: string;
  recipe: ImportRecipeValue;
  exclusions: { count: number; reason: string }[];
}
const text = z.string().min(1).max(240),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  bytes = z
    .number()
    .int()
    .nonnegative()
    .max(1024 ** 3);
const fileName = text.refine(
  (v) =>
    !v.startsWith("/") &&
    !v.includes("\\") &&
    !v.split("/").some((p) => p === ".." || p === "." || !p) &&
    !v.includes("\0") &&
    !/^[a-z]:/i.test(v),
  "Use a relative archive member name, never a private absolute path.",
);
export const attributeEvidenceSchema: z.ZodType<AttributeEvidence> = z
  .object({
    status: z.enum(["supplied", "derived", "assumed", "missing"]),
    sourceId: text,
    sourceField: z.string().max(240).optional(),
    sourceUnit: z.string().max(100).optional(),
    rawValue: z
      .union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])
      .optional(),
    method: z.string().max(2000).optional(),
  })
  .strict();
export const buildingAttributeProvenanceSchema: z.ZodType<BuildingAttributeProvenance> =
  z
    .object({
      version: z.literal(1),
      fields: z
        .object(
          Object.fromEntries(
            BUILDING_QUANTITY_FIELDS.map((k) => [
              k,
              attributeEvidenceSchema.optional(),
            ]),
          ),
        )
        .strict(),
      use: attributeEvidenceSchema
        .refine(
          (v) => v.status !== "missing",
          "Land use requires an explicit mapped or reviewed choice.",
        )
        .optional(),
    })
    .strict();
export const sourceRightsSchema: z.ZodType<SourceRights> = z
  .object({
    version: z.literal(1),
    privateUse: z.boolean(),
    cache: z.boolean(),
    analyze: z.boolean(),
    privateDisplay: z.boolean(),
    export: z.boolean(),
    historicalRetention: z.boolean(),
    publicRedistribution: z.boolean(),
    declaredBy: text,
    declaredAt: z.string().datetime({ offset: true }),
  })
  .strict();
function recipeValid(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > 12 || ++budget.nodes > 20000) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4000;
  if (Array.isArray(value))
    return (
      value.length <= 5000 &&
      value.every((v) => recipeValid(v, depth + 1, budget))
    );
  return (
    !!value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.entries(value).every(
      ([k, v]) =>
        k.length <= 240 &&
        !["__proto__", "prototype", "constructor"].includes(k) &&
        recipeValid(v, depth + 1, budget),
    )
  );
}
export const sourceImportMetadataSchema: z.ZodType<SourceImportMetadata> = z
  .object({
    version: z.literal(1),
    format: z.enum(["geojson", "shapefile", "dxf"]),
    upload: z
      .object({
        name: fileName,
        sha256: hash,
        bytes,
        members: z
          .array(z.object({ name: fileName, sha256: hash, bytes }).strict())
          .max(100),
      })
      .strict(),
    selection: z
      .object({
        layer: text,
        entityIds: z.array(z.string().max(240)).max(5000).optional(),
      })
      .strict(),
    crs: z
      .object({
        source: z.string().min(1).max(16000),
        sourceWkt: z.string().max(32000).optional(),
        axisOrder: z.enum(["xy", "authority"]),
        coordinateUnit: z.string().max(100).optional(),
        target: z.literal("OGC:CRS84"),
      })
      .strict(),
    operation: z
      .object({
        name: z.string().min(1).max(2000),
        pipeline: z.string().max(32000).optional(),
        accuracyMeters: z.number().finite().nonnegative().nullable(),
        grids: z
          .array(z.object({ name: fileName, sha256: hash }).strict())
          .max(100)
          .optional(),
      })
      .strict(),
    converter: z
      .object({
        name: text,
        version: text,
        projVersion: text.optional(),
        imageDigest: z
          .string()
          .regex(/^(?:sha256:)?[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    normalizedSha256: hash,
    recipe: z
      .json()
      .refine(
        recipeValid,
        "Import recipes must be bounded declarative JSON without executable content.",
      ),
    exclusions: z
      .array(
        z
          .object({
            count: z.number().int().nonnegative().max(1e7),
            reason: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((v, c) => {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 256 * 1024)
      c.addIssue({
        code: "custom",
        message: "Import provenance exceeds 256 KiB.",
      });
    if (
      new Set(v.upload.members.map((m) => m.name)).size !==
      v.upload.members.length
    )
      c.addIssue({
        code: "custom",
        message: "Archive member names must be unique.",
      });
  });
export function assertBuildingAttributeProvenance(building: Building): void {
  if (building.attributeProvenance)
    buildingAttributeProvenanceSchema.parse(building.attributeProvenance);
  for (const field of BUILDING_QUANTITY_FIELDS) {
    const evidence = building.attributeProvenance?.fields[field];
    if (building[field] === null && evidence?.status !== "missing")
      throw new Error(
        `Unknown ${field} requires explicit missing attribute provenance.`,
      );
    if (building[field] !== null && evidence?.status === "missing")
      throw new Error(`Known ${field} cannot carry missing provenance.`);
  }
}
export function hasImportExtensions(building: Building): boolean {
  return (
    building.attributeProvenance !== undefined ||
    BUILDING_QUANTITY_FIELDS.some((k) => building[k] === null)
  );
}
export function projectHasImportExtensions(
  project: Project,
  place?: Place,
): boolean {
  const entries = [...project.history, ...project.undone],
    scenarios = [
      ...project.scenarios,
      ...entries.flatMap((e) => [e.before, e.after]),
    ];
  return (
    (place?.buildings.some(hasImportExtensions) ?? false) ||
    (place?.sources.some(
      (s) => s.import !== undefined || s.rights !== undefined,
    ) ??
      false) ||
    scenarios.some(
      (s) =>
        Object.values(s.buildingEdits).some(
          (b) => b !== null && hasImportExtensions(b),
        ) ||
        (s.sources ?? []).some(
          (s) => s.import !== undefined || s.rights !== undefined,
        ),
    ) ||
    entries.some((e) => {
      const c = e.command;
      if (
        (c.type === "buildings.import" || c.type === "parcels.import") &&
        c.mode !== undefined
      )
        return true;
      if (c.type === "building.upsert" && hasImportExtensions(c.building))
        return true;
      if (
        c.type === "buildings.import" &&
        c.buildings.some(hasImportExtensions)
      )
        return true;
      const sources =
        "sources" in c
          ? (c.sources ?? [])
          : "source" in c && c.source
            ? [c.source]
            : [];
      return sources.some(
        (s) => s.import !== undefined || s.rights !== undefined,
      );
    })
  );
}
export function projectWithImportVersion(
  project: Project,
  place?: Place,
): Project {
  const p = projectWithWorkforceVersion(project, place);
  return p.schemaVersion >= 8 || !projectHasImportExtensions(p, place)
    ? p
    : { ...p, schemaVersion: 8 };
}
