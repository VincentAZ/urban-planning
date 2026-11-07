import type { MediaScene, MediaExportRecipe } from "@urban/core";
export interface MediaCapacityDeclaration {
  mode: "fixed-capacity";
  environment: "local-development" | "deployment";
  statement: string;
}
export interface MediaArchiveReference {
  sha256: string;
  bytes: number;
  fileCount: number;
}
export interface MediaFile {
  name: string;
  sha256: string;
  bytes: number;
  contentType: string;
}
export interface MediaAttempt {
  number: number;
  startedAt: string;
  endedAt?: string;
  outcome?: "completed" | "failed" | "cancelled" | "interrupted";
  elapsedMilliseconds?: number;
  admission: {
    budgetPolicyVersion: number;
    period: string;
    incrementalExternalCents: 0;
    costModel: MediaCapacityDeclaration;
  };
}
export interface MediaJob {
  id: string;
  projectId: string;
  scenarioId: string;
  projectVersion: number;
  scenarioRevision: number;
  baselineHash: string;
  sceneHash: string;
  recipe: MediaExportRecipe;
  requestHash: string;
  version: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage:
    | "queued"
    | "validating"
    | "rendering"
    | "encoding"
    | "verifying"
    | "saving"
    | "complete";
  completedFrames: number;
  totalFrames: number;
  attempt: number;
  attempts: MediaAttempt[];
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  result?: { artifactId: string; archiveHash: string; files: MediaFile[] };
  error?: { code: string; message: string; retryable: boolean };
}
export interface MediaJobRecord extends MediaJob {
  organizationId: string;
  userId: string;
  idempotencyKey: string;
  requestKeys: string[];
  workerId?: string;
  leaseExpiresAt?: string;
  capacityToken?: string;
  input: MediaArchiveReference;
  runtimeIdentity: MediaRuntimeIdentity;
}
export interface MediaJobsPage {
  jobs: MediaJob[];
  nextCursor: string | null;
}
export interface MediaArtifactRecord {
  id: string;
  organizationId: string;
  projectId: string;
  userId: string;
  jobId: string;
  createdAt: string;
  sceneHash: string;
  requestHash: string;
  runtimeIdentity: MediaRuntimeIdentity;
  archive: MediaArchiveReference;
  files: MediaFile[];
}
export interface MediaRuntimeIdentity {
  profileVersion: string;
  rendererHash: string;
  runtimeHash: string;
}
export interface MediaExecutionResult {
  files: Record<string, Uint8Array>;
  contentTypes: Record<string, string>;
}
export interface MediaExecutor {
  identity(): Promise<MediaRuntimeIdentity>;
  execute(input: {
    runtimeIdentity: MediaRuntimeIdentity;
    scene: MediaScene;
    recipe: MediaExportRecipe;
    signal: AbortSignal;
    onProgress: (
      stage: MediaJob["stage"],
      completedFrames: number,
    ) => Promise<void>;
  }): Promise<MediaExecutionResult>;
}
export interface MediaCapabilities {
  enabled: boolean;
  configured: boolean;
  reason: string | null;
  runtimeIdentity: MediaRuntimeIdentity | null;
  formats: ("png" | "mp4")[];
  audio: "none";
  limits: {
    queued: number;
    pendingPerAccount: number;
    startsPerAccountPerDay: number;
    attempts: number;
    concurrency: 1;
    runSeconds: number;
    archiveBytes: number;
  };
  cost: {
    model: MediaCapacityDeclaration | null;
    perExportProviderChargeCents: 0 | null;
    metered: false;
    notes: string[];
  };
}
export interface MediaContext {
  capabilities: MediaCapabilities;
  projectVersion: number;
  scenarioRevision: number;
  scene: MediaScene;
  sceneHash: string;
  defaultRecipe: MediaExportRecipe | null;
}
