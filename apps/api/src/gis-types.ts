import { z } from "zod";
import type { SourceImportMetadata } from "@urban/core";

export const GIS_IMAGE =
  "ghcr.io/osgeo/gdal@sha256:44fee7d4f9be0966851d7b14a0a387216897d8347f9e0ebc4e812f7217bc39d6";
export const GIS_LIMITS = {
  inspectionBytes: 1024 ** 2,
  inputBytes: 20 * 1024 ** 2,
  expandedBytes: 100 * 1024 ** 2,
  outputBytes: 100 * 1024 ** 2,
  archiveMembers: 100,
  features: 5000,
  vertices: 50000,
  inspectedEntities: 100000,
  fields: 256,
  milliseconds: 30000,
  memoryBytes: 512 * 1024 ** 2,
} as const;
export type GisFormat = "geojson" | "shapefile" | "dxf";
export type GisUnit =
  | "meters"
  | "feet"
  | "us-survey-feet"
  | "millimeters"
  | "centimeters"
  | "inches";
const xy = z.tuple([z.number().finite(), z.number().finite()]);
const lonlat = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-85).max(85),
]);
const control = z.object({ source: xy, target: lonlat }).strict();
export const gisRecipeSchema = z
  .object({
    layerId: z.string().min(1).max(240),
    sourceCrs: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("file") }).strict(),
        z
          .object({
            kind: z.literal("epsg"),
            code: z.number().int().min(1).max(1000000),
          })
          .strict(),
      ])
      .optional(),
    encoding: z
      .enum(["UTF-8", "CP1252", "ISO-8859-1", "CP437", "CP850"])
      .optional(),
    flattenZ: z.boolean().default(false),
    acknowledgeExcluded: z.boolean().default(false),
    dxf: z
      .object({
        entityIds: z.array(z.string().min(1).max(240)).max(5000).optional(),
        units: z.enum([
          "meters",
          "feet",
          "us-survey-feet",
          "millimeters",
          "centimeters",
          "inches",
        ]),
        curveToleranceMeters: z.number().finite().min(0.001).max(10),
        localTransform: z
          .object({
            controls: z.array(control).min(2).max(20),
            checkpoints: z.array(control).max(20).default([]),
            maximumResidualMeters: z
              .number()
              .finite()
              .positive()
              .max(100)
              .default(5),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GisRecipe = z.input<typeof gisRecipeSchema>;
export interface GisField {
  name: string;
  type: string;
  nullable: boolean;
  samples: (string | number | boolean | null)[];
}
export interface GisLayer {
  id: string;
  name: string;
  featureCount: number;
  geometryTypes: Record<string, number>;
  entityTypes: Record<string, number>;
  fields: GisField[];
  bounds: [number, number, number, number] | null;
  crs: { wkt: string; authority: string | null; unit: string | null } | null;
  supportedFootprints: number;
  unsupportedEntities: number;
  hasZ: boolean;
}
export interface GisInspection {
  version: 1;
  format: GisFormat;
  input: {
    sha256: string;
    bytes: number;
    members: { name: string; sha256: string; bytes: number }[];
  };
  converter: {
    name: string;
    version: string;
    projVersion: string;
    imageDigest: string;
  };
  layers: GisLayer[];
  warnings: string[];
}
export interface GisNormalized {
  version: 1;
  geojson: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
  provenance: SourceImportMetadata;
  diagnostics: {
    inputFeatures: number;
    selectedFeatures: number;
    outputFeatures: number;
    excludedFeatures: number;
    vertices: number;
    warnings: string[];
    controlResidualsMeters?: number[];
    checkpointResidualsMeters?: number[];
  };
}
export interface GisExportLayer {
  id: string;
  geojson: GeoJSON.FeatureCollection;
}
export interface GisExportResult {
  zip: Buffer;
  sha256: string;
  manifest: Record<string, unknown>;
}
export interface GisInput {
  inputPath: string;
  format: GisFormat;
  filename?: string;
  signal?: AbortSignal;
}
