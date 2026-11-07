import type {
  BaselineIdentity,
  HousingIncomeLimitPack,
  Place,
  Project,
  ProjectAccess,
} from "@urban/core";

export interface HousingSourceRecord {
  id: string;
  pack: HousingIncomeLimitPack;
  registeredAt: string;
  sourceManifestHash: string;
}
export interface HousingCatalogChoice {
  packHash: string;
  area: HousingIncomeLimitPack["area"];
  fiscalYear: number;
  effectiveDate: string;
}
export interface HousingCatalogResponse {
  version: 1;
  catalogHash: string;
  areas: HousingCatalogChoice[];
  nextCursor: string | null;
}
export interface HousingPackResponse {
  packHash: string;
  pack: HousingIncomeLimitPack;
}
export interface HousingAdoptResponse {
  project: Project;
  baseline: Place;
  baselineIdentity: BaselineIdentity;
  version: number;
  organizationId: string;
  access: ProjectAccess;
}
