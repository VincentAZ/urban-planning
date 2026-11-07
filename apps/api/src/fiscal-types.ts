import type { FiscalProfile, Project, ProjectAccess } from "@urban/core";

export interface FiscalProfileVersionHeader {
  id: string;
  organizationId: string;
  userId: string;
  profileId: string;
  version: number;
  previousVersionId: string | null;
  profileHash: string;
  name: string;
  jurisdictionName: string;
  fiscalYear: number;
  createdAt: string;
  idempotencyKey: string;
  submissionHash: string;
}
export interface FiscalProfileVersionRecord extends FiscalProfileVersionHeader {
  profile: FiscalProfile;
}
export type FiscalProfileVersionView = Omit<
  FiscalProfileVersionHeader,
  "organizationId" | "userId" | "idempotencyKey" | "submissionHash"
>;
export interface FiscalProfilesPage {
  profiles: FiscalProfileVersionView[];
  nextCursor: string | null;
}
export interface FiscalProfileResponse {
  version: FiscalProfileVersionView;
  profile: FiscalProfile;
}
export interface FiscalStudyCreationRecord {
  id: string;
  organizationId: string;
  userId: string;
  projectId: string;
  sourceProjectId: string;
  sourceVersion: number;
  sourceScenarioId: string;
  sourceRevision: number;
  idempotencyKey: string;
  submissionHash: string;
  profileHash: string;
  libraryVersionId?: string;
  createdAt: string;
}
export interface FiscalStudyResponse {
  baselineIdentity: import("@urban/core").BaselineIdentity;
  project: Project;
  version: number;
  organizationId: string;
  access: ProjectAccess;
}
