import type {
  Building,
  Parcel,
  Source,
  LandUse,
  BuildingQuantityField,
  BaselineIdentity,
} from "@urban/core";
import type { GisFormat, GisInspection, GisRecipe } from "./gis-types";

export type ImportLayer = "buildings" | "parcels" | "blocks";
export type ImportTextMapping =
  { kind: "field"; field: string } | { kind: "constant"; value: string };
export type ImportNumberMapping =
  | {
      kind: "field";
      field: string;
      unit?: "meters" | "feet" | "us-survey-feet";
      decimal?: "dot" | "comma";
    }
  | {
      kind: "constant";
      value: number;
      unit?: "meters" | "feet" | "us-survey-feet";
    }
  | { kind: "missing" };
export type ImportUseMapping =
  | { kind: "constant"; value: LandUse }
  | { kind: "field"; field: string; values: Record<string, LandUse> };
export interface ImportMappingRecipe {
  layer: ImportLayer;
  target:
    | { mode: "append" }
    | {
        mode: "match";
        field: string;
        by: "id" | "sourceFeatureId";
        sourceId?: string;
      };
  name?: ImportTextMapping;
  sourceFeatureId?: ImportTextMapping;
  use?: ImportUseMapping;
  quantities?: Partial<Record<BuildingQuantityField, ImportNumberMapping>>;
  /** Optional typed Urban Planning component program; never inferred from arbitrary CAD text. */
  programField?: string;
  typologyField?: string;
}
export interface ImportSourceDeclaration {
  name: string;
  url?: string;
  vintage?: string;
  license: string;
  /** Covers private caching, analysis, display, authorized exports and retained project history. */
  privateUseConfirmed: boolean;
  publicRedistribution: boolean;
}
export interface GisPreviewRequest {
  scenarioId: string;
  expectedVersion: number;
  expectedRevision: number;
  idempotencyKey: string;
  conversion: GisRecipe;
  mapping: ImportMappingRecipe;
  source: ImportSourceDeclaration;
}
export interface GisPreviewBase {
  importId: string;
  previewHash: string;
  jobId: string;
  uploadId: string;
  projectId: string;
  scenarioId: string;
  expectedVersion: number;
  expectedRevision: number;
  baselineIdentity: BaselineIdentity;
  source: Source;
  warnings: string[];
  featureCount: number;
  extentChecked: true;
  expiresAt: string;
  changes: {
    added: number;
    updated: number;
    overlaps: { importedId: string; existingId: string; name: string }[];
  };
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
export type GisPreview = GisPreviewBase &
  (
    | { layer: "buildings"; buildings: Building[] }
    | { layer: "parcels" | "blocks"; parcels: Parcel[] }
  );
export interface GisCapacityDeclaration {
  mode: "fixed-capacity";
  environment: "local-development" | "deployment";
  statement: string;
}
export interface GisAttempt {
  number: number;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "failed" | "cancelled" | "interrupted";
  elapsedMilliseconds?: number;
  admission: {
    budgetPolicyVersion: number;
    period: string;
    incrementalExternalCents: 0;
    costModel: GisCapacityDeclaration;
  };
}
export interface GisJob {
  id: string;
  kind: "inspect" | "prepare" | "export-shapefile";
  projectId: string;
  scenarioId: string;
  projectVersion: number;
  scenarioRevision: number;
  baselineHash: string;
  version: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage:
    | "queued"
    | "validating"
    | "inspecting"
    | "converting"
    | "mapping"
    | "exporting"
    | "saving"
    | "complete";
  attempt: number;
  attempts: GisAttempt[];
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  upload?: {
    filename: string;
    format: GisFormat;
    sha256: string;
    bytes: number;
  };
  uploadId?: string;
  result?: {
    previewHash?: string;
    importId?: string;
    downloadHash?: string;
    downloadBytes?: number;
  };
  error?: { code: string; message: string; retryable: boolean };
}
export interface GisJobRecord extends GisJob {
  organizationId: string;
  userId: string;
  idempotencyKey: string;
  requestKeys: string[];
  requestHash: string;
  workerId?: string;
  leaseExpiresAt?: string;
  capacityToken?: string;
  recipe?: Omit<GisPreviewRequest, "idempotencyKey">;
  inspection?: GisInspection;
  /** Content identity of the private frozen report input, never an archive path. */
  exportSnapshot?: { sha256: string; bytes: number };
}
export interface GisCapabilities {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  formats: GisFormat[];
  limits: {
    uploadBytes: number;
    expandedBytes: number;
    features: number;
    vertices: number;
    queued: number;
    concurrency: 1;
    attempts: number;
    operationsPerAccountPerDay: number;
    archiveBytes: number;
  };
  costModel: GisCapacityDeclaration | null;
}
