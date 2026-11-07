import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BUILDING_QUANTITY_FIELDS,
  baselineIdentity,
  buildingGeometry,
  canonicalJSON,
  geometryIntersectionAreaSqm,
  landUseLabels,
  materializeBuildings,
  materializeParcels,
  studyAreaBounds,
  validateBuildingGeometry,
  validateParcelGeometry,
  validateParcelCommand,
  type AttributeEvidence,
  type Building,
  type BuildingQuantityField,
  type ImportRecipeValue,
  type LandUse,
  type Parcel,
  type Place,
  type Scenario,
  type Source,
  type StudyAreaGeometry,
} from "@urban/core";
import { ApiError } from "./errors.js";
import { buildingSchema, parcelSchema, sourceSchema } from "./validation.js";
import {
  importedProgram,
  validateImportExtent,
  validateParcelImportExtent,
} from "./imports.js";
import {
  gisRecipeSchema,
  GIS_LIMITS,
  type GisNormalized,
} from "./gis-types.js";
import type {
  GisPreview,
  GisPreviewRequest,
  ImportMappingRecipe,
  ImportNumberMapping,
  ImportTextMapping,
} from "./gis-jobs-types.js";

const field = z
  .string()
  .min(1)
  .max(240)
  .refine((v) => !["__proto__", "prototype", "constructor"].includes(v));
const use = z.enum(Object.keys(landUseLabels) as [LandUse, ...LandUse[]]);
const unit = z.enum(["meters", "feet", "us-survey-feet"]);
const textMapping = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), field }).strict(),
  z
    .object({ kind: z.literal("constant"), value: z.string().min(1).max(240) })
    .strict(),
]);
const numberMapping = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("field"),
      field,
      unit: unit.optional(),
      decimal: z.enum(["dot", "comma"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("constant"),
      value: z.number().finite().nonnegative(),
      unit: unit.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("missing") }).strict(),
]);
export const importMappingSchema = z
  .object({
    layer: z.enum(["buildings", "parcels", "blocks"]),
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("append") }).strict(),
      z
        .object({
          mode: z.literal("match"),
          field,
          by: z.enum(["id", "sourceFeatureId"]),
          sourceId: z.string().min(1).max(240).optional(),
        })
        .strict(),
    ]),
    name: textMapping.optional(),
    sourceFeatureId: textMapping.optional(),
    use: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("constant"), value: use }).strict(),
        z
          .object({
            kind: z.literal("field"),
            field,
            values: z
              .record(z.string().max(240), use)
              .refine((v) => Object.keys(v).length <= 256),
          })
          .strict(),
      ])
      .optional(),
    quantities: z
      .object({
        height: numberMapping.optional(),
        floors: numberMapping.optional(),
        units: numberMapping.optional(),
        jobs: numberMapping.optional(),
        parkingSpaces: numberMapping.optional(),
      })
      .strict()
      .optional(),
    programField: field.optional(),
    typologyField: field.optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.layer === "buildings" && !v.use)
      c.addIssue({
        code: "custom",
        path: ["use"],
        message: "Map building use or choose an explicit reviewed use.",
      });
    if (
      v.layer !== "buildings" &&
      (v.use || v.quantities || v.programField || v.typologyField)
    )
      c.addIssue({
        code: "custom",
        message: "Building attributes cannot be mapped onto parcels or blocks.",
      });
    if (
      v.target.mode === "match" &&
      v.target.by === "sourceFeatureId" &&
      !v.target.sourceId
    )
      c.addIssue({
        code: "custom",
        path: ["target", "sourceId"],
        message:
          "Choose the existing source namespace for source-reference matching.",
      });
    for (const [key, value] of Object.entries(v.quantities ?? {}))
      if (key !== "height" && value?.kind !== "missing" && value?.unit)
        c.addIssue({
          code: "custom",
          path: ["quantities", key, "unit"],
          message: "Linear units apply only to height.",
        });
  });
export const gisSubmissionSchema = z
  .object({
    scenarioId: z.string().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(160),
  })
  .strict();
export const gisPreviewRequestSchema = gisSubmissionSchema
  .extend({
    conversion: gisRecipeSchema,
    mapping: importMappingSchema,
    source: z
      .object({
        name: z.string().trim().min(1).max(240),
        url: z
          .string()
          .max(2000)
          .refine((v) => !v || /^https?:\/\//i.test(v))
          .optional(),
        vintage: z.string().trim().max(100).optional(),
        license: z.string().trim().min(1).max(2000),
        privateUseConfirmed: z.literal(true),
        publicRedistribution: z.boolean(),
      })
      .strict(),
  })
  .strict();
type Feature = GisNormalized["geojson"]["features"][number];
const fail = (index: number, message: string): never => {
  throw new ApiError(
    422,
    "GIS_MAPPING_INVALID",
    `Feature ${index + 1}: ${message}`,
  );
};
function raw(feature: Feature, key: string): unknown {
  if (key === "$featureId") return feature.id;
  return feature.properties && Object.hasOwn(feature.properties, key)
    ? feature.properties[key]
    : undefined;
}
function scalar(
  value: unknown,
  index: number,
  label: string,
): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number")
    return fail(index, `${label} must be text or a number.`);
  const text = String(value).trim();
  if (!text) return undefined;
  if (text.length > 240) return fail(index, `${label} exceeds 240 characters.`);
  return text;
}
function mappedText(
  feature: Feature,
  mapping: ImportTextMapping | undefined,
  index: number,
  label: string,
) {
  return mapping
    ? scalar(
        mapping.kind === "constant"
          ? mapping.value
          : raw(feature, mapping.field),
        index,
        label,
      )
    : undefined;
}
function quantity(
  feature: Feature,
  mapping: ImportNumberMapping | undefined,
  key: BuildingQuantityField,
  index: number,
  sourceId: string,
): { value: number | null; evidence: AttributeEvidence } {
  const input =
    mapping?.kind === "field"
      ? raw(feature, mapping.field)
      : mapping?.kind === "constant"
        ? mapping.value
        : undefined;
  const sourceField = mapping?.kind === "field" ? mapping.field : undefined;
  const sourceUnit =
    mapping && mapping.kind !== "missing" ? mapping.unit : undefined;
  const missing =
    input === undefined ||
    input === null ||
    (typeof input === "string" && !input.trim());
  if (missing)
    return {
      value: null,
      evidence: {
        status: "missing",
        sourceId,
        ...(sourceField ? { sourceField } : {}),
        method:
          mapping?.kind === "field"
            ? "Mapped source field is empty or absent."
            : "No quantity was supplied or assumed.",
      },
    };
  let value: number;
  if (typeof input === "number") value = input;
  else if (typeof input === "string") {
    const trimmed = input.trim(),
      comma = mapping?.kind === "field" && mapping.decimal === "comma";
    const pattern = comma
      ? /^[+-]?(?:\d+(?:,\d+)?|,\d+)(?:[eE][+-]?\d+)?$/
      : /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    if (!pattern.test(trimmed))
      return fail(
        index,
        `${key} is not an unambiguous ${comma ? "comma" : "dot"}-decimal number; grouping separators and unit suffixes are not accepted.`,
      );
    value = Number(comma ? trimmed.replace(",", ".") : trimmed);
  } else
    return fail(
      index,
      `${key} must be numeric; booleans and objects are not quantities.`,
    );
  if (!Number.isFinite(value) || value < 0)
    return fail(index, `${key} must be a finite nonnegative number.`);
  if (key === "height")
    value *=
      sourceUnit === "feet"
        ? 0.3048
        : sourceUnit === "us-survey-feet"
          ? 1200 / 3937
          : 1;
  const evidence: AttributeEvidence = {
    status: mapping?.kind === "constant" ? "assumed" : "supplied",
    sourceId,
    ...(sourceField ? { sourceField } : {}),
    ...(sourceUnit ? { sourceUnit } : {}),
    rawValue: input as string | number,
  };
  if (key === "height" && sourceUnit && sourceUnit !== "meters")
    evidence.method = `Converted ${sourceUnit} to meters using ${sourceUnit === "feet" ? "0.3048" : "1200/3937"} meters per foot.`;
  return { value, evidence };
}
function mappedUse(
  feature: Feature,
  mapping: ImportMappingRecipe["use"],
  index: number,
  sourceId: string,
): { use: LandUse; evidence: AttributeEvidence } {
  if (!mapping) return fail(index, "An explicit use mapping is required.");
  if (mapping.kind === "constant")
    return {
      use: mapping.value,
      evidence: {
        status: "assumed",
        sourceId,
        rawValue: mapping.value,
        method: "Uploader reviewed this use assumption.",
      },
    };
  const value = scalar(raw(feature, mapping.field), index, "Building use");
  if (value === undefined || !Object.hasOwn(mapping.values, value))
    return fail(
      index,
      `Use value ${JSON.stringify(value ?? null)} has no reviewed mapping.`,
    );
  return {
    use: mapping.values[value],
    evidence: {
      status: "supplied",
      sourceId,
      sourceField: mapping.field,
      rawValue: value,
      method: `Mapped source label to ${mapping.values[value]}.`,
    },
  };
}
function overlapWarnings(
  imported: (Building | Parcel)[],
  existing: (Building | Parcel)[],
  mapping: ImportMappingRecipe,
) {
  const shape = (f: Building | Parcel) =>
    "kind" in f ? f.geometry : buildingGeometry(f);
  const boxes = existing.map((f) => ({ f, b: studyAreaBounds(shape(f)) }));
  const overlaps: { importedId: string; existingId: string; name: string }[] =
    [];
  let exact = 0,
    candidates = 0;
  for (const item of imported) {
    const a = studyAreaBounds(shape(item));
    for (const { f, b } of boxes) {
      if (++candidates > 2_000_000)
        throw new ApiError(
          413,
          "GIS_OVERLAP_LIMIT",
          "This import exceeds the bounded overlap-review workload. Split the file into smaller batches.",
        );
      if (
        f.id === item.id ||
        a[0] >= b[2] ||
        a[2] <= b[0] ||
        a[1] >= b[3] ||
        a[3] <= b[1]
      )
        continue;
      if (++exact > 10000)
        throw new ApiError(
          413,
          "GIS_OVERLAP_LIMIT",
          "This import requires too many exact overlap checks. Split the file into smaller batches.",
        );
      if (geometryIntersectionAreaSqm(shape(item), shape(f)) > 0.01)
        overlaps.push({ importedId: item.id, existingId: f.id, name: f.name });
      if (overlaps.length > 10000)
        throw new ApiError(
          413,
          "GIS_OVERLAP_LIMIT",
          "More than 10,000 overlapping feature pairs require review. Split the file or use an explicit matching field.",
        );
    }
    // Compare imported peers as well; a second copy must never disappear silently.
    if (mapping.target.mode === "append") boxes.push({ f: item, b: a });
  }
  return overlaps;
}

/** Pure, deterministic mapping. The worker persists this exact result before the user can apply it. */
export async function prepareGisPreview(input: {
  normalized: GisNormalized;
  request: GisPreviewRequest;
  place: Place;
  scenario: Scenario;
  projectId: string;
  jobId: string;
  uploadId: string;
  importId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}): Promise<GisPreview> {
  const request = gisPreviewRequestSchema.parse(input.request),
    { mapping } = request;
  const features = input.normalized.geojson.features;
  if (!features.length || features.length > GIS_LIMITS.features)
    throw new ApiError(
      413,
      "GIS_FEATURE_LIMIT",
      "Import between 1 and 5,000 polygon features.",
    );
  const normalizedHash = createHash("sha256")
    .update(canonicalJSON(input.normalized.geojson))
    .digest("hex");
  if (normalizedHash !== input.normalized.provenance.normalizedSha256)
    throw new ApiError(
      422,
      "GIS_NORMALIZED_MISMATCH",
      "Normalized geometry changed after conversion.",
    );
  const sourceId = `upload-${input.jobId}`;
  const source: Source = sourceSchema.parse({
    id: sourceId,
    name: request.source.name,
    url: request.source.url ?? "",
    vintage: request.source.vintage || "Unknown",
    license: request.source.license,
    kind: "user-supplied",
    description:
      "Uploader-supplied geometry and reviewed field mapping. These do not verify ownership, zoning approval, occupancy, observed jobs, or surveyed conditions.",
    import: {
      ...input.normalized.provenance,
      recipe: JSON.parse(
        JSON.stringify({
          conversion: request.conversion,
          mapping,
          normalization: input.normalized.provenance.recipe,
        }),
      ) as ImportRecipeValue,
    },
    rights: {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      export: true,
      historicalRetention: true,
      publicRedistribution: request.source.publicRedistribution,
      declaredBy: input.userId,
      declaredAt: input.createdAt,
    },
  });
  const existing =
    mapping.layer === "buildings"
      ? materializeBuildings(input.place, input.scenario)
      : materializeParcels(input.place, input.scenario).filter(
          (p) => p.kind === (mapping.layer === "parcels" ? "parcel" : "block"),
        );
  const targets = new Map<string, (Building | Parcel)[]>();
  if (mapping.target.mode === "match") {
    const target = mapping.target;
    for (const item of existing) {
      if (
        target.by === "sourceFeatureId" &&
        item.sourceId !== target.sourceId &&
        item.geometrySourceId !== target.sourceId
      )
        continue;
      const key = target.by === "id" ? item.id : item.sourceFeatureId;
      if (key !== undefined)
        targets.set(key, [...(targets.get(key) ?? []), item]);
    }
  }
  const used = new Set<string>(),
    refs = new Set<string>(),
    warnings = [...input.normalized.diagnostics.warnings];
  const mapped = features.map((feature, index) => {
    let previous: Building | Parcel | undefined;
    if (mapping.target.mode === "match") {
      const key = scalar(
          raw(feature, mapping.target.field),
          index,
          "Match key",
        ),
        matches = key === undefined ? [] : (targets.get(key) ?? []);
      if (matches.length !== 1)
        return fail(
          index,
          matches.length
            ? `Match key ${JSON.stringify(key)} is ambiguous within the selected namespace.`
            : `Match key ${JSON.stringify(key ?? null)} does not identify an existing ${mapping.layer === "buildings" ? "building" : mapping.layer === "parcels" ? "parcel" : "block"}; no feature will be silently appended.`,
        );
      previous = matches[0];
      if (used.has(previous.id))
        return fail(
          index,
          "More than one imported feature would update the same existing feature.",
        );
    }
    const id = previous?.id ?? `import-${input.jobId}-${index + 1}`;
    used.add(id);
    const name =
      mappedText(feature, mapping.name, index, "Name") ??
      previous?.name ??
      `Imported ${mapping.layer === "buildings" ? "footprint" : mapping.layer === "parcels" ? "parcel" : "block"} ${index + 1}`;
    const sourceFeatureId = mapping.sourceFeatureId
      ? mappedText(feature, mapping.sourceFeatureId, index, "Source feature ID")
      : scalar(feature.id, index, "Source feature ID");
    if (sourceFeatureId && refs.has(sourceFeatureId))
      warnings.push(
        `Feature ${index + 1}: source reference ${sourceFeatureId} is repeated; features remain distinct.`,
      );
    if (sourceFeatureId) refs.add(sourceFeatureId);
    const geometry = feature.geometry as StudyAreaGeometry;
    if (mapping.layer !== "buildings") {
      const validation = validateParcelGeometry(geometry, input.place);
      if (!validation.valid)
        return fail(index, validation.error ?? "Invalid parcel geometry.");
      return parcelSchema.parse({
        id,
        name,
        kind: mapping.layer === "parcels" ? "parcel" : "block",
        geometry,
        sourceId,
        geometrySourceId: sourceId,
        ...(sourceFeatureId ? { sourceFeatureId } : {}),
        lineage: {
          operation: "import",
          parentIds: previous ? [previous.id] : [],
          sourceIds: [sourceId, ...(previous ? [previous.sourceId] : [])],
        },
      });
    }
    const validation = validateBuildingGeometry(geometry, input.place);
    if (!validation.valid)
      return fail(index, validation.error ?? "Invalid building geometry.");
    const values = {} as Record<BuildingQuantityField, number | null>,
      evidence = {} as Record<BuildingQuantityField, AttributeEvidence>;
    for (const key of BUILDING_QUANTITY_FIELDS) {
      const q = quantity(
        feature,
        mapping.quantities?.[key],
        key,
        index,
        sourceId,
      );
      values[key] = q.value;
      evidence[key] = q.evidence;
    }
    const landUse = mappedUse(feature, mapping.use, index, sourceId);
    const programRaw = mapping.programField
      ? raw(feature, mapping.programField)
      : undefined;
    const program =
      programRaw === undefined || programRaw === null
        ? undefined
        : importedProgram(programRaw, sourceId);
    if (program)
      for (const key of ["units", "jobs"] as const) {
        const total = program.components.reduce((n, c) => n + c[key], 0);
        if (values[key] !== null && values[key] !== total)
          return fail(
            index,
            `${key} conflicts with the explicit building program.`,
          );
        if (values[key] === null) {
          values[key] = total;
          evidence[key] = {
            status: "derived",
            sourceId,
            sourceField: mapping.programField,
            method: `Sum of explicit program component ${key}.`,
          };
        }
      }
    const typology = mapping.typologyField
      ? raw(feature, mapping.typologyField)
      : undefined;
    const previousBuilding =
      previous && !("kind" in previous) ? previous : undefined;
    const retained = Object.fromEntries(
      [
        "address",
        "parcelId",
        "zoning",
        "maxHeight",
        "maxFar",
        "rentMonthly",
        "assessedValue",
      ].flatMap((key) =>
        previousBuilding && Object.hasOwn(previousBuilding, key)
          ? [[key, previousBuilding[key as keyof Building]]]
          : [],
      ),
    );
    if (previousBuilding?.program && !program)
      warnings.push(
        `Feature ${index + 1} (${name}): the matched building's existing typed program will be removed because no program was mapped. Reviewed quantities replace its former program totals; Undo restores the previous record.`,
      );
    if (
      previousBuilding?.typology &&
      (typology === undefined || typology === null)
    )
      warnings.push(
        `Feature ${index + 1} (${name}): the matched building's existing typology will be removed because no typology was mapped.`,
      );
    try {
      return buildingSchema.parse({
        id,
        name,
        use: landUse.use,
        geometry,
        areaSqm: validation.areaSqm,
        ...retained,
        ...values,
        sourceId,
        attributeSourceId: Object.keys(retained).length
          ? (previousBuilding!.attributeSourceId ?? previousBuilding!.sourceId)
          : sourceId,
        geometrySourceId: sourceId,
        estimated: true,
        attributeProvenance: {
          version: 1,
          fields: evidence,
          use: landUse.evidence,
        },
        ...(sourceFeatureId ? { sourceFeatureId } : {}),
        ...(typology !== undefined && typology !== null ? { typology } : {}),
        ...(program ? { program, programSourceId: sourceId } : {}),
      });
    } catch (error) {
      return fail(
        index,
        error instanceof Error ? error.message : "Invalid building attributes.",
      );
    }
  });
  if (mapping.layer === "buildings")
    validateImportExtent(mapped as Building[], input.place);
  else {
    validateParcelImportExtent(mapped as Parcel[], input.place);
    try {
      validateParcelCommand(input.place, input.scenario, {
        type: "parcels.import",
        parcels: mapped as Parcel[],
        source,
        mode: mapping.target.mode,
      });
    } catch (error) {
      throw new ApiError(
        422,
        "GIS_PARCEL_TOPOLOGY",
        error instanceof Error
          ? error.message
          : "The prepared parcel collection is invalid.",
      );
    }
  }
  const overlaps = overlapWarnings(mapped, existing, mapping);
  if (overlaps.length)
    warnings.push(
      `${overlaps.length} overlapping feature pair${overlaps.length === 1 ? " requires" : "s require"} review. Overlapping buildings can count the same space twice; use explicit matching to update existing features.`,
    );
  const missing =
    mapping.layer === "buildings"
      ? (mapped as Building[]).filter((b) =>
          BUILDING_QUANTITY_FIELDS.some((k) => b[k] === null),
        ).length
      : 0;
  if (missing)
    warnings.push(
      `${missing} building${missing === 1 ? " has" : "s have"} unknown quantities. Dependent totals remain unknown; supplied zeros remain known zeros.`,
    );
  warnings.push(
    "Geometry and mapped attributes remain user-supplied evidence. Review their source, coordinate placement, quantities, and overlaps before applying.",
  );
  const preview = {
    importId: input.importId,
    jobId: input.jobId,
    uploadId: input.uploadId,
    projectId: input.projectId,
    scenarioId: request.scenarioId,
    expectedVersion: request.expectedVersion,
    expectedRevision: request.expectedRevision,
    baselineIdentity: await baselineIdentity(input.place),
    source,
    warnings,
    featureCount: mapped.length,
    extentChecked: true as const,
    expiresAt: input.expiresAt,
    changes: {
      added: mapping.target.mode === "append" ? mapped.length : 0,
      updated: mapping.target.mode === "match" ? mapped.length : 0,
      overlaps,
    },
    diagnostics: input.normalized.diagnostics,
    ...(mapping.layer === "buildings"
      ? { layer: "buildings" as const, buildings: mapped as Building[] }
      : { layer: mapping.layer, parcels: mapped as Parcel[] }),
  };
  return {
    ...preview,
    previewHash: createHash("sha256")
      .update(canonicalJSON(preview))
      .digest("hex"),
  };
}
