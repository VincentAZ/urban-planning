import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  landUseLabels,
  buildingProgramUse,
  BUILDING_QUANTITY_FIELDS,
  type AttributeEvidence,
  validateBuildingEdit,
  validateBuildingGeometry,
  validateParcelGeometry,
  type Parcel,
  type StudyAreaGeometry,
  type Building,
  type LandUse,
  type Source,
  type Place,
} from "@urban/core";
import { ApiError } from "./errors.js";
import { buildingSchema, buildingProgramSchema } from "./validation.js";

/** Stamp uploaded program evidence with its actual import source, never an asserted observed identity. */
export function importedProgram(input: unknown, sourceId: string) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return buildingProgramSchema.parse(input);
  const value = input as Record<string, unknown>;
  const components = Array.isArray(value.components)
    ? value.components.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
          return item;
        const component = item as Record<string, unknown>;
        const rate = (value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? { ...value, sourceId }
            : value;
        return {
          ...component,
          sourceId,
          ...(Object.hasOwn(component, "tripRate")
            ? { tripRate: rate(component.tripRate) }
            : {}),
          ...(Object.hasOwn(component, "parkingRate")
            ? { parkingRate: rate(component.parkingRate) }
            : {}),
        };
      })
    : value.components;
  return buildingProgramSchema.parse({ ...value, components });
}
/** GeoJSON coordinates are WGS84; feature geometry is never replaced by cached area or exterior-only rings. */
function previewBuildingGeoJson(input: unknown) {
  const parsed = areaInputSchema
    .extend({ layer: z.literal("buildings").optional() })
    .parse(input);
  const { sourceName, geojson } = parsed;
  validateGeoJsonEnvelope(geojson);
  const source: Source = {
    id: `upload-${randomUUID()}`,
    name: sourceName,
    url: parsed.sourceUrl ?? "",
    vintage: parsed.sourceVintage ?? "Unknown",
    license:
      parsed.sourceLicense ??
      "User-supplied; publishing and redistribution require the uploader’s rights.",
    kind: "user-supplied",
    description:
      "User-supplied building geometry and programs. Polygon holes and disconnected components are preserved. Geometry does not verify floors, capacity, ownership, zoning, or observed activity.",
  };
  const warnings: string[] = [
    "Uploaded geometry, programs and rates are user-supplied evidence. They do not establish ownership, zoning approval, occupied homes, observed jobs, or calibrated traffic.",
    "Footprint area is derived from complete geometry, excluding holes. An explicit program controls floor-area allocation and unit/job totals; parking spaces remain supply, separate from demand rates.",
    "Only supported geometry, name, use, typology, program, height, floors, units, jobs, parking supply and source reference fields are mapped. Ownership, tax values, zoning and other properties are not inferred or certified.",
  ];
  const references = new Set<string>();
  const buildings: Building[] = geojson.features.map((feature, index) => {
    const geometry = feature.geometry as StudyAreaGeometry;
    const validation = validateBuildingGeometry(geometry);
    if (!validation.valid)
      throw new ApiError(
        422,
        "INVALID_GEOMETRY",
        `Feature ${index + 1}: ${validation.error}`,
      );
    const properties = feature.properties ?? {};
    let use =
      typeof properties.use === "string" &&
      Object.hasOwn(landUseLabels, properties.use)
        ? (properties.use as LandUse)
        : "vacant";
    const numeric = (key: string, fallback: number | null) => {
      if (!Object.hasOwn(properties, key) || properties[key] === null)
        return fallback;
      if (typeof properties[key] !== "number")
        throw new ApiError(
          422,
          "INVALID_BUILDING_ATTRIBUTE",
          `Feature ${index + 1}: ${key} must be a number when supplied.`,
        );
      return properties[key] as number;
    };
    const program = Object.hasOwn(properties, "program")
      ? importedProgram(properties.program, source.id)
      : undefined;
    if (program && !Object.hasOwn(properties, "use"))
      use = buildingProgramUse(program, "vacant");
    else if (
      program &&
      (typeof properties.use !== "string" ||
        !Object.hasOwn(landUseLabels, properties.use))
    )
      throw new ApiError(
        422,
        "INVALID_BUILDING_ATTRIBUTE",
        `Feature ${index + 1}: supplied use must be recognized and agree with the explicit component program.`,
      );
    if (!program && use === "vacant" && properties.use !== "vacant")
      throw new ApiError(
        422,
        "INVALID_BUILDING_ATTRIBUTE",
        `Feature ${index + 1}: supply a recognized use or use the import workbench to review an explicit use assumption.`,
      );
    const units =
      program?.components.reduce((total, c) => total + c.units, 0) ?? null;
    const jobs =
      program?.components.reduce((total, c) => total + c.jobs, 0) ?? null;
    const suppliedId =
      feature.id ??
      (Object.hasOwn(properties, "sourceFeatureId")
        ? properties.sourceFeatureId
        : properties.buildingId);
    const sourceFeatureId =
      typeof suppliedId === "string" || typeof suppliedId === "number"
        ? String(suppliedId)
        : undefined;
    if (sourceFeatureId && sourceFeatureId.length > 240)
      throw new ApiError(
        422,
        "INVALID_SOURCE_REFERENCE",
        `Feature ${index + 1} has a source reference longer than 240 characters.`,
      );
    if (sourceFeatureId && references.has(sourceFeatureId))
      warnings.push(
        `Feature ${index + 1}: repeated source reference ${sourceFeatureId}; features remain separate buildings.`,
      );
    if (sourceFeatureId) references.add(sourceFeatureId);
    const missing = [
      "height",
      "floors",
      "parkingSpaces",
      ...(program ? [] : ["units", "jobs"]),
    ].filter(
      (key) => !Object.hasOwn(properties, key) || properties[key] === null,
    );
    if (missing.length)
      warnings.push(
        `Feature ${index + 1}: ${missing.join(", ")} remain unknown. Dependent totals are unavailable until supplied or explicitly assumed.`,
      );
    const building = buildingSchema.parse({
      id: `import-${randomUUID()}`,
      name:
        typeof properties.name === "string"
          ? properties.name
          : `Imported footprint ${index + 1}`,
      use,
      geometry,
      areaSqm: validation.areaSqm,
      height: numeric("height", null),
      floors: numeric("floors", null),
      units: numeric("units", units),
      jobs: numeric("jobs", jobs),
      parkingSpaces: numeric("parkingSpaces", null),
      attributeProvenance: {
        version: 1,
        fields: Object.fromEntries(
          BUILDING_QUANTITY_FIELDS.map((key) => {
            const supplied =
              Object.hasOwn(properties, key) && properties[key] !== null;
            const derived =
              !supplied && program && (key === "units" || key === "jobs");
            const evidence: AttributeEvidence = {
              status: supplied ? "supplied" : derived ? "derived" : "missing",
              sourceId: source.id,
              sourceField: derived ? "program" : key,
              ...(supplied ? { rawValue: properties[key] as number } : {}),
              ...(!supplied
                ? {
                    method: derived
                      ? `Sum of explicit program component ${key}.`
                      : "The uploaded field is absent or null.",
                  }
                : {}),
            };
            return [key, evidence];
          }),
        ),
        use: {
          status:
            program && !Object.hasOwn(properties, "use")
              ? "derived"
              : "supplied",
          sourceId: source.id,
          sourceField:
            program && !Object.hasOwn(properties, "use") ? "program" : "use",
          rawValue: use,
        },
      },
      sourceId: source.id,
      attributeSourceId: source.id,
      geometrySourceId: source.id,
      estimated: missing.length > 0,
      ...(sourceFeatureId ? { sourceFeatureId } : {}),
      ...(Object.hasOwn(properties, "typology")
        ? { typology: properties.typology }
        : {}),
      ...(program ? { program, programSourceId: source.id } : {}),
    });
    if (
      program &&
      building.floors !== null &&
      Math.abs(
        program.grossFloorAreaSqm - validation.areaSqm * building.floors,
      ) > Math.max(0.001, program.grossFloorAreaSqm * 1e-9)
    )
      warnings.push(
        `Feature ${index + 1}: the explicit program has ${program.grossFloorAreaSqm} m² of floor area, different from footprint × floors. The program controls calculations; the map uses uniform-height massing.`,
      );
    return building;
  });
  return {
    layer: "buildings" as const,
    source,
    buildings,
    warnings,
    featureCount: buildings.length,
    requiresReview: true,
    committed: false,
  };
}

const importPosition = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const importRing = z.array(importPosition).min(4).max(10000);
const importPolygon = z.array(importRing).min(1).max(500);
const areaInputSchema = z.object({
  layer: z.enum(["parcels", "blocks"]),
  sourceName: z.string().trim().min(1).max(240),
  sourceUrl: z
    .string()
    .trim()
    .max(2000)
    .refine(
      (value) => !value || /^https?:\/\//i.test(value),
      "Source URL must use http or https.",
    )
    .optional(),
  sourceVintage: z.string().trim().min(1).max(100).optional(),
  sourceLicense: z.string().trim().min(1).max(2000).optional(),
  geojson: z.object({
    type: z.literal("FeatureCollection"),
    crs: z.unknown().optional(),
    features: z
      .array(
        z.object({
          type: z.literal("Feature"),
          id: z.union([z.string().max(240), z.number().finite()]).optional(),
          geometry: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("Polygon"),
              coordinates: importPolygon,
            }),
            z.object({
              type: z.literal("MultiPolygon"),
              coordinates: z.array(importPolygon).min(1).max(500),
            }),
          ]),
          properties: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
      )
      .min(1)
      .max(5000),
  }),
});
function validateGeoJsonEnvelope(
  geojson: z.infer<typeof areaInputSchema>["geojson"],
) {
  if (geojson.crs !== undefined) {
    const crs = geojson.crs as {
      type?: unknown;
      properties?: { name?: unknown };
    } | null;
    const name = crs?.type === "name" ? crs.properties?.name : undefined;
    if (
      typeof name !== "string" ||
      !/^(?:EPSG:4326|urn:ogc:def:crs:EPSG::4326|urn:ogc:def:crs:OGC:1\.3:CRS84|OGC:CRS84)$/i.test(
        name,
      )
    )
      throw new ApiError(
        422,
        "UNSUPPORTED_CRS",
        "Reproject this layer to WGS84 longitude/latitude (GeoJSON) before importing it. Projected coordinates will not be guessed or relabeled.",
      );
  }
  const vertices = geojson.features.reduce(
    (total, feature) =>
      total +
      (feature.geometry.type === "Polygon"
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates
      ).reduce(
        (count, polygon) =>
          count + polygon.reduce((n, ring) => n + ring.length, 0),
        0,
      ),
    0,
  );
  if (vertices > 50000)
    throw new ApiError(
      413,
      "IMPORT_TOO_LARGE",
      "This interactive import supports up to 50,000 vertices. Split the layer into smaller files.",
    );
}
function previewParcelGeoJson(input: unknown) {
  const parsed = areaInputSchema.parse(input);
  const { geojson, sourceName, layer } = parsed;
  validateGeoJsonEnvelope(geojson);
  const source: Source = {
    id: `upload-${randomUUID()}`,
    name: sourceName,
    url: parsed.sourceUrl ?? "",
    vintage: parsed.sourceVintage ?? new Date().toISOString().slice(0, 10),
    license:
      parsed.sourceLicense ??
      "User-supplied; publishing and redistribution require the uploader’s rights.",
    kind: "user-supplied",
    description: `Uploaded ${layer === "parcels" ? "parcel" : "block"} boundaries, supplied by the user. Polygon holes and disconnected components are retained. This import does not verify ownership, legal lot status, surveying, or zoning permissions.`,
  };
  const warnings = [
    "These are user-supplied planning boundaries. Importing or editing them does not establish legal lots, ownership, development rights, or an approved subdivision.",
    "Buildings are associated only when their entire footprint fits one nonoverlapping parcel. Straddling and ambiguous buildings remain unresolved; blocks do not substitute for parcel land in FAR or lot coverage.",
    "Only geometry, name, and the source feature reference are imported. Ownership, zoning, tax values, and other source attributes are not inferred or certified.",
  ];
  const references = new Set<string>();
  const parcels: Parcel[] = geojson.features.map((feature, index) => {
    const geometry = feature.geometry as StudyAreaGeometry;
    const validation = validateParcelGeometry(geometry);
    if (!validation.valid)
      throw new ApiError(
        422,
        "INVALID_GEOMETRY",
        `Feature ${index + 1}: ${validation.error}`,
      );
    const properties = feature.properties ?? {};
    const suppliedId =
      feature.id ??
      (Object.hasOwn(properties, "parcelId") ? properties.parcelId : undefined);
    const sourceFeatureId =
      typeof suppliedId === "string" || typeof suppliedId === "number"
        ? String(suppliedId)
        : undefined;
    if (sourceFeatureId && sourceFeatureId.length > 240)
      throw new ApiError(
        422,
        "INVALID_SOURCE_REFERENCE",
        `Feature ${index + 1} has a source reference longer than 240 characters.`,
      );
    if (sourceFeatureId && references.has(sourceFeatureId))
      warnings.push(
        `Feature ${index + 1}: source reference ${sourceFeatureId} is repeated. Separate features remain separate planning boundaries.`,
      );
    if (sourceFeatureId) references.add(sourceFeatureId);
    const name =
      typeof properties.name === "string"
        ? properties.name.trim()
        : `Imported ${layer === "parcels" ? "parcel" : "block"} ${index + 1}`;
    if (!name || name.length > 240)
      throw new ApiError(
        422,
        "INVALID_NAME",
        `Feature ${index + 1} needs a name between 1 and 240 characters.`,
      );
    return {
      id: `parcel-${randomUUID()}`,
      name,
      kind: layer === "parcels" ? "parcel" : "block",
      geometry,
      sourceId: source.id,
      ...(sourceFeatureId ? { sourceFeatureId } : {}),
      lineage: { operation: "import", parentIds: [], sourceIds: [source.id] },
    };
  });
  return {
    layer,
    source,
    parcels,
    warnings,
    featureCount: parcels.length,
    requiresReview: true,
    committed: false,
  };
}
/** Omitting layer retains the existing building-footprint contract. */
export function previewGeoJson(input: unknown) {
  const { layer } = z
    .object({
      layer: z.enum(["buildings", "parcels", "blocks"]).default("buildings"),
    })
    .parse(input);
  return layer === "buildings"
    ? previewBuildingGeoJson(input)
    : previewParcelGeoJson(input);
}

export function validateParcelImportExtent(parcels: Parcel[], place: Place) {
  for (const parcel of parcels) {
    const validation = validateParcelGeometry(parcel.geometry, place);
    if (!validation.valid)
      throw new ApiError(
        422,
        "INVALID_PARCEL_GEOMETRY",
        `Imported ${parcel.kind} ${parcel.name}: ${validation.error}`,
        { featureId: parcel.id, extent: place.extentLabel },
      );
  }
}

export function validateImportExtent(buildings: Building[], place: Place) {
  const invalid = buildings.flatMap((building) => {
    const validation = validateBuildingEdit(building, place);
    return validation.valid ? [] : [{ building, error: validation.error }];
  });
  if (invalid.length) {
    const outside = invalid.some(({ error }) =>
      /outside|study area|study boundary/i.test(error ?? ""),
    );
    throw new ApiError(
      422,
      outside ? "OUTSIDE_STUDY_AREA" : "INVALID_BUILDING_EDIT",
      `Building ${invalid[0].building.name}: ${invalid[0].error ?? "Invalid geometry or program."}`,
      {
        outsideFeatureIds: invalid
          .slice(0, 30)
          .map(({ building }) => building.id),
        extent: place.extentLabel,
      },
    );
  }
}
