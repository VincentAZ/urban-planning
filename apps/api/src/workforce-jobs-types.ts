import type {
  WorkforceRequest,
  WorkforceScenario,
  Project,
  Place,
  BaselineIdentity,
  ProjectAccess,
} from "@urban/core";
import type { RoutingIsochroneResult } from "./routing/index.js";

export interface WorkforceSourceIdentity {
  cohortPackHash: string;
  boundaryHash: string;
  manifestId: string;
  graphHash: string;
  profileHash: string;
  methodVersion: "workforce-1.0.2";
}
export interface WorkforceCapacityDeclaration {
  mode: "fixed-capacity";
  environment: "local-development" | "deployment";
  statement: string;
}
export interface WorkforceAttempt {
  number: number;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "failed" | "cancelled" | "interrupted";
  elapsedMilliseconds?: number;
  admission: {
    budgetPolicyVersion: number;
    period: string;
    incrementalExternalCents: 0;
    costModel: WorkforceCapacityDeclaration;
  };
}
export interface WorkforceJob {
  id: string;
  projectId: string;
  scenarioId: string;
  projectVersion: number;
  scenarioRevision: number;
  placeId: string;
  baselineHash: string;
  version: number;
  request: WorkforceRequest;
  sourceIdentity: WorkforceSourceIdentity;
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
  attempts: WorkforceAttempt[];
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
export interface WorkforceJobRecord extends WorkforceJob {
  organizationId: string;
  userId: string;
  idempotencyKey: string;
  requestKeys: string[];
  workerId?: string;
  leaseExpiresAt?: string;
  capacityToken?: string;
}
/** Append-only authoritative compact evidence. Raw routing rows remain in a bounded private archive. */
export interface WorkforceArtifactRecord {
  id: string;
  organizationId: string;
  projectId: string;
  jobId: string;
  createdAt: string;
  workforce: WorkforceScenario;
  contour: RoutingIsochroneResult;
  siteSnapMeters: number;
  rawFileHash: string;
  rawFileBytes: number;
}
export interface WorkforceJobResult {
  job: WorkforceJob;
  workforce: WorkforceScenario;
  contour: RoutingIsochroneResult;
  siteSnapMeters: number;
}
export interface WorkforceAdoptResponse {
  project: Project;
  baseline: Place;
  version: number;
  baselineIdentity: BaselineIdentity;
  organizationId: string;
  access: ProjectAccess;
}
export interface WorkforceCapabilities {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  region: {
    id: string;
    name: string;
    extent: [number, number, number, number];
  } | null;
  modes: { car: boolean; walk: boolean; transit: false };
  direction: "inbound";
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
    model: WorkforceCapacityDeclaration | null;
    perQueryProviderChargeCents: 0 | null;
    metered: false;
    externalChargesCapped: false;
    notes: string[];
  };
}
