import type {
  BaselineIdentity,
  Place,
  Project,
  ProjectAccess,
  TrafficNetwork,
  TrafficPeriod,
  TrafficScenario,
  TrafficCSVMapping,
} from "@urban/core";
import type { TrafficArchiveReference } from "./archive.js";
import type {
  TrafficExperimentRequest,
  CapturedTrafficExperiment,
} from "./experiment.js";

export interface TrafficCapacityDeclaration {
  mode: "fixed-capacity";
  environment: "local-development" | "deployment";
  statement: string;
}
/** Complete study identity is independent of the planning/rendering road inventory. */
export interface TrafficPreparedIdentity {
  id: string;
  placeId: string;
  studyAreaHash: string;
  networkHash: string;
  inventoryHash: string;
  sourceEnvelope: [number, number, number, number];
  bufferMeters: number;
  methodVersion: string;
  workerHash: string;
}
export interface TrafficPreparedChoice {
  id: string;
  label: string;
  networkHash: string;
}
export interface TrafficUploadRecord {
  id: string;
  organizationId: string;
  projectId: string;
  userId: string;
  createdAt: string;
  filename: string;
  sourceId: string;
  sha256: string;
  bytes: number;
  rows: number;
  idempotencyKey: string;
  archive: TrafficArchiveReference;
}
export interface TrafficUploadBinding {
  uploadId: string;
  sourceId: string;
  mapping: TrafficCSVMapping;
  useAnalysisPeriod: boolean;
  kind: "observed" | "factored";
  batchId: string;
  /** Frozen clock defaults when this original file was first admitted. */
  period: TrafficPeriod;
}
/** Append-only reviewed configuration; retries always use these exact inputs. */
export interface TrafficConfigurationRecord {
  id: string;
  organizationId: string;
  projectId: string;
  scenarioId: string;
  userId: string;
  createdAt: string;
  projectVersion: number;
  scenarioRevision: number;
  baselineHash: string;
  roadEditsHash: string;
  prepared: TrafficPreparedIdentity;
  request: TrafficExperimentRequest;
  requestHash: string;
  uploadIds: string[];
  uploadBindings: TrafficUploadBinding[];
  idempotencyKey: string;
  /** Human review acknowledges independent explicit demand, not automatic planning-edit representation. */
  submissionHash: string;
  scopeAcknowledged: true;
}
export type TrafficConfigurationHeader = Omit<
  TrafficConfigurationRecord,
  "request"
>;
export interface TrafficAttempt {
  number: number;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "failed" | "cancelled" | "interrupted";
  elapsedMilliseconds?: number;
  admission: {
    budgetPolicyVersion: number;
    period: string;
    incrementalExternalCents: 0;
    costModel: TrafficCapacityDeclaration;
  };
}
export interface TrafficJob {
  id: string;
  projectId: string;
  scenarioId: string;
  configurationId: string;
  projectVersion: number;
  scenarioRevision: number;
  baselineHash: string;
  roadEditsHash: string;
  requestHash: string;
  prepared: TrafficPreparedIdentity;
  version: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage:
    | "queued"
    | "validating"
    | "simulating"
    | "evaluating"
    | "saving"
    | "complete";
  /** Stage progress only; never a completion-time forecast. */
  progress: number;
  attempt: number;
  attempts: TrafficAttempt[];
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  result?: {
    artifactId: string;
    captureHash: string;
    archive: TrafficArchiveReference;
  };
  error?: { code: string; message: string; retryable: boolean };
}
export interface TrafficJobRecord extends TrafficJob {
  organizationId: string;
  userId: string;
  idempotencyKey: string;
  requestKeys: string[];
  workerId?: string;
  leaseExpiresAt?: string;
  capacityToken?: string;
}
/** Compact immutable authority; raw graph/count/native files stay in the scoped private archive. */
export interface TrafficArtifactRecord {
  id: string;
  organizationId: string;
  projectId: string;
  scenarioId: string;
  jobId: string;
  configurationId: string;
  createdAt: string;
  traffic: TrafficScenario;
}
export type TrafficArtifactHeader = TrafficArtifactRecord;
export interface TrafficCapabilities {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  prepared: TrafficPreparedIdentity | null;
  limits: {
    queued: number;
    pendingPerAccount: number;
    startsPerAccountPerDay: number;
    attempts: number;
    concurrency: 1;
    runSeconds: number;
    uploadBytes: number;
    configurationBytes: number;
  };
  cost: {
    model: TrafficCapacityDeclaration | null;
    perRunProviderChargeCents: 0 | null;
    externalChargesCapped: false;
    notes: string[];
  };
  supported: {
    closures: true;
    directionalLanes: true;
    speed: true;
    geometry: false;
    signalTiming: boolean;
    turnRestrictions: false;
    pedestrians: false;
  };
}
export interface TrafficContext {
  capabilities: TrafficCapabilities;
  /** Explicit choices never replace an existing configuration's frozen graph. */
  preparedChoices: TrafficPreparedChoice[];
  /** CAS identity remains available when an explicitly selected graph differs. */
  latestConfigurationId: string | null;
  commutePresets?: import("./commute-evidence.js").TrafficCommutePresetView[];
  configuration: TrafficConfigurationRecord | null;
  network: TrafficNetwork | null;
  initialRequest: TrafficExperimentRequest | null;
  signalTimingEligibility?: import("./signal-effects.js").TrafficSignalTimingEligibility;
}
export interface TrafficJobResult {
  job: TrafficJob;
  traffic: TrafficScenario;
  /** Authorized detail response, never part of scenario history. */
  experiment: CapturedTrafficExperiment;
}
export interface TrafficAdoptResponse {
  project: Project;
  baseline: Place;
  version: number;
  baselineIdentity: BaselineIdentity;
  organizationId: string;
  access: ProjectAccess;
}
