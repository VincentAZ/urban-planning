import { z } from "zod";
import type { Place, Project, Scenario, Source } from "./index";
import type { StudyAreaGeometry } from "./study-area";
import { isValidStudyArea, studyAreaGeometry } from "./study-area";
import { accessibilitySourceSchema } from "./accessibility";
import { canonicalJSON } from "./canonical";
import { projectWithAccessibilityVersion } from "./accessibility-scenario";
import { sha256 } from "@noble/hashes/sha2.js";
import { difference, featureCollection } from "@turf/turf";
import { studyAreaFeature } from "./study-area";
import { floodResidualWithinCoordinateCells } from "./flood-containment";
export { floodResidualWithinCoordinateCells } from "./flood-containment";
const floodSha256 = (text: string) =>
  Array.from(sha256(new TextEncoder().encode(text)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

export const FLOOD_LEGACY_METHOD_VERSION = "flood-footprint-1.0.0";
/** New attachments opt in explicitly; omission on retained references remains legacy. */
export const FLOOD_METHOD_VERSION = "flood-footprint-1.1.0";
export const FLOOD_METHOD_VERSIONS = [
  FLOOD_LEGACY_METHOD_VERSION,
  FLOOD_METHOD_VERSION,
] as const;
export type FloodMethodVersion = (typeof FLOOD_METHOD_VERSIONS)[number];
export const MAX_FLOOD_DATASET_BYTES = 8 * 1024 * 1024;
export const MAX_FLOOD_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_FLOOD_DATASETS = 8;
export const MAX_FLOOD_VERTICES = 50_000;
export const MAX_FLOOD_FEATURES = 5_000;

export type FloodAttributes = Record<string, string | number | null>;
export interface FloodFeature {
  id: string;
  geometry: StudyAreaGeometry;
  /** Exact source fields, including per-record dates and citation identifiers. */
  attributes: FloodAttributes;
}
export interface FloodZoneFeature extends FloodFeature {
  attributes: FloodAttributes & {
    FLD_AR_ID: string;
    FLD_ZONE: string | null;
    SFHA_TF: string | null;
    ZONE_SUBTY: string | null;
    SOURCE_CIT: string | null;
  };
  classification: "sfha" | "other-mapped" | "undetermined";
}
export interface FloodSourceFile {
  sourceId: string;
  url: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
}
export interface FloodLayerReceipt {
  layerId: number;
  name: string;
  objectIds: number[];
  /** Before/after IDs and canonical records must reconcile, including empty layers. */
  beforeIdsHash: string;
  afterIdsHash: string;
  beforeRecordsHash: string;
  afterRecordsHash: string;
  fileHashes: string[];
}
export interface FloodDataset {
  version: 1;
  kind: "fema-effective-nfhl";
  studyArea: StudyAreaGeometry;
  studyAreaHash: string;
  capturedAt: string;
  sources: Source[];
  files: FloodSourceFile[];
  capture: {
    serviceUrl: string;
    queryGeometryHash: string;
    complete: true;
    layerReceipts: FloodLayerReceipt[];
    /** Exact Study_Info records, including DBREV_DATE, fenced before/after capture. */
    studyInfo: FloodAttributes[];
    normalization: {
      methodVersion: string;
      crs: "OGC:CRS84";
      clipped: true;
    };
  };
  zones: FloodZoneFeature[];
  availability: FloodFeature[];
  panels: FloodFeature[];
  revisions: FloodFeature[];
  seclusions: FloodFeature[];
  notes: string[];
}
export interface FloodReference {
  version: 1;
  datasetHash: string;
  /** A label is not authority: server-catalog requires the API's exact catalog check. */
  origin: "server-catalog" | "imported";
  /** Absent on historical references means 1.0.0, never the latest method. */
  methodVersion?: FloodMethodVersion;
}
export function floodMethodVersion(
  reference?: Pick<FloodReference, "methodVersion"> | null,
): FloodMethodVersion {
  return reference?.methodVersion ?? FLOOD_LEGACY_METHOD_VERSION;
}
export type FloodDatasetCatalog = Record<string, FloodDataset>;

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(10_000);
const stamp = z.string().datetime({ offset: true });
const url = z.url({ protocol: /^https?$/ });
const position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-85).max(85),
]);
const ring = z
  .array(position)
  .min(4)
  .max(MAX_FLOOD_VERTICES)
  .refine(
    (r) =>
      r[0][0] === r.at(-1)![0] &&
      r[0][1] === r.at(-1)![1] &&
      new Set(r.map(([x, y]) => `${x},${y}`)).size >= 3,
    "Flood rings must be closed and retain at least three distinct positions.",
  );
/**
 * Structural parsing is linear in retained coordinates. Topology and geometric
 * containment belong to validateFloodDataset, which untrusted server inputs must
 * run in a bounded worker rather than the request/parser thread.
 */
export const floodGeometrySchema: z.ZodType<StudyAreaGeometry> = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("Polygon"),
        coordinates: z.array(ring).min(1).max(1000),
      })
      .strict(),
    z
      .object({
        type: z.literal("MultiPolygon"),
        coordinates: z.array(z.array(ring).min(1).max(1000)).min(1).max(1000),
      })
      .strict(),
  ])
  .refine(
    (g) => floodVertexCount(g) <= MAX_FLOOD_VERTICES,
    "Flood geometry exceeds the total vertex bound.",
  );
const attributes = z
  .record(
    z.string().min(1).max(160),
    z.union([z.string().max(10_000), z.number().finite(), z.null()]),
  )
  .refine((v) => Object.keys(v).length <= 128, "Too many source fields.");
const featureFields = {
  id: z.string().min(1).max(160),
  geometry: floodGeometrySchema,
  attributes,
};
export const floodFeatureSchema: z.ZodType<FloodFeature> = z
  .object(featureFields)
  .strict();

/** Zone D and missing/unrecognized classifications cannot establish a clear footprint. */
export function classifyFloodZone(
  a: FloodZoneFeature["attributes"],
): FloodZoneFeature["classification"] {
  const zone = (a.FLD_ZONE ?? "").trim().toUpperCase();
  const flag = (a.SFHA_TF ?? "").trim().toUpperCase();
  const subtype = (a.ZONE_SUBTY ?? "").trim().toUpperCase();
  if (
    /AREA NOT INCLUDED|NOT MAPPED|UNMAPPED|UNDETERMINED/.test(subtype) ||
    zone === "D"
  )
    return "undetermined";
  const isSfha =
    /^(A|AE|AH|AO|A99|AR|AR\/A|AR\/AE|AR\/AH|AR\/AO|AR\/A(?:[1-9]|[12][0-9]|30)|A(?:[1-9]|[12][0-9]|30)|V|VE|V(?:[1-9]|[12][0-9]|30))$/.test(
      zone,
    );
  if (flag === "T" && isSfha) return "sfha";
  if (flag === "F" && ["B", "C"].includes(zone)) return "other-mapped";
  if (
    flag === "F" &&
    zone === "X" &&
    [
      "AREA OF MINIMAL FLOOD HAZARD",
      "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
      "AREA WITH REDUCED FLOOD RISK DUE TO LEVEE",
      "AREA OF MODERATE FLOOD HAZARD",
      "1 PCT DRAINAGE AREA LESS THAN 1 SQUARE MILE",
      "1 PCT FUTURE CONDITIONS",
    ].includes(subtype)
  )
    return "other-mapped";
  return "undetermined";
}
export const floodZoneFeatureSchema: z.ZodType<FloodZoneFeature> = z
  .object({
    ...featureFields,
    attributes: attributes.and(
      z.object({
        FLD_AR_ID: text,
        FLD_ZONE: z.string().nullable(),
        SFHA_TF: z.string().nullable(),
        ZONE_SUBTY: z.string().nullable(),
        SOURCE_CIT: z.string().nullable(),
      }),
    ),
    classification: z.enum(["sfha", "other-mapped", "undetermined"]),
  })
  .strict()
  .refine(
    (v) => v.classification === classifyFloodZone(v.attributes),
    "Flood classification disagrees with retained source fields.",
  );
export const floodReferenceSchema: z.ZodType<FloodReference> = z
  .object({
    version: z.literal(1),
    datasetHash: sha,
    origin: z.enum(["server-catalog", "imported"]),
    methodVersion: z.enum(FLOOD_METHOD_VERSIONS).optional(),
  })
  .strict();
export const floodDatasetSchema: z.ZodType<FloodDataset> = z
  .object({
    version: z.literal(1),
    kind: z.literal("fema-effective-nfhl"),
    studyArea: floodGeometrySchema,
    studyAreaHash: sha,
    capturedAt: stamp,
    sources: z.array(accessibilitySourceSchema).min(1).max(100),
    files: z
      .array(
        z
          .object({
            sourceId: text,
            url: z.union([z.literal(""), url]),
            sha256: sha,
            bytes: z
              .number()
              .int()
              .min(0)
              .max(100 * 1024 * 1024),
            retrievedAt: stamp,
          })
          .strict(),
      )
      .min(1)
      .max(256),
    capture: z
      .object({
        serviceUrl: url,
        queryGeometryHash: sha,
        complete: z.literal(true),
        layerReceipts: z
          .array(
            z
              .object({
                layerId: z.number().int().min(0),
                name: text,
                objectIds: z.array(z.number().int().min(0)).max(50_000),
                beforeIdsHash: sha,
                afterIdsHash: sha,
                beforeRecordsHash: sha,
                afterRecordsHash: sha,
                fileHashes: z.array(sha).min(1).max(256),
              })
              .strict(),
          )
          .min(1)
          .max(32),
        studyInfo: z.array(attributes).max(1000),
        normalization: z
          .object({
            methodVersion: text,
            crs: z.literal("OGC:CRS84"),
            clipped: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    zones: z.array(floodZoneFeatureSchema).max(MAX_FLOOD_FEATURES),
    availability: z.array(floodFeatureSchema).max(MAX_FLOOD_FEATURES),
    panels: z.array(floodFeatureSchema).max(MAX_FLOOD_FEATURES),
    revisions: z.array(floodFeatureSchema).max(MAX_FLOOD_FEATURES),
    seclusions: z.array(floodFeatureSchema).max(MAX_FLOOD_FEATURES),
    notes: z.array(text).max(100),
  })
  .strict()
  .superRefine((v, c) => {
    const issue = (message: string) => c.addIssue({ code: "custom", message });
    if (floodByteLength(v) > MAX_FLOOD_DATASET_BYTES)
      issue(
        "Flood dataset exceeds 8 MiB; do not truncate or simplify the captured evidence.",
      );
    const features = [
      ...v.zones,
      ...v.availability,
      ...v.panels,
      ...v.revisions,
      ...v.seclusions,
    ];
    if (
      features.length > MAX_FLOOD_FEATURES ||
      features.reduce(
        (n, f) => n + floodVertexCount(f.geometry),
        floodVertexCount(v.studyArea),
      ) > MAX_FLOOD_VERTICES
    )
      issue("Flood dataset exceeds the total feature/vertex bound.");
    for (const rows of [
      v.zones,
      v.availability,
      v.panels,
      v.revisions,
      v.seclusions,
    ])
      if (new Set(rows.map((f) => f.id)).size !== rows.length)
        issue("Duplicate flood feature identities.");
    const sourceIds = new Set(v.sources.map((s) => s.id)),
      files = new Set(v.files.map((f) => f.sha256));
    if (
      sourceIds.size !== v.sources.length ||
      v.files.some((f) => !sourceIds.has(f.sourceId))
    )
      issue("Flood source/file references must reconcile.");
    const layers = new Set<number>();
    for (const r of v.capture.layerReceipts) {
      if (
        layers.has(r.layerId) ||
        r.beforeIdsHash !== r.afterIdsHash ||
        r.beforeRecordsHash !== r.afterRecordsHash ||
        new Set(r.objectIds).size !== r.objectIds.length ||
        r.fileHashes.some((h) => !files.has(h))
      )
        issue(
          "Flood capture receipts must retain unchanged complete source layers and files.",
        );
      layers.add(r.layerId);
    }
    for (const layer of [0, 1, 3, 28, 29, 41])
      if (!layers.has(layer))
        issue(`Missing required effective flood context layer ${layer}.`);
  });

export function floodVertexCount(g: StudyAreaGeometry): number {
  return (g.type === "Polygon" ? [g.coordinates] : g.coordinates).reduce(
    (n, p) => n + p.reduce((m, r) => m + r.length, 0),
    0,
  );
}
/**
 * polygon-clipping can return a closed, repeated A/B/A/A line as a difference
 * component. Fewer than three distinct *exact* points cannot enclose area.
 * This is not an area/coordinate tolerance: every three-point residual,
 * however small, remains unresolved and is rejected by the containment guard.
 */
export function floodHasArealComponent(
  g:
    | StudyAreaGeometry
    | import("geojson").Polygon
    | import("geojson").MultiPolygon
    | null,
): boolean {
  return (
    !!g &&
    (g.type === "Polygon" ? [g.coordinates] : g.coordinates).some(
      (p) => new Set(p[0].map(([x, y]) => `${x},${y}`)).size >= 3,
    )
  );
}
export function floodByteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).byteLength;
}
export function floodDatasetHashSync(dataset: FloodDataset): string {
  return floodSha256(canonicalJSON(dataset));
}
export async function floodDatasetHash(dataset: FloodDataset): Promise<string> {
  return floodDatasetHashSync(dataset);
}
export async function floodStudyAreaHash(
  place: Place | StudyAreaGeometry,
): Promise<string> {
  return floodSha256(canonicalJSON(studyAreaGeometry(place)));
}
export function validateFloodDataset(
  dataset: FloodDataset,
  place?: Place,
): void {
  floodDatasetSchema.parse(dataset);
  if (!isValidStudyArea(dataset.studyArea))
    throw new Error("Invalid flood study-area polygon topology.");
  if (
    floodSha256(canonicalJSON(dataset.studyArea)) !== dataset.studyAreaHash ||
    (place &&
      floodSha256(canonicalJSON(studyAreaGeometry(place))) !==
        dataset.studyAreaHash)
  )
    throw new Error("Flood dataset exact study-area hash mismatch.");
  for (const f of [
    ...dataset.zones,
    ...dataset.availability,
    ...dataset.panels,
    ...dataset.revisions,
    ...dataset.seclusions,
  ]) {
    if (!isValidStudyArea(f.geometry))
      throw new Error("Invalid normalized flood polygon topology.");
    if (
      !floodResidualWithinCoordinateCells(
        difference(
          featureCollection([
            studyAreaFeature(f.geometry),
            studyAreaFeature(dataset.studyArea),
          ]),
        )?.geometry ?? null,
        dataset.studyArea,
      )
    )
      throw new Error(
        "Normalized flood geometry extends outside its exact retained study area.",
      );
  }
}
export const floodDatasetCatalogSchema: z.ZodType<FloodDatasetCatalog> = z
  .record(sha, floodDatasetSchema)
  .superRefine((v, c) => {
    if (
      Object.keys(v).length > MAX_FLOOD_DATASETS ||
      floodByteLength(v) > MAX_FLOOD_CATALOG_BYTES
    )
      c.addIssue({
        code: "custom",
        message:
          "Flood catalog exceeds 8 packs or 16 MiB; retain complete evidence.",
      });
  });

export function floodReferences(project: Project): FloodReference[] {
  const entries = [...project.history, ...project.undone];
  return [...project.scenarios, ...entries.flatMap((e) => [e.before, e.after])]
    .flatMap((s) => (s.flood ? [s.flood] : []))
    .concat(
      entries.flatMap((e) =>
        e.command.type === "scenario.flood" && e.command.flood
          ? [e.command.flood]
          : [],
      ),
    );
}
export async function validateProjectFlood(
  project: Project,
  place: Place,
): Promise<void> {
  const catalog = project.floodDatasets ?? {};
  floodDatasetCatalogSchema.parse(catalog);
  const studyHash = await floodStudyAreaHash(place);
  for (const [hash, dataset] of Object.entries(catalog)) {
    validateFloodDataset(dataset, place);
    if (
      floodDatasetHashSync(dataset) !== hash ||
      floodSha256(canonicalJSON(dataset.studyArea)) !== dataset.studyAreaHash ||
      dataset.studyAreaHash !== studyHash
    )
      throw new Error(
        "Flood dataset content or exact study-area binding mismatch.",
      );
  }
  for (const ref of floodReferences(project)) {
    floodReferenceSchema.parse(ref);
    if (!Object.hasOwn(catalog, ref.datasetHash))
      throw new Error(
        "A current or historical flood reference has no retained dataset.",
      );
  }
  for (const s of [
    ...project.scenarios,
    ...[...project.history, ...project.undone].flatMap((e) => [
      e.before,
      e.after,
    ]),
  ])
    if (s.id === "baseline" && s.flood)
      throw new Error(
        "The immutable baseline cannot adopt a flood dataset reference.",
      );
}
export async function projectWithFloodDataset(
  project: Project,
  dataset: FloodDataset,
  place?: Place,
): Promise<Project> {
  const copy = structuredClone(dataset);
  validateFloodDataset(copy, place);
  const hash = floodDatasetHashSync(copy),
    catalog = project.floodDatasets ?? {};
  const result = projectWithFloodVersion(
    { ...project, floodDatasets: { ...catalog, [hash]: copy } },
    place,
  );
  floodDatasetCatalogSchema.parse(result.floodDatasets);
  if (place) await validateProjectFlood(result, place);
  return result;
}
export function projectWithFloodVersion(
  project: Project,
  place?: Place,
): Project {
  const p = projectWithAccessibilityVersion(project, place);
  return p.schemaVersion >= 11
    ? p
    : p.floodDatasets !== undefined ||
        floodReferences(p).length ||
        [...p.history, ...p.undone].some(
          (e) => e.command.type === "scenario.flood",
        )
      ? { ...p, schemaVersion: 11 }
      : p;
}
export function projectWithImportedFlood(project: Project): Project {
  if (!floodReferences(project).length) return project;
  const p = structuredClone(project);
  for (const ref of floodReferences(p)) ref.origin = "imported";
  return p;
}
/** Existing catalog entries are immutable even after a scenario/reference is removed. */
export function validateFloodCatalogTransition(
  previous: Project,
  next: Project,
): void {
  for (const [hash, dataset] of Object.entries(previous.floodDatasets ?? {}))
    if (
      !next.floodDatasets?.[hash] ||
      canonicalJSON(next.floodDatasets[hash]) !== canonicalJSON(dataset)
    )
      throw new Error(
        "Retain immutable flood datasets needed by project history.",
      );
}
