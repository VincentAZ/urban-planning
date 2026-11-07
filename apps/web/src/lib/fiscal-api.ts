import type { FiscalProfile } from "@urban/core";
import { api } from "./api";
import type {
  FiscalProfilesPage,
  FiscalProfileResponse,
  FiscalStudyResponse,
} from "../../../api/src/fiscal-types";
export type {
  FiscalProfilesPage,
  FiscalProfileResponse,
  FiscalProfileVersionView,
  FiscalStudyResponse,
} from "../../../api/src/fiscal-types";
const encoded = encodeURIComponent;
export interface FiscalProfileSubmission {
  profile: FiscalProfile;
  profileId?: string;
  expectedLatestVersionId?: string | null;
  idempotencyKey: string;
}
export const fiscalApi = {
  list: (cursor?: string, signal?: AbortSignal) =>
    api<FiscalProfilesPage>(
      `/fiscal-profiles${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,
      { cache: "no-store", signal },
    ),
  versions: (id: string, cursor?: string, signal?: AbortSignal) =>
    api<FiscalProfilesPage>(
      `/fiscal-profiles/${encoded(id)}/versions${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,
      { cache: "no-store", signal },
    ),
  read: (profileId: string, versionId: string, signal?: AbortSignal) =>
    api<FiscalProfileResponse>(
      `/fiscal-profiles/${encoded(profileId)}/versions/${encoded(versionId)}`,
      { cache: "no-store", signal },
    ),
  save: (body: FiscalProfileSubmission, signal?: AbortSignal) =>
    api<FiscalProfileResponse>("/fiscal-profiles", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  createStudy: (
    projectId: string,
    body: {
      scenarioId: string;
      expectedVersion: number;
      expectedRevision: number;
      name: string;
      idempotencyKey: string;
      applicabilityNotes: string;
    } & (
      | { profile: FiscalProfile; libraryVersionId?: never }
      | { libraryVersionId: string; profile?: never }
    ),
    signal?: AbortSignal,
  ) =>
    api<FiscalStudyResponse>(`/projects/${encoded(projectId)}/fiscal-studies`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
};
