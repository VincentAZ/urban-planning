import type { MediaJobRecord, MediaArtifactRecord } from "./media-types.js";
import type {
  FiscalProfileVersionRecord,
  FiscalProfileVersionHeader,
  FiscalStudyCreationRecord,
} from "./fiscal-types.js";
import type {
  IdentityChallengeRecord,
  IdentityInvitationRecord,
  IdentityOutboxRecord,
} from "./identity-types.js";
import type { FloodSourceRecord } from "./flood-types";
import { randomUUID } from "node:crypto";
import {
  defaultNativeCapacity,
  type NativeCapacityState,
} from "./native-capacity.js";
import type {
  TrafficConfigurationRecord,
  TrafficConfigurationHeader,
  TrafficUploadRecord,
  TrafficJobRecord,
  TrafficArtifactRecord,
  TrafficArtifactHeader,
} from "./traffic/jobs-types.js";
import type {
  StoreScope,
  ProjectHeader,
  PublishedHeader,
  WorkforceArtifactHeader,
  AccessibilityArtifactHeader,
  GisJobHeader,
} from "./store-scope.js";
export { FileStore } from "./file-store.js";
import type {
  Place,
  Project,
  Scenario,
  ModelResults,
  Source,
  Building,
  Parcel,
} from "@urban/core";
import { ApiError, notFound } from "./errors.js";
import type { BudgetState } from "../../../packages/core/src/budget.js";
import { defaultBudgetState } from "./budget.js";
import type {
  WorkforceJobRecord,
  WorkforceArtifactRecord,
} from "./workforce-jobs-types.js";
import type {
  AccessibilityJobRecord,
  AccessibilityArtifactRecord,
} from "./accessibility-jobs-types.js";
import type { GisJobRecord } from "./gis-jobs-types.js";
import { projectAccess, type ProjectAcl } from "./project-access.js";
import type {
  ReviewTarget,
  ReviewReply,
} from "../../../packages/core/src/collaboration.js";
import type {
  PreparationRecord,
  PreparationControl,
} from "./national-preparation.js";

import type {
  PublicEngagement,
  EngagementModeration,
} from "../../../packages/core/src/engagement.js";

export type Role = "owner" | "editor" | "commenter" | "viewer";
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  /** Present only in trusted credential lookup/migration; ordinary profile reads omit it. */
  passwordHash?: string;
  createdAt: string;
  emailVerifiedAt?: string;
  /** Missing on legacy accounts means generation zero; never backfilled by reads. */
  credentialVersion?: number;
}
export interface OrganizationRecord {
  id: string;
  name: string;
  createdAt: string;
}
export interface MembershipRecord {
  userId: string;
  organizationId: string;
  role: Role;
  scope?: "workspace" | "project-only";
}
export interface SessionRecord {
  hash: string;
  csrfToken: string;
  credentialVersion?: number;
  userId: string;
  organizationId: string;
  expiresAt: string;
}
export interface ProjectRecord {
  organizationId: string;
  project: Project;
  version: number;
  baseline: Place;
  createdBy: string;
  createdAt: string;
  /** Missing ACL preserves the documented legacy workspace-sharing behavior. */
  acl?: ProjectAcl;
}
export interface AuditRecord {
  id: string;
  organizationId: string;
  projectId?: string;
  actorId: string;
  action: string;
  at: string;
  details: Record<string, unknown>;
}
export interface CommentRecord {
  id: string;
  projectId: string;
  organizationId: string;
  actorId: string;
  author: string;
  text: string;
  scenarioId: string;
  target?:
    | ReviewTarget
    | {
        kind: "building" | "metric" | "location";
        id?: string;
        position?: [number, number];
      };
  createdAt: string;
  scenarioRevision?: number;
  projectVersion?: number;
  idempotencyKey?: string;
  targetLabel?: string;
  targetPosition?: [number, number];
  resolved?: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  threadVersion?: number;
  replies?: (ReviewReply & {
    idempotencyKey: string;
    projectVersion: number;
  })[];
}
export interface PublishedRecord {
  fiscalStudy?: import("@urban/core").FiscalStudy;
  floodDataset?: import("@urban/core").FloodDataset;
  id: string;
  organizationId: string;
  projectId: string;
  projectName: string;
  placeId: string;
  baseline: Place;
  scenario: Scenario;
  results: ModelResults;
  createdAt: string;
  revokedAt?: string;
  feedbackEnabled: boolean;
  engagement?: PublicEngagement;
  /** Explicit-config publications require version/idempotency inputs; old callers remain compatible. */
  engagementRequiresVersion?: boolean;
}
export interface PublicFeedbackRecord {
  id: string;
  snapshotId: string;
  userId: string;
  kind: "comment" | "vote" | "survey";
  text?: string;
  vote?: "support" | "concern" | "neutral";
  position?: [number, number];
  answers?: Record<string, string>;
  createdAt: string;
  supersededAt?: string;
  idempotencyKey?: string;
  requestHash?: string;
  moderation?: EngagementModeration;
}
interface ImportRecordBase {
  id: string;
  organizationId: string;
  projectId?: string;
  createdBy: string;
  source: Source;
  warnings: string[];
  createdAt: string;
  expiresAt: string;
  /** Immutable prepared preview binding; absent only on legacy GeoJSON previews. */
  prepared?: {
    preview: Omit<
      import("./gis-jobs-types.js").GisPreviewBase,
      "source" | "warnings" | "importId"
    >;
    mode: "append" | "match";
  };
  committed?: {
    projectId: string;
    scenarioId: string;
    revision: number;
    version: number;
    at: string;
  };
}
export type ImportRecord = ImportRecordBase &
  (
    | { layer?: "buildings"; buildings: Building[] }
    | { layer: "parcels" | "blocks"; parcels: Parcel[] }
  );
export interface DataState {
  floodSources: FloodSourceRecord[];
  schemaVersion: 1;
  identityChallenges: IdentityChallengeRecord[];
  identityInvitations: IdentityInvitationRecord[];
  identityOutbox: IdentityOutboxRecord[];
  identityOutboxHeaders: Omit<IdentityOutboxRecord, "sealed">[];
  users: UserRecord[];
  organizations: OrganizationRecord[];
  memberships: MembershipRecord[];
  sessions: SessionRecord[];
  projects: ProjectRecord[];
  audit: AuditRecord[];
  comments: CommentRecord[];
  published: PublishedRecord[];
  publicFeedback: PublicFeedbackRecord[];
  imports: ImportRecord[];
  budget: BudgetState;
  preparationJobs: PreparationRecord[];
  preparationControl: PreparationControl;
  workforceJobs: WorkforceJobRecord[];
  mediaJobs: MediaJobRecord[];
  fiscalProfiles: FiscalProfileVersionRecord[];
  fiscalProfileHeaders: FiscalProfileVersionHeader[];
  fiscalStudyCreations: FiscalStudyCreationRecord[];
  mediaArtifacts: MediaArtifactRecord[];
  accessibilityJobs: AccessibilityJobRecord[];
  accessibilityArtifacts: AccessibilityArtifactRecord[];
  accessibilityArtifactHeaders: AccessibilityArtifactHeader[];
  gisJobs: GisJobRecord[];
  trafficConfigs: TrafficConfigurationRecord[];
  trafficConfigHeaders: TrafficConfigurationHeader[];
  trafficUploads: TrafficUploadRecord[];
  trafficJobs: TrafficJobRecord[];
  trafficJobHeaders: TrafficJobRecord[];
  trafficArtifacts: TrafficArtifactRecord[];
  trafficArtifactHeaders: TrafficArtifactHeader[];
  nativeCapacity: NativeCapacityState;
  gisJobHeaders: GisJobHeader[];
  workforceArtifacts: WorkforceArtifactRecord[];
  /** Explicit, small projections. They are derived, never part of the legacy document. */
  projectHeaders: ProjectHeader[];
  publishedHeaders: PublishedHeader[];
  workforceArtifactHeaders: WorkforceArtifactHeader[];
}
// Older documents acquire the default budget through the existing emptyState merge, without modifying projects or published baselines.
export const emptyState = (): DataState => ({
  floodSources: [],
  schemaVersion: 1,
  identityChallenges: [],
  identityInvitations: [],
  identityOutbox: [],
  identityOutboxHeaders: [],
  users: [],
  organizations: [],
  memberships: [],
  sessions: [],
  projects: [],
  audit: [],
  comments: [],
  published: [],
  publicFeedback: [],
  imports: [],
  budget: defaultBudgetState(),
  preparationJobs: [],
  preparationControl: { requests: [], lastSourceRequestAt: null },
  workforceJobs: [],
  mediaJobs: [],
  fiscalProfiles: [],
  fiscalProfileHeaders: [],
  fiscalStudyCreations: [],
  mediaArtifacts: [],
  accessibilityJobs: [],
  accessibilityArtifacts: [],
  accessibilityArtifactHeaders: [],
  gisJobs: [],
  trafficConfigs: [],
  trafficConfigHeaders: [],
  trafficUploads: [],
  trafficJobs: [],
  trafficJobHeaders: [],
  trafficArtifacts: [],
  trafficArtifactHeaders: [],
  nativeCapacity: defaultNativeCapacity(),
  gisJobHeaders: [],
  workforceArtifacts: [],
  projectHeaders: [],
  publishedHeaders: [],
  workforceArtifactHeaders: [],
});
export interface Store {
  kind: "memory" | "development-file" | "postgres";
  /** Database triggers prune project-only memberships and retarget foreign sessions atomically. */
  managesMembershipPruning?: boolean;
  read<T>(operation: (state: DataState) => T, scope?: StoreScope): Promise<T>;
  transaction<T>(
    operation: (state: DataState) => T,
    scope?: StoreScope,
  ): Promise<T>;
  close(): Promise<void>;
}

export function authorize(
  state: DataState,
  sessionHash: string | undefined,
  roles?: Role[],
) {
  const session = state.sessions.find(
    (s) =>
      s.hash === sessionHash && new Date(s.expiresAt).getTime() > Date.now(),
  );
  if (!session)
    throw new ApiError(
      401,
      "AUTH_REQUIRED",
      "Sign in to your free account to continue.",
    );
  const user = state.users.find((u) => u.id === session.userId);
  const organization = state.organizations.find(
    (o) => o.id === session.organizationId,
  );
  const membership = state.memberships.find(
    (m) =>
      m.userId === session.userId &&
      m.organizationId === session.organizationId,
  );
  if (
    !user ||
    !organization ||
    !membership ||
    (user.credentialVersion ?? 0) !== (session.credentialVersion ?? 0)
  )
    throw new ApiError(
      401,
      "AUTH_REQUIRED",
      "Your session is no longer valid. Please sign in again.",
    );
  if (
    roles &&
    (membership.scope === "project-only" || !roles.includes(membership.role))
  )
    throw new ApiError(
      403,
      "ROLE_REQUIRED",
      "Your workspace role does not permit this action.",
    );
  return { session, user, organization, membership };
}
export function findProject(
  state: DataState,
  organizationId: string,
  projectId: string,
  userId: string,
  roles?: Role[],
) {
  const record = state.projects.find(
    (p) => p.project.id === projectId && p.organizationId === organizationId,
  );
  const membership = state.memberships.find(
    (m) => m.organizationId === organizationId && m.userId === userId,
  );
  const access =
    record && membership ? projectAccess(record, userId, membership) : null;
  if (!record || !access) throw notFound();
  if (roles && !roles.includes(access.role))
    throw new ApiError(
      403,
      "PROJECT_ROLE_REQUIRED",
      "Your role on this project does not permit this action.",
    );
  return record;
}
export function addAudit(
  state: DataState,
  fields: Omit<AuditRecord, "id" | "at">,
) {
  state.audit.push({
    ...fields,
    id: randomUUID(),
    at: new Date().toISOString(),
  });
}
