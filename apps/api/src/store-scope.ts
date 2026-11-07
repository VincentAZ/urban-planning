import type { FastifyRequest } from "fastify";
import type { Place, Scenario } from "@urban/core";
import type { ProjectRecord, PublishedRecord } from "./store.js";
import { tokenHash } from "./security.js";
import type { GisJobRecord } from "./gis-jobs-types.js";
import type { WorkforceArtifactRecord } from "./workforce-jobs-types.js";

import type { AccessibilityArtifactRecord } from "./accessibility-jobs-types.js";

export const collections = [
  "fiscalProfiles",
  "mediaJobs",
  "mediaArtifacts",
  "floodSources",
  "accessibilityJobs",
  "accessibilityArtifacts",
  "identityChallenges",
  "identityInvitations",
  "identityOutbox",
  "users",
  "organizations",
  "memberships",
  "sessions",
  "projects",
  "fiscalStudyCreations",
  "audit",
  "comments",
  "published",
  "publicFeedback",
  "imports",
  "preparationJobs",
  "workforceJobs",
  "gisJobs",
  "workforceArtifacts",
  "trafficConfigs",
  "trafficUploads",
  "trafficJobs",
  "trafficArtifacts",
] as const;
export type CollectionName = (typeof collections)[number];
export type ViewName =
  | CollectionName
  | "fiscalProfileHeaders"
  | "identityOutboxHeaders"
  | "projectHeaders"
  | "publishedHeaders"
  | "workforceArtifactHeaders"
  | "accessibilityArtifactHeaders"
  | "gisJobHeaders"
  | "trafficConfigHeaders"
  | "trafficJobHeaders"
  | "trafficArtifactHeaders";
export type GisJobHeader = Omit<GisJobRecord, "inspection" | "recipe">;
export type AccessibilityArtifactHeader = Omit<
  AccessibilityArtifactRecord,
  "contour"
>;
export type WorkforceArtifactHeader = Omit<WorkforceArtifactRecord, "contour">;
export type EntityName =
  | CollectionName
  | "budget"
  | "preparationControl"
  | "nativeCapacity";
export type IndexField =
  | "id"
  | "organizationId"
  | "userId"
  | "projectId"
  | "snapshotId"
  | "email";
export type FilterValue =
  | string
  | string[]
  | { auth: "userId" | "organizationId" }
  | {
      from: ViewName;
      field: IndexField | "grantUserIds" | "configurationId" | "createdBy";
    };
export type StoreFilter = Partial<Record<IndexField, FilterValue>>;
/** Clauses are ORed; fields within a clause are ANDed. Empty clauses never select records. */
export type Selection =
  | { where: StoreFilter[] }
  | { all: true }
  | { append: true };
/** Selects separately credentialed capabilities; these are never derived from request bodies. */
export type StoreSecurityContext =
  | { mode: "auth"; purpose: "lookup"; email: string }
  | {
      mode: "auth";
      purpose: "register";
      email: string;
      userId: string;
      organizationId: string;
      sessionHash: string;
    }
  | {
      mode: "auth";
      purpose: "login";
      credentialVersion?: number;
      email: string;
      userId: string;
      sessionHash: string;
    }
  | {
      mode: "auth";
      purpose: "challenge-lookup";
      challengeId: string;
      tokenHash: string;
    }
  | {
      mode: "auth";
      purpose: "invitation-manage";
      email: string;
      userId: string;
    }
  | {
      mode: "auth";
      purpose: "challenge-issue";
      email: string;
      userId: string;
      credentialVersion: number;
      challengeId: string;
    }
  | {
      mode: "auth";
      purpose: "challenge-consume";
      email: string;
      userId: string;
      credentialVersion: number;
      challengeId: string;
      tokenHash: string;
    }
  | {
      mode: "auth";
      purpose: "password-change";
      email: string;
      userId: string;
      credentialVersion: number;
      expectedPasswordHash: string;
    }
  | {
      mode: "auth";
      purpose: "invitation-accept";
      email: string;
      userId: string;
      invitationId: string;
      invitationVersion: number;
      tokenHash: string;
    }
  | {
      mode: "worker";
      purpose:
        | "media"
        | "prep"
        | "budget"
        | "workforce"
        | "accessibility"
        | "gis"
        | "traffic"
        | "identity-mail";
      outboxId?: string;
      leaseToken?: string;
    };
export type StoreScope = Partial<Record<ViewName, Selection>> & {
  security?: StoreSecurityContext;
  auth?: { sessionHash?: string; userId?: string };
  /** Public bearer target; the database still checks publication revocation. */
  publicSnapshotId?: string;
  /** Recipient/project hints require independently verified owner authority in the database. */
  memberLookupEmail?: string;
  projectId?: string;
  budget?: true;
  preparationControl?: true;
  nativeCapacity?: true;
};
export type ProjectHeader = Omit<ProjectRecord, "project" | "baseline"> & {
  project: Pick<
    ProjectRecord["project"],
    "id" | "name" | "placeId" | "updatedAt" | "activeScenarioId"
  > & {
    scenarios: Pick<Scenario, "id" | "name" | "revision">[];
  };
};
export type PublishedHeader = Omit<
  PublishedRecord,
  "baseline" | "scenario" | "results" | "floodDataset" | "fiscalStudy"
> & {
  baseline: Pick<Place, "id" | "name" | "extentLabel" | "sources">;
  scenario: Pick<Scenario, "id" | "name" | "revision" | "sources">;
};
export function requestScope(
  request: FastifyRequest,
  scope: StoreScope = {},
): StoreScope {
  const token = request.cookies.urban_session;
  return {
    ...scope,
    auth: { sessionHash: token ? tokenHash(token) : undefined },
  };
}
export function backingCollection(view: ViewName): CollectionName {
  return view === "fiscalProfileHeaders"
    ? "fiscalProfiles"
    : view === "accessibilityArtifactHeaders"
      ? "accessibilityArtifacts"
      : view === "identityOutboxHeaders"
        ? "identityOutbox"
        : view === "trafficConfigHeaders"
          ? "trafficConfigs"
          : view === "trafficJobHeaders"
            ? "trafficJobs"
            : view === "trafficArtifactHeaders"
              ? "trafficArtifacts"
              : view === "projectHeaders"
                ? "projects"
                : view === "publishedHeaders"
                  ? "published"
                  : view === "gisJobHeaders"
                    ? "gisJobs"
                    : view === "workforceArtifactHeaders"
                      ? "workforceArtifacts"
                      : view;
}
