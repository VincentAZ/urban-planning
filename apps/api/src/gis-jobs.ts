import {
  acquireNativeCapacity,
  assertNativeCapacityAvailable,
  heartbeatNativeCapacity,
  releaseNativeCapacity,
  quarantineNativeCapacity,
} from "./native-capacity.js";
import { createHash, randomUUID } from "node:crypto";
import {
  baselineIdentity,
  canonicalJSON,
  type Place,
  type Scenario,
  type FloodDatasetCatalog,
} from "@urban/core";
import { ApiError } from "./errors.js";
import {
  addAudit,
  findProject,
  type DataState,
  type Store,
  type authorize,
  type ImportRecord,
} from "./store.js";
import { findProjectHeader, projectAccess } from "./project-access.js";
import type { StoreScope } from "./store-scope.js";
import { assertBudgetCostEvidence, budgetDashboard } from "./budget.js";
import {
  GisArchive,
  GIS_ARCHIVE_BYTES,
  type StagedGisFile,
  type GisArchivePublication,
} from "./gis-archive.js";
import { GisRuntime } from "./gis-runtime.js";
import { prepareFloodGisInWorker } from "./flood-normalization-worker";
import { assertFloodExport } from "./flood-validation";
import { exportScenarioShapefile } from "./gis-shapefile.js";
import { GIS_LIMITS, type GisInspection } from "./gis-types.js";
import {
  gisPreviewRequestSchema,
  gisSubmissionSchema,
  prepareGisPreview,
} from "./gis-import-mapping.js";
import { prepareGisPreviewInWorker } from "./gis-mapping-worker.js";
import type {
  GisCapabilities,
  GisCapacityDeclaration,
  GisJob,
  GisJobRecord,
  GisPreview,
  GisPreviewRequest,
} from "./gis-jobs-types.js";

export const GIS_JOB_LIMITS = {
  queued: 10,
  concurrency: 1 as const,
  attempts: 3,
  operationsPerAccountPerDay: 30,
  retainedJobs: 10000,
};
type Authenticate = (state: DataState) => ReturnType<typeof authorize>;
type Submission = {
  scenarioId: string;
  expectedVersion: number;
  expectedRevision: number;
  idempotencyKey: string;
};
type FrozenExport = {
  floodDatasets?: FloodDatasetCatalog;
  place: Place;
  scenario: Scenario;
  projectId: string;
  projectVersion: number;
  baselineHash: string;
  generatedAt: string;
};
type GisExecutor = Pick<
  GisRuntime,
  "available" | "inspect" | "normalize" | "exportShapefile"
>;
const worker = { mode: "worker", purpose: "gis" } as const;
const roles = ["owner", "editor"] as const;
const nowISO = () => new Date().toISOString();
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
const pending = (job: GisJobRecord) =>
  job.status === "queued" || job.status === "running";
const cancelled = () =>
  new ApiError(
    409,
    "GIS_CANCELLED",
    "GIS processing was cancelled or project access was revoked.",
  );
export function publicGisJob(record: GisJobRecord): GisJob {
  const {
    organizationId: _o,
    userId: _u,
    idempotencyKey: _i,
    requestKeys: _k,
    requestHash: _h,
    workerId: _w,
    leaseExpiresAt: _l,
    capacityToken: _c,
    recipe: _r,
    inspection: _n,
    exportSnapshot: _e,
    ...job
  } = record;
  return structuredClone(job);
}
export function stagedGisPreview(staged: ImportRecord): GisPreview {
  if (!staged.prepared)
    throw new ApiError(404, "NOT_FOUND", "Prepared GIS preview not found.");
  const base = {
    ...staged.prepared.preview,
    importId: staged.id,
    source: staged.source,
    warnings: staged.warnings,
  };
  const preview: GisPreview =
    "parcels" in staged
      ? { ...base, layer: staged.layer, parcels: staged.parcels }
      : { ...base, layer: "buildings", buildings: staged.buildings };
  const { previewHash, ...content } = preview;
  if (hash(content) !== previewHash)
    throw new ApiError(
      503,
      "GIS_PREVIEW_CHANGED",
      "The prepared preview failed its content check. Prepare a new preview; no layer was applied.",
    );
  return preview;
}
function canEdit(state: DataState, job: GisJobRecord) {
  const project = state.projectHeaders.find(
    (p) =>
      p.project.id === job.projectId && p.organizationId === job.organizationId,
  );
  const member = state.memberships.find(
    (m) => m.userId === job.userId && m.organizationId === job.organizationId,
  );
  return Boolean(
    project &&
      member &&
      projectAccess(project, job.userId, member)?.canEdit &&
      project.project.scenarios.some((s) => s.id === job.scenarioId),
  );
}
function assertVersion(
  record: {
    version: number;
    project: { scenarios: { id: string; revision: number }[] };
  },
  input: Submission,
) {
  const scenario = record.project.scenarios.find(
    (s) => s.id === input.scenarioId,
  );
  if (!scenario || scenario.id === "baseline")
    throw new ApiError(
      400,
      "GIS_SCENARIO_REQUIRED",
      "Choose a saved editable proposal scenario.",
    );
  if (
    record.version !== input.expectedVersion ||
    scenario.revision !== input.expectedRevision
  )
    throw new ApiError(
      409,
      "REVISION_CONFLICT",
      "The saved project changed. Save or reload it, then prepare a new GIS request.",
    );
}
function admission(
  state: DataState,
  declaration: GisCapacityDeclaration | undefined,
) {
  if (
    !declaration ||
    declaration.mode !== "fixed-capacity" ||
    declaration.statement.trim().length < 12
  )
    throw new ApiError(
      503,
      "GIS_COST_MODEL_UNCONFIGURED",
      "An operator must declare existing fixed GIS processing capacity before jobs can start.",
    );
  const budget = budgetDashboard(state.budget);
  if (state.budget.policy.paidOperationsPaused)
    throw new ApiError(
      503,
      "GIS_CAPACITY_PAUSED",
      "Costly processing is paused by the platform administrator. Existing files remain available.",
    );
  assertBudgetCostEvidence(state.budget);
  if (budget.totals.availableCents <= 0)
    throw new ApiError(
      429,
      "GIS_BUDGET_EXHAUSTED",
      "The operating budget has no safe headroom for another GIS attempt.",
    );
  if (
    declaration.environment === "deployment" &&
    state.budget.policy.fixedCostReserveCents <= 0 &&
    budget.totals.recordedFixedCents <= 0
  )
    throw new ApiError(
      503,
      "GIS_FIXED_COST_UNRECORDED",
      "Record or reserve fixed deployment hosting costs before admitting GIS work.",
    );
  return {
    budgetPolicyVersion: state.budget.policy.version,
    period: budget.period,
    incrementalExternalCents: 0 as const,
    costModel: structuredClone(declaration),
  };
}
function failure(error: unknown, retryable = true) {
  const safe = error instanceof ApiError;
  return {
    code: safe ? error.code : "GIS_FAILED",
    message: safe
      ? error.message
      : "GIS processing could not be completed or verified. No partial layer was applied.",
    retryable:
      retryable &&
      !(
        safe &&
        ([400, 403, 404, 413, 422].includes(error.statusCode) ||
          ["REVISION_CONFLICT", "GIS_BASELINE_CHANGED"].includes(error.code))
      ),
  };
}
function exportRights(place: Place, scenario: Scenario) {
  const denied = [...place.sources, ...(scenario.sources ?? [])].filter(
    (s) => s.rights && !s.rights.export,
  );
  if (denied.length)
    throw new ApiError(
      422,
      "SOURCE_EXPORT_RESTRICTED",
      `Export permission is missing for: ${denied.map((s) => s.name).join(", ")}.`,
    );
}

export class GisJobService {
  readonly archive: GisArchive;
  private workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private controller?: AbortController;
  private activeJobId?: string;
  private stopped = false;
  private running = false;
  constructor(
    readonly store: Store,
    readonly options: {
      enabled: boolean;
      runtime?: GisExecutor;
      archiveDirectory: string;
      capacity?: GisCapacityDeclaration;
      automaticWorker?: boolean;
    },
  ) {
    this.archive = new GisArchive(options.archiveDirectory);
  }
  async capabilities(): Promise<GisCapabilities> {
    const configured = Boolean(this.options.runtime && this.options.capacity);
    let reason: string | null = null;
    if (!this.options.enabled)
      reason =
        "New GIS jobs are disabled on this server. Saved previews and artifacts remain available.";
    else if (!configured)
      reason =
        "The operator has not configured the pinned offline converter and fixed processing capacity.";
    else
      try {
        const runtime = await this.options.runtime!.available();
        if (!runtime.available) reason = runtime.reason;
        else
          await this.store.read(
            (s) => {
              assertNativeCapacityAvailable(s);
              return admission(s, this.options.capacity);
            },
            {
              security: worker,
              budget: true,
              nativeCapacity: true,
            },
          );
      } catch (error) {
        reason = failure(error).message;
      }
    return {
      enabled: this.options.enabled && configured && !reason,
      configured,
      reason,
      formats: ["geojson", "shapefile", "dxf"],
      limits: {
        uploadBytes: GIS_LIMITS.inputBytes,
        expandedBytes: GIS_LIMITS.expandedBytes,
        features: GIS_LIMITS.features,
        vertices: GIS_LIMITS.vertices,
        queued: GIS_JOB_LIMITS.queued,
        concurrency: 1,
        attempts: GIS_JOB_LIMITS.attempts,
        operationsPerAccountPerDay: GIS_JOB_LIMITS.operationsPerAccountPerDay,
        archiveBytes: GIS_ARCHIVE_BYTES,
      },
      costModel: this.options.capacity ?? null,
    };
  }
  private enabled() {
    if (
      !this.options.enabled ||
      !this.options.runtime ||
      !this.options.capacity
    )
      throw new ApiError(
        503,
        "GIS_DISABLED",
        "The bounded GIS worker is not enabled and configured on this server.",
      );
  }
  private callerScope(
    projectId: string,
    sessionHash: string,
    global = false,
  ): StoreScope {
    return {
      auth: { sessionHash },
      projectId,
      ...(global ? { security: worker, budget: true } : {}),
      projectHeaders: {
        where: [{ id: projectId, organizationId: { auth: "organizationId" } }],
      },
      gisJobHeaders: global
        ? { all: true }
        : { where: [{ projectId, userId: { auth: "userId" } }] },
      audit: { append: true },
    };
  }
  private workerScope(id?: string, full = false): StoreScope {
    const view = full ? "gisJobs" : "gisJobHeaders";
    return {
      security: worker,
      nativeCapacity: true,
      [view]: id ? { where: [{ id }] } : { all: true },
      projectHeaders: {
        where: [{ id: { from: view, field: "projectId" } }],
      },
      memberships: {
        where: [{ userId: { from: view, field: "userId" } }],
      },
      budget: true,
    };
  }
  private queueCapacity(state: DataState, userId: string, exceptId?: string) {
    if (!exceptId && state.gisJobHeaders.length >= GIS_JOB_LIMITS.retainedJobs)
      throw new ApiError(
        503,
        "GIS_HISTORY_FULL",
        "GIS job history needs operator archival before accepting new work.",
      );
    const queued = state.gisJobHeaders.filter(
      (j) => pending(j) && j.id !== exceptId,
    );
    if (queued.some((j) => j.userId === userId))
      throw new ApiError(
        429,
        "GIS_ALREADY_PENDING",
        "This account already has a queued or running GIS job.",
      );
    if (queued.length >= GIS_JOB_LIMITS.queued)
      throw new ApiError(
        429,
        "GIS_QUEUE_FULL",
        "The bounded GIS queue is full. Try again later.",
      );
    const day = nowISO().slice(0, 10),
      attempts = state.gisJobHeaders
        .filter((j) => j.userId === userId)
        .flatMap((j) => j.attempts)
        .filter((a) => a.startedAt.startsWith(day)).length;
    if (attempts >= GIS_JOB_LIMITS.operationsPerAccountPerDay)
      throw new ApiError(
        429,
        "GIS_DAILY_LIMIT",
        "This account has used its 30 GIS processing attempts for this UTC day, including failed and cancelled attempts.",
      );
  }
  async preflightUpload(
    projectId: string,
    input: Submission,
    authenticate: Authenticate,
    sessionHash: string,
  ): Promise<void> {
    const checked = gisSubmissionSchema.parse(input);
    await this.store.read(
      (state) => {
        const identity = authenticate(state),
          project = findProjectHeader(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            [...roles],
          );
        const existing = state.gisJobHeaders.find(
          (job) =>
            job.projectId === projectId &&
            job.userId === identity.user.id &&
            job.requestKeys.includes(checked.idempotencyKey),
        );
        if (existing) {
          if (
            existing.kind !== "inspect" ||
            existing.scenarioId !== checked.scenarioId ||
            existing.projectVersion !== checked.expectedVersion ||
            existing.scenarioRevision !== checked.expectedRevision
          )
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This request key belongs to different GIS inputs.",
            );
          return;
        }
        this.enabled();
        assertVersion(project, checked);
        admission(state, this.options.capacity);
        this.queueCapacity(state, identity.user.id);
      },
      this.callerScope(projectId, sessionHash, true),
    );
  }
  async uploadReferenced(
    organizationId: string,
    projectId: string,
    sha256: string,
  ): Promise<boolean> {
    try {
      return await this.store.read(
        (state) =>
          state.gisJobHeaders.some(
            (job) =>
              job.upload?.sha256 === sha256 ||
              job.exportSnapshot?.sha256 === sha256 ||
              job.result?.downloadHash === sha256,
          ),
        {
          security: worker,
          gisJobHeaders: { where: [{ organizationId, projectId }] },
        },
      );
    } catch {
      return true;
    } // Unknown commit outcome must retain potentially referenced evidence.
  }
  async enqueue(
    projectId: string,
    kind: GisJob["kind"],
    input: Submission,
    details: {
      upload?: GisJobRecord["upload"];
      uploadId?: string;
      recipe?: GisPreviewRequest;
    },
    authenticate: Authenticate,
    sessionHash: string,
  ) {
    input = gisSubmissionSchema.parse(input);
    const recipe = details.recipe
      ? gisPreviewRequestSchema.parse(details.recipe)
      : undefined;
    if (
      (kind === "inspect" && !details.upload) ||
      (kind === "prepare" && (!details.uploadId || !recipe))
    )
      throw new ApiError(
        400,
        "GIS_INPUT_REQUIRED",
        "Required GIS input is missing.",
      );
    if (
      recipe &&
      (recipe.scenarioId !== input.scenarioId ||
        recipe.expectedVersion !== input.expectedVersion ||
        recipe.expectedRevision !== input.expectedRevision)
    )
      throw new ApiError(
        400,
        "GIS_INPUT_MISMATCH",
        "GIS mapping and request revisions disagree.",
      );
    const { idempotencyKey: _key, ...recipeBody } = recipe ?? {};
    const requestHash = hash({
      kind,
      scenarioId: input.scenarioId,
      expectedVersion: input.expectedVersion,
      expectedRevision: input.expectedRevision,
      upload: details.upload ?? null,
      uploadId: details.uploadId ?? null,
      recipe: recipe ? recipeBody : null,
    });
    const captured = await this.store.read(
      (state) => {
        const identity = authenticate(state),
          project = findProject(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            [...roles],
          );
        const existing = state.gisJobHeaders.find(
          (j) =>
            j.userId === identity.user.id &&
            j.projectId === projectId &&
            j.requestKeys.includes(input.idempotencyKey),
        );
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This key belongs to different GIS inputs.",
            );
          return { existing };
        }
        assertVersion(project, input);
        const upload = details.uploadId
          ? state.gisJobHeaders.find(
              (j) =>
                j.id === details.uploadId &&
                j.projectId === projectId &&
                j.organizationId === identity.organization.id &&
                j.userId === identity.user.id &&
                j.kind === "inspect" &&
                j.status === "completed",
            )
          : undefined;
        if (kind === "prepare" && !upload)
          throw new ApiError(
            404,
            "GIS_UPLOAD_NOT_READY",
            "A completed inspected upload owned by this account is required.",
          );
        return { project, identity, upload };
      },
      {
        auth: { sessionHash },
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
        gisJobHeaders: { where: [{ projectId, userId: { auth: "userId" } }] },
      },
    );
    if (captured.existing) return publicGisJob(captured.existing);
    this.enabled();
    await this.store.read(
      (state) => {
        const identity = authenticate(state),
          project = findProjectHeader(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            [...roles],
          );
        assertVersion(project, input);
        admission(state, this.options.capacity);
        this.queueCapacity(state, identity.user.id);
      },
      this.callerScope(projectId, sessionHash, true),
    );
    await this.archive.assertCapacity();
    const baselineHash = (await baselineIdentity(captured.project!.baseline))
      .sha256;
    if (captured.upload && captured.upload.baselineHash !== baselineHash)
      throw new ApiError(
        409,
        "GIS_BASELINE_CHANGED",
        "The upload belongs to a different baseline. Upload it again in the current project.",
      );
    if (captured.upload?.upload)
      await this.archive.path(
        captured.identity!.organization.id,
        projectId,
        captured.upload.upload,
      );
    let exportSnapshot: GisJobRecord["exportSnapshot"],
      stagedExport: StagedGisFile | undefined,
      publication: GisArchivePublication | undefined;
    try {
      if (kind === "export-shapefile") {
        const p = captured.project!,
          scenario = p.project.scenarios.find(
            (s) => s.id === input.scenarioId,
          )!;
        exportRights(p.baseline, scenario);
        assertFloodExport(p.project, scenario);
        const snapshot: FrozenExport = {
          ...(scenario.flood
            ? {
                floodDatasets: p.project.floodDatasets,
              }
            : {}),
          place: p.baseline,
          scenario,
          projectId,
          projectVersion: p.version,
          baselineHash,
          generatedAt: nowISO(),
        };
        stagedExport = await this.archive.stageBuffer(
          captured.identity!.organization.id,
          projectId,
          Buffer.from(canonicalJSON(snapshot)),
        );
        publication = await stagedExport.finalize();
        exportSnapshot = publication.reference;
      }
      const job = await this.store.transaction(
        (state) => {
          const identity = authenticate(state),
            project = findProjectHeader(
              state,
              identity.organization.id,
              projectId,
              identity.user.id,
              [...roles],
            );
          const existing = state.gisJobHeaders.find(
            (j) =>
              j.userId === identity.user.id &&
              j.projectId === projectId &&
              j.requestKeys.includes(input.idempotencyKey),
          );
          if (existing) {
            if (existing.requestHash !== requestHash)
              throw new ApiError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "This key belongs to different GIS inputs.",
              );
            return existing;
          }
          assertVersion(project, input);
          admission(state, this.options.capacity);
          this.queueCapacity(state, identity.user.id);
          if (
            kind === "prepare" &&
            !state.gisJobHeaders.some(
              (j) =>
                j.id === details.uploadId &&
                j.status === "completed" &&
                j.userId === identity.user.id &&
                j.projectId === projectId &&
                j.organizationId === identity.organization.id,
            )
          )
            throw new ApiError(
              409,
              "GIS_UPLOAD_NOT_READY",
              "The upload is no longer available.",
            );
          const now = nowISO(),
            record: GisJobRecord = {
              id: randomUUID(),
              kind,
              organizationId: identity.organization.id,
              userId: identity.user.id,
              projectId,
              scenarioId: input.scenarioId,
              projectVersion: input.expectedVersion,
              scenarioRevision: input.expectedRevision,
              baselineHash,
              version: 1,
              status: "queued",
              stage: "queued",
              attempt: 0,
              attempts: [],
              createdAt: now,
              updatedAt: now,
              cancelRequested: false,
              idempotencyKey: input.idempotencyKey,
              requestKeys: [input.idempotencyKey],
              requestHash,
              ...(details.upload ? { upload: details.upload } : {}),
              ...(details.uploadId ? { uploadId: details.uploadId } : {}),
              ...(recipe
                ? { recipe: recipeBody as GisJobRecord["recipe"] }
                : {}),
              ...(exportSnapshot ? { exportSnapshot } : {}),
            };
          state.gisJobs.push(record);
          addAudit(state, {
            organizationId: record.organizationId,
            projectId,
            actorId: identity.user.id,
            action: "gis.submitted",
            details: {
              jobId: record.id,
              kind,
              scenarioId: record.scenarioId,
              requestHash,
            },
          });
          return record;
        },
        {
          ...this.callerScope(projectId, sessionHash, true),
          gisJobs: { append: true },
        },
      );
      if (publication)
        await publication.settle(
          job.exportSnapshot?.sha256 === publication.reference.sha256 ||
            (await this.uploadReferenced(
              captured.identity!.organization.id,
              projectId,
              publication.reference.sha256,
            )),
        );
      this.wake();
      return publicGisJob(job);
    } catch (error) {
      if (publication)
        await publication.settle(
          await this.uploadReferenced(
            captured.identity!.organization.id,
            projectId,
            publication.reference.sha256,
          ),
        );
      throw error;
    } finally {
      await stagedExport?.discard();
    }
  }
  async cancel(
    projectId: string,
    id: string,
    expectedJobVersion: number,
    authenticate: Authenticate,
    sessionHash: string,
  ) {
    const job = await this.store.transaction(
      (state) => {
        const identity = authenticate(state);
        findProjectHeader(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          [...roles],
        );
        const job = state.gisJobHeaders.find(
          (j) =>
            j.id === id &&
            j.projectId === projectId &&
            j.userId === identity.user.id &&
            j.organizationId === identity.organization.id,
        );
        if (!job) throw new ApiError(404, "NOT_FOUND", "GIS job not found.");
        if (job.status === "cancelled" || job.cancelRequested) return job;
        if (job.version !== expectedJobVersion)
          throw new ApiError(
            409,
            "GIS_JOB_CHANGED",
            "The GIS job changed. Refresh before cancelling.",
          );
        if (!pending(job))
          throw new ApiError(
            409,
            "GIS_JOB_FINISHED",
            "This GIS job already finished.",
          );
        job.cancelRequested = true;
        job.version++;
        job.updatedAt = nowISO();
        if (job.status === "queued") job.status = "cancelled";
        addAudit(state, {
          organizationId: job.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "gis.cancelled",
          details: { jobId: id },
        });
        return job;
      },
      this.callerScope(projectId, sessionHash),
    );
    if (this.activeJobId === id) this.controller?.abort();
    return publicGisJob(job);
  }
  async retry(
    projectId: string,
    id: string,
    expectedJobVersion: number,
    key: string,
    authenticate: Authenticate,
    sessionHash: string,
  ) {
    const accepted = await this.store.read(
      (state) => {
        const identity = authenticate(state);
        findProjectHeader(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          [...roles],
        );
        const job = state.gisJobHeaders.find(
          (j) =>
            j.id === id &&
            j.projectId === projectId &&
            j.userId === identity.user.id &&
            j.organizationId === identity.organization.id,
        );
        if (!job) throw new ApiError(404, "NOT_FOUND", "GIS job not found.");
        return job.requestKeys.includes(key) ? job : undefined;
      },
      this.callerScope(projectId, sessionHash),
    );
    if (accepted) return publicGisJob(accepted);
    this.enabled();
    await this.archive.assertCapacity();
    const job = await this.store.transaction(
      (state) => {
        const identity = authenticate(state),
          project = findProjectHeader(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            [...roles],
          );
        const job = state.gisJobHeaders.find(
          (j) =>
            j.id === id &&
            j.projectId === projectId &&
            j.userId === identity.user.id &&
            j.organizationId === identity.organization.id,
        );
        if (!job) throw new ApiError(404, "NOT_FOUND", "GIS job not found.");
        if (job.requestKeys.includes(key)) return job;
        if (
          state.gisJobHeaders.some(
            (j) =>
              j.projectId === projectId &&
              j.userId === identity.user.id &&
              j.requestKeys.includes(key),
          )
        )
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This retry key belongs to another job.",
          );
        if (job.version !== expectedJobVersion)
          throw new ApiError(
            409,
            "GIS_JOB_CHANGED",
            "The GIS job changed. Refresh before retrying.",
          );
        if (
          !["failed", "cancelled"].includes(job.status) ||
          job.attempt >= GIS_JOB_LIMITS.attempts ||
          job.error?.retryable === false
        )
          throw new ApiError(
            409,
            "GIS_NOT_RETRYABLE",
            "Resolve the reported problem and submit a new GIS request.",
          );
        if (job.kind === "prepare")
          assertVersion(project, {
            scenarioId: job.scenarioId,
            expectedVersion: job.projectVersion,
            expectedRevision: job.scenarioRevision,
            idempotencyKey: key,
          });
        admission(state, this.options.capacity);
        this.queueCapacity(state, job.userId, job.id);
        job.requestKeys.push(key);
        job.version++;
        job.status = "queued";
        job.stage = "queued";
        job.cancelRequested = false;
        job.updatedAt = nowISO();
        delete job.error;
        addAudit(state, {
          organizationId: job.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "gis.retried",
          details: { jobId: id, consumedAttempts: job.attempt },
        });
        return job;
      },
      this.callerScope(projectId, sessionHash, true),
    );
    this.wake();
    return publicGisJob(job);
  }
  start() {
    if (this.options.automaticWorker !== false) this.wake();
  }
  private wake() {
    if (
      this.stopped ||
      this.timer ||
      this.active ||
      !this.options.enabled ||
      this.options.automaticWorker === false
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.runOne()
        .catch(() => {})
        .finally(() => {
          this.active = undefined;
          this.wake();
        });
    }, 1000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }
  async runOne(): Promise<void> {
    if (
      this.running ||
      this.stopped ||
      !this.options.enabled ||
      !this.options.runtime ||
      !this.options.capacity
    )
      return;
    this.running = true;
    try {
      await this.processOne();
    } finally {
      this.running = false;
    }
  }
  private async processOne() {
    const claimed = await this.store.transaction((state) => {
      const now = nowISO();
      for (const stale of state.gisJobHeaders.filter(
        (j) =>
          j.status === "running" &&
          Date.parse(j.leaseExpiresAt ?? "") <= Date.now(),
      )) {
        stale.status = stale.cancelRequested ? "cancelled" : "failed";
        stale.error = {
          code: "GIS_INTERRUPTED",
          message:
            "The previous worker stopped. Its consumed attempt is retained; retry explicitly.",
          retryable: stale.attempt < GIS_JOB_LIMITS.attempts,
        };
        stale.version++;
        stale.updatedAt = now;
        const last = stale.attempts.at(-1);
        if (last) {
          last.endedAt = now;
          last.outcome = "interrupted";
        }
        if (
          state.nativeCapacity.slot?.token === stale.capacityToken &&
          stale.capacityToken
        )
          quarantineNativeCapacity(
            state,
            stale.capacityToken,
            "A native worker lost its job lease. Confirm termination before operator recovery.",
          );
        delete stale.workerId;
        delete stale.leaseExpiresAt;
      }
      if (state.gisJobHeaders.some((j) => j.status === "running")) return;
      const next = state.gisJobHeaders.find(
        (j) => j.status === "queued" && !j.cancelRequested,
      );
      if (!next) return;
      if (!canEdit(state, next)) {
        next.status = "failed";
        next.version++;
        next.updatedAt = now;
        next.error = {
          code: "GIS_REQUESTER_REVOKED",
          message:
            "The requester no longer has project edit access or the scenario was removed.",
          retryable: false,
        };
        return;
      }
      let cost;
      try {
        this.queueCapacity(state, next.userId, next.id);
        cost = admission(state, this.options.capacity);
      } catch (error) {
        const e = failure(error);
        if (next.error?.code !== e.code) {
          next.error = e;
          next.updatedAt = now;
          next.version++;
        }
        return;
      }
      const capacityLease = acquireNativeCapacity(state, {
        kind: "gis",
        jobId: next.id,
        workerId: this.workerId,
        runMilliseconds: 60_000,
      });
      if (!capacityLease) return;
      next.capacityToken = capacityLease.token;
      next.status = "running";
      next.stage = "validating";
      next.attempt++;
      next.version++;
      next.updatedAt = now;
      next.workerId = this.workerId;
      next.leaseExpiresAt = new Date(Date.now() + 90000).toISOString();
      next.attempts.push({
        number: next.attempt,
        startedAt: now,
        admission: cost,
      });
      delete next.error;
      return structuredClone(next);
    }, this.workerScope());
    if (!claimed) return;
    const job = await this.store.read(
      (state) => {
        const current = state.gisJobs.find((j) => j.id === claimed.id);
        if (
          !current ||
          current.status !== "running" ||
          current.workerId !== this.workerId
        )
          return undefined;
        return current;
      },
      this.workerScope(claimed.id, true),
    );
    if (!job) return;
    const started = performance.now(),
      controller = new AbortController();
    this.controller = controller;
    this.activeJobId = job.id;
    const timeout = setTimeout(() => controller.abort(), 60000);
    timeout.unref();
    let checking = false;
    const check = async (stage?: GisJob["stage"]) =>
      this.store.transaction((state) => {
        const current = state.gisJobHeaders.find((j) => j.id === job.id);
        if (
          !current ||
          current.workerId !== this.workerId ||
          current.status !== "running" ||
          current.cancelRequested ||
          !canEdit(state, current)
        )
          throw cancelled();
        heartbeatNativeCapacity(state, job.capacityToken!);
        current.leaseExpiresAt = new Date(Date.now() + 90000).toISOString();
        if (stage) {
          current.stage = stage;
          current.updatedAt = nowISO();
        }
      }, this.workerScope(job.id));
    const heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void check()
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 5000);
    heartbeat.unref();
    let stagedOutput: StagedGisFile | undefined,
      outputPublication: GisArchivePublication | undefined;
    let completed = false;
    let cleanupUnconfirmed = false;
    try {
      await this.archive.assertCapacity();
      let inspection: GisInspection | undefined,
        preview: GisPreview | undefined,
        download: { sha256: string; bytes: number } | undefined;
      if (job.kind === "inspect") {
        if (!job.upload)
          throw new ApiError(
            422,
            "GIS_UPLOAD_MISSING",
            "The uploaded file identity is missing.",
          );
        await check("inspecting");
        const inputPath = await this.archive.path(
          job.organizationId,
          job.projectId,
          job.upload,
        );
        inspection = await this.options.runtime!.inspect({
          inputPath,
          format: job.upload.format,
          filename: job.upload.filename,
          signal: controller.signal,
        });
        if (
          inspection.input.sha256 !== job.upload.sha256 ||
          inspection.input.bytes !== job.upload.bytes
        )
          throw new ApiError(
            422,
            "GIS_UPLOAD_CHANGED",
            "The inspection did not match the uploaded file.",
          );
      } else if (job.kind === "prepare") {
        const captured = await this.store.read(
          (state) => {
            const project = state.projects.find(
                (p) =>
                  p.project.id === job.projectId &&
                  p.organizationId === job.organizationId,
              ),
              upload = state.gisJobHeaders.find(
                (j) =>
                  j.id === job.uploadId &&
                  j.projectId === job.projectId &&
                  j.organizationId === job.organizationId &&
                  j.userId === job.userId &&
                  j.kind === "inspect" &&
                  j.status === "completed",
              );
            if (!project || !upload?.upload || !job.recipe)
              throw new ApiError(
                404,
                "GIS_INPUT_UNAVAILABLE",
                "The project or inspected source is no longer available.",
              );
            assertVersion(project, {
              ...job.recipe,
              idempotencyKey: job.idempotencyKey,
            });
            return { project, upload };
          },
          {
            ...this.workerScope(),
            gisJobHeaders: { where: [{ id: [job.id, job.uploadId!] }] },
            projects: { where: [{ id: job.projectId }] },
          },
        );
        if (
          (await baselineIdentity(captured.project.baseline)).sha256 !==
          job.baselineHash
        )
          throw new ApiError(
            409,
            "GIS_BASELINE_CHANGED",
            "The baseline changed. Prepare a new preview.",
          );
        await check("converting");
        const inputPath = await this.archive.path(
          job.organizationId,
          job.projectId,
          captured.upload.upload!,
        );
        const normalized = await this.options.runtime!.normalize({
          inputPath,
          format: captured.upload.upload!.format,
          filename: captured.upload.upload!.filename,
          recipe: job.recipe!.conversion,
          signal: controller.signal,
        });
        if (
          normalized.provenance.upload.sha256 !== captured.upload.upload!.sha256
        )
          throw new ApiError(
            422,
            "GIS_UPLOAD_CHANGED",
            "The normalized result does not match the uploaded source.",
          );
        await check("mapping");
        preview = await prepareGisPreviewInWorker(
          {
            normalized,
            request: { ...job.recipe!, idempotencyKey: job.idempotencyKey },
            place: captured.project.baseline,
            scenario: captured.project.project.scenarios.find(
              (s) => s.id === job.scenarioId,
            )!,
            projectId: job.projectId,
            jobId: job.id,
            uploadId: job.uploadId!,
            importId: randomUUID(),
            userId: job.userId,
            createdAt: nowISO(),
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          { signal: controller.signal },
        );
      } else {
        if (!job.exportSnapshot)
          throw new ApiError(
            422,
            "GIS_EXPORT_MISSING",
            "The frozen export snapshot is missing.",
          );
        const snapshot = JSON.parse(
          (
            await this.archive.read(
              job.organizationId,
              job.projectId,
              job.exportSnapshot,
            )
          ).toString("utf8"),
        ) as FrozenExport;
        if (
          snapshot.projectId !== job.projectId ||
          snapshot.projectVersion !== job.projectVersion ||
          snapshot.scenario.id !== job.scenarioId ||
          snapshot.scenario.revision !== job.scenarioRevision ||
          snapshot.baselineHash !== job.baselineHash ||
          (await baselineIdentity(snapshot.place)).sha256 !== job.baselineHash
        )
          throw new ApiError(
            422,
            "GIS_EXPORT_CHANGED",
            "The frozen export input does not match the admitted request.",
          );
        exportRights(snapshot.place, snapshot.scenario);
        assertFloodExport(snapshot, snapshot.scenario);
        await check("exporting");
        const result = snapshot.scenario.flood
          ? await this.options.runtime!.exportShapefile({
              ...(await prepareFloodGisInWorker(snapshot, controller.signal)),
              signal: controller.signal,
            })
          : await exportScenarioShapefile(this.options.runtime!, {
              ...snapshot,
              signal: controller.signal,
            });
        stagedOutput = await this.archive.stageBuffer(
          job.organizationId,
          job.projectId,
          result.zip,
        );
        outputPublication = await stagedOutput.finalize();
        download = outputPublication.reference;
        if (download.sha256 !== result.sha256)
          throw new ApiError(
            422,
            "GIS_EXPORT_CHANGED",
            "The export archive does not match the converter's content identity.",
          );
      }
      await check("saving");
      controller.signal.throwIfAborted();
      await this.store.transaction(
        (state) => {
          const current = state.gisJobs.find((j) => j.id === job.id);
          if (
            !current ||
            current.workerId !== this.workerId ||
            current.status !== "running" ||
            current.cancelRequested ||
            !canEdit(state, current) ||
            controller.signal.aborted
          )
            throw cancelled();
          if (preview) {
            const project = state.projectHeaders.find(
              (p) => p.project.id === job.projectId,
            )!;
            assertVersion(project, {
              scenarioId: job.scenarioId,
              expectedVersion: job.projectVersion,
              expectedRevision: job.scenarioRevision,
              idempotencyKey: job.idempotencyKey,
            });
            const { source, warnings, importId, layer, ...rest } = preview;
            const {
              buildings: _b,
              parcels: _p,
              ...metadata
            } = rest as typeof rest & {
              buildings?: unknown;
              parcels?: unknown;
            };
            const staged: ImportRecord = {
              id: importId,
              organizationId: job.organizationId,
              projectId: job.projectId,
              createdBy: job.userId,
              source,
              warnings,
              createdAt: nowISO(),
              expiresAt: preview.expiresAt,
              prepared: {
                preview: metadata,
                mode: job.recipe!.mapping.target.mode,
              },
              ...("buildings" in preview
                ? { layer: "buildings", buildings: preview.buildings }
                : { layer: preview.layer, parcels: preview.parcels }),
            };
            stagedGisPreview(staged);
            state.imports.push(staged);
            current.result = { previewHash: preview.previewHash, importId };
          }
          if (inspection) current.inspection = inspection;
          if (download)
            current.result = {
              downloadHash: download.sha256,
              downloadBytes: download.bytes,
            };
          current.status = "completed";
          current.stage = "complete";
          current.version++;
          current.updatedAt = nowISO();
          delete current.workerId;
          delete current.leaseExpiresAt;
          delete current.error;
          const attempt = current.attempts.at(-1)!;
          attempt.endedAt = current.updatedAt;
          attempt.outcome = "completed";
          attempt.elapsedMilliseconds = performance.now() - started;
        },
        {
          ...this.workerScope(job.id, true),
          ...(preview ? { imports: { append: true as const } } : {}),
        },
      );
      completed = true;
    } catch (error) {
      cleanupUnconfirmed =
        error instanceof ApiError &&
        ["NATIVE_CLEANUP_UNCONFIRMED", "FLOOD_WORKER_QUARANTINED"].includes(
          error.code,
        );
      await this.store.transaction((state) => {
        const current = state.gisJobHeaders.find((j) => j.id === job.id);
        if (
          !current ||
          current.workerId !== this.workerId ||
          current.status !== "running"
        )
          return;
        current.status =
          current.cancelRequested || controller.signal.aborted
            ? "cancelled"
            : "failed";
        current.error = failure(
          controller.signal.aborted ? cancelled() : error,
          current.attempt < GIS_JOB_LIMITS.attempts,
        );
        current.version++;
        current.updatedAt = nowISO();
        delete current.workerId;
        delete current.leaseExpiresAt;
        const attempt = current.attempts.at(-1)!;
        attempt.endedAt = current.updatedAt;
        attempt.outcome = current.status;
        attempt.elapsedMilliseconds = performance.now() - started;
      }, this.workerScope(job.id));
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.controller = undefined;
      this.activeJobId = undefined;
      await this.store.transaction(
        (state) => {
          const slot = state.nativeCapacity.slot;
          if (
            !slot ||
            slot.token !== job.capacityToken ||
            slot.status === "quarantined"
          )
            return;
          if (cleanupUnconfirmed)
            quarantineNativeCapacity(
              state,
              job.capacityToken!,
              "Native container cleanup could not be confirmed. Operator recovery is required.",
            );
          else
            releaseNativeCapacity(state, job.capacityToken!, {
              reason: completed ? "completed" : "confirmed-stopped",
            });
        },
        { security: worker, nativeCapacity: true },
      );

      try {
        if (outputPublication)
          await outputPublication.settle(
            completed ||
              (await this.uploadReferenced(
                job.organizationId,
                job.projectId,
                outputPublication.reference.sha256,
              )),
          );
      } finally {
        await stagedOutput?.discard();
      }
    }
  }
}
