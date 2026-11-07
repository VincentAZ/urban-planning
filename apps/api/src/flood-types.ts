import type {
  BaselineIdentity,
  FloodDataset,
  Place,
  Project,
  ProjectAccess,
} from "@urban/core";
export interface FloodSourceRecord {
  id: string;
  studyAreaHash: string;
  dataset: FloodDataset;
  registeredAt: string;
  sourceManifestHash: string;
}
export interface FloodCatalogChoice {
  id: string;
  label: string;
  datasetHash: string;
  studyAreaHash: string;
  capturedAt: string;
  bytes: number;
}
export interface FloodCatalogResponse {
  datasets: FloodCatalogChoice[];
}
export interface FloodDatasetResponse {
  datasetHash: string;
  dataset: FloodDataset;
}
export interface FloodAdoptResponse {
  project: Project;
  baseline: Place;
  baselineIdentity: BaselineIdentity;
  version: number;
  organizationId: string;
  access: ProjectAccess;
}
