import type {
  AccessibilityRequest,
  AccessibilityModeEvidence,
  Project,
  Place,
  BaselineIdentity,
  ProjectAccess,
} from "@urban/core";
import type { RoutingIsochroneResult } from "./routing/index.js";

export interface AccessibilitySourceIdentity {
  jobsPackHash: string;
  boundaryHash: string;
  manifestId: string;
  graphHash: string;
  profileHash: string;
  methodVersion: "accessibility-1.0.0";
}
export interface AccessibilityCapacityDeclaration {
  mode: "fixed-capacity";
  environment: "local-development" | "deployment";
  statement: string;
}
export interface AccessibilityAttempt {
  number: number;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "failed" | "cancelled" | "interrupted";
  elapsedMilliseconds?: number;
  admission: {
    budgetPolicyVersion: number;
    period: string;
    incrementalExternalCents: 0;
    costModel: AccessibilityCapacityDeclaration;
  };
}
export interface AccessibilityJob {
  id: string;
  projectId: string;
  scenarioId: string;
  projectVersion: number;
  scenarioRevision: number;
  placeId: string;
  baselineHash: string;
  version: number;
  request: AccessibilityRequest;
  sourceIdentity: AccessibilitySourceIdentity;
  queryHash: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage:
    | "queued"
    | "validating"
    | "routing"
    | "aggregating"
    | "contours"
    | "saving"
    | "complete";
  /** Coarse stage progress, not an estimated completion time. */
  progress: number;
  attempt: number;
  attempts: AccessibilityAttempt[];
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  result?: {
    artifactId: string;
    resultHash: string;
    inputHash: string;
    captureHash: string;
  };
  error?: { code: string; message: string; retryable: boolean };
}
export interface AccessibilityJobRecord extends AccessibilityJob {
  organizationId: string;
  userId: string;
  idempotencyKey: string;
  requestKeys: string[];
  workerId?: string;
  leaseExpiresAt?: string;
  capacityToken?: string;
}
/** Append-only authoritative compact evidence. Raw routing rows remain in a bounded private archive. */
export interface AccessibilityArtifactRecord {
  /** Older feature artifacts derive this only from the linked completed job. New writes always retain it. */
  scenarioId?: string;
  id: string;
  organizationId: string;
  projectId: string;
  jobId: string;
  createdAt: string;
  accessibility: AccessibilityModeEvidence;
  contour: RoutingIsochroneResult<"outbound">;
  siteSnapMeters: number;
  rawFileHash: string;
  rawFileBytes: number;
}
export interface AccessibilityJobResult {
  job: AccessibilityJob;
  accessibility: AccessibilityModeEvidence;
  contour: RoutingIsochroneResult<"outbound">;
  siteSnapMeters: number;
}
export interface AccessibilityAdoptResponse {
  project: Project;
  baseline: Place;
  version: number;
  baselineIdentity: BaselineIdentity;
  organizationId: string;
  access: ProjectAccess;
}
export interface AccessibilityCapabilities {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  region: {
    id: string;
    name: string;
    extent: [number, number, number, number];
  } | null;
  source?: {
    jobsPackHash: string;
    vintage: number;
    jobType: "JT01";
    unit: "primary jobs";
    workplaceBlocks: number;
    primaryJobs: number;
  } | null;
  sourceIdentities?: {
    car: AccessibilitySourceIdentity;
    walk: AccessibilitySourceIdentity;
  } | null;
  modes: { car: boolean; walk: boolean; transit: false };
  direction: "outbound";
  thresholdsMinutes: [15, 30, 45];
  limits: {
    queued: number;
    pendingPerAccount: number;
    startsPerAccountPerDay: number;
    attempts: number;
    concurrency: 1;
    runSeconds: number;
  };
  cost: {
    model: AccessibilityCapacityDeclaration | null;
    perQueryProviderChargeCents: 0 | null;
    metered: false;
    externalChargesCapped: false;
    notes: string[];
  };
}
