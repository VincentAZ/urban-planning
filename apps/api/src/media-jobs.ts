import { prepareMediaSceneInWorker } from "./media-scene-worker.js";
import { assertMediaPrivateExport } from "./media-rights.js";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJSON,
  createMediaScene,
  assertMediaScene,
  validateMediaExport,
  defaultMediaExportRecipe,
  mediaFrameCount,
  assertMediaExportManifest,
  mediaContentHash,
  mediaTranscript,
  mediaWebVtt,
  type MediaExportManifest,
  type MediaScene,
  type MediaExportRecipe,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { calculateFloodImpactInWorker } from "./flood-normalization-worker.js";
import { ApiError } from "./errors.js";
import {
  findProject,
  addAudit,
  type Store,
  type DataState,
  type authorize,
} from "./store.js";
import { findProjectHeader, projectAccess } from "./project-access.js";
import type { StoreScope } from "./store-scope.js";
import { budgetDashboard, assertBudgetCostEvidence } from "./budget.js";
import {
  acquireNativeCapacity,
  heartbeatNativeCapacity,
  releaseNativeCapacity,
  quarantineNativeCapacity,
  assertNativeCapacityAvailable,
} from "./native-capacity.js";
import { MediaArchive, MEDIA_ARCHIVE_LIMITS } from "./media-archive.js";
import type {
  MediaJobRecord,
  MediaJob,
  MediaArtifactRecord,
  MediaExecutor,
  MediaCapacityDeclaration,
  MediaCapabilities,
  MediaContext,
  MediaFile,
} from "./media-types.js";
export const MEDIA_JOB_LIMITS = Object.freeze({
  queued: 10,
  pendingPerAccount: 1,
  startsPerAccountPerDay: 3,
  attempts: 3,
  concurrency: 1 as const,
  runSeconds: 900,
  retainedJobs: 10000,
  archiveBytes: MEDIA_ARCHIVE_LIMITS.bundleBytes,
});
export interface MediaSubmission {
  scenarioId: string;
  expectedVersion: number;
  expectedRevision: number;
  sceneHash: string;
  recipe: MediaExportRecipe;
  idempotencyKey: string;
}
export const mediaSubmissionSchema = z
  .object({
    scenarioId: z.string().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    sceneHash: z.string().regex(/^[a-f0-9]{64}$/),
    recipe: z.unknown(),
    idempotencyKey: z.string().min(8).max(160),
  })
  .strict();
type Auth = (state: DataState) => ReturnType<typeof authorize>;
const worker = { mode: "worker", purpose: "media" } as const;
const roles = ["owner", "editor"] as const;
const now = () => new Date().toISOString();
const hash = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const pending = (j: MediaJob) =>
  j.status === "queued" || j.status === "running";
const fail = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);
const abortError = () =>
  fail(
    499,
    "MEDIA_CANCELLED",
    "Media export was cancelled or project access was removed.",
  );
export function publicMediaJob(record: MediaJobRecord): MediaJob {
  const {
    organizationId: _o,
    userId: _u,
    idempotencyKey: _k,
    requestKeys: _r,
    workerId: _w,
    leaseExpiresAt: _l,
    capacityToken: _c,
    input: _i,
    runtimeIdentity: _ri,
    ...job
  } = record;
  return structuredClone(job);
}
function creatorCanEdit(state: DataState, j: MediaJobRecord) {
  const p = state.projectHeaders.find(
      (p) =>
        p.project.id === j.projectId && p.organizationId === j.organizationId,
    ),
    m = state.memberships.find(
      (m) => m.userId === j.userId && m.organizationId === j.organizationId,
    );
  return Boolean(
    p &&
      m &&
      projectAccess(p, j.userId, m)?.canEdit &&
      p.project.scenarios.some((s) => s.id === j.scenarioId),
  );
}
function version(
  p: {
    version: number;
    project: { scenarios: { id: string; revision: number }[] };
  },
  i: Pick<
    MediaSubmission,
    "scenarioId" | "expectedVersion" | "expectedRevision"
  >,
) {
  const s = p.project.scenarios.find((s) => s.id === i.scenarioId);
  if (
    !s ||
    p.version !== i.expectedVersion ||
    s.revision !== i.expectedRevision
  )
    throw fail(
      409,
      "REVISION_CONFLICT",
      "The saved project or scenario changed. Refresh the export preview.",
    );
  return s;
}
function admission(state: DataState, capacity?: MediaCapacityDeclaration) {
  if (
    !capacity ||
    capacity.mode !== "fixed-capacity" ||
    !["local-development", "deployment"].includes(capacity.environment) ||
    capacity.statement.trim().length < 12
  )
    throw fail(
      503,
      "MEDIA_CAPACITY_UNCONFIGURED",
      "An operator must declare the fixed rendering capacity before exports can start.",
    );
  const b = budgetDashboard(state.budget);
  if (state.budget.policy.paidOperationsPaused)
    throw fail(
      503,
      "MEDIA_CAPACITY_PAUSED",
      "Costly processing is paused by the platform administrator.",
    );
  assertBudgetCostEvidence(state.budget);
  if (b.totals.availableCents <= 0)
    throw fail(
      429,
      "MEDIA_BUDGET_EXHAUSTED",
      "The operating budget has no safe headroom for media exports.",
    );
  if (
    capacity.environment === "deployment" &&
    state.budget.policy.fixedCostReserveCents <= 0 &&
    b.totals.recordedFixedCents <= 0
  )
    throw fail(
      503,
      "MEDIA_FIXED_COST_UNRECORDED",
      "Record or reserve the deployment fixed cost before rendering.",
    );
  return {
    budgetPolicyVersion: state.budget.policy.version,
    period: b.period,
    incrementalExternalCents: 0 as const,
    costModel: structuredClone(capacity),
  };
}
function validatedRecipe(
  scene: MediaScene,
  recipe: unknown,
): MediaExportRecipe {
  try {
    return validateMediaExport(scene, recipe);
  } catch (error) {
    throw fail(
      422,
      "MEDIA_RECIPE_INVALID",
      error instanceof Error
        ? error.message.slice(0, 2000)
        : "The complete media recipe is invalid.",
    );
  }
}
function failure(e: unknown) {
  return {
    code: e instanceof ApiError ? e.code : "MEDIA_FAILED",
    message:
      e instanceof ApiError
        ? e.message
        : "The media export could not be completed and verified. No partial output was published.",
    retryable: !(
      e instanceof ApiError && [400, 413, 422].includes(e.statusCode)
    ),
  };
}
const validIdentity = (x: unknown) => {
  const i = x as {
    profileVersion?: unknown;
    rendererHash?: unknown;
    runtimeHash?: unknown;
  };
  if (
    !i ||
    typeof i.profileVersion !== "string" ||
    i.profileVersion.length > 160 ||
    ![i.rendererHash, i.runtimeHash].every(
      (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    )
  )
    throw fail(
      503,
      "MEDIA_RUNTIME_UNAVAILABLE",
      "The media runtime identity is invalid.",
    );
};
export class MediaJobService {
  readonly archive: MediaArchive;
  private workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private controller?: AbortController;
  private activeId?: string;
  private stopped = false;
  private contexts = new Map<
    string,
    {
      userId: string;
      organizationId: string;
      projectId: string;
      scene: MediaScene;
      bytes: number;
      expiresAt: number;
    }
  >();
  private preparing = false;
  private preparationController?: AbortController;
  private preparation?: Promise<MediaScene>;
  constructor(
    readonly store: Store,
    readonly options: {
      enabled: boolean;
      configurationReason?: string;
      executor?: MediaExecutor;
      archiveDirectory: string;
      capacity?: MediaCapacityDeclaration;
      automaticWorker?: boolean;
    },
  ) {
    this.archive = new MediaArchive(options.archiveDirectory);
  }
  private enabled() {
    if (!this.options.enabled || !this.options.executor)
      throw fail(
        503,
        "MEDIA_DISABLED",
        "High-resolution media rendering is not configured on this server. Existing downloads remain available.",
      );
  }
  async capabilities(): Promise<MediaCapabilities> {
    let reason: string | null = null,
      runtimeIdentity = null;
    const configured = Boolean(this.options.executor && this.options.capacity);
    if (!this.options.enabled || !configured)
      reason =
        this.options.configurationReason ??
        "An operator has not enabled the isolated renderer and declared fixed capacity.";
    else
      try {
        runtimeIdentity = await this.options.executor!.identity();
        validIdentity(runtimeIdentity);
        await this.store.read(
          (s) => {
            assertNativeCapacityAvailable(s);
            admission(s, this.options.capacity);
          },
          { security: worker, budget: true, nativeCapacity: true },
        );
      } catch (e) {
        reason = failure(e).message;
      }
    return {
      enabled: Boolean(this.options.enabled && configured && !reason),
      configured,
      reason,
      runtimeIdentity,
      formats: ["png", "mp4"],
      audio: "none",
      limits: MEDIA_JOB_LIMITS,
      cost: {
        model: this.options.capacity ?? null,
        perExportProviderChargeCents: this.options.capacity ? 0 : null,
        metered: false,
        notes: [
          "Rendering uses explicitly declared existing fixed capacity. There is no paid per-export provider.",
          "CPU time and output bytes are not measured hosting invoices. All accounts share the same bounded queue.",
        ],
      },
    };
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
      mediaJobs: global ? { all: true } : { where: [{ projectId }] },
      audit: { append: true },
    };
  }
  private workerScope(id?: string): StoreScope {
    return {
      security: worker,
      mediaJobs: id ? { where: [{ id }] } : { all: true },
      projectHeaders: {
        where: [{ id: { from: "mediaJobs", field: "projectId" } }],
      },
      memberships: {
        where: [{ userId: { from: "mediaJobs", field: "userId" } }],
      },
      budget: true,
      nativeCapacity: true,
    };
  }
  private queue(state: DataState, userId: string, except?: string) {
    if (!except && state.mediaJobs.length >= MEDIA_JOB_LIMITS.retainedJobs)
      throw fail(
        503,
        "MEDIA_HISTORY_LIMIT",
        "Media history needs operator archival before accepting more work.",
      );
    const q = state.mediaJobs.filter((j) => pending(j) && j.id !== except);
    if (q.some((j) => j.userId === userId))
      throw fail(
        429,
        "MEDIA_ALREADY_PENDING",
        "This account already has a queued or running media export.",
      );
    if (q.length >= MEDIA_JOB_LIMITS.queued)
      throw fail(
        429,
        "MEDIA_QUEUE_FULL",
        "The bounded rendering queue is full. Try again later.",
      );
    if (
      state.mediaJobs
        .filter((j) => j.userId === userId)
        .flatMap((j) => j.attempts)
        .filter((a) => a.startedAt.startsWith(now().slice(0, 10))).length >=
      MEDIA_JOB_LIMITS.startsPerAccountPerDay
    )
      throw fail(
        429,
        "MEDIA_DAILY_LIMIT",
        "This account has used its three media attempts for this UTC day. Failed and cancelled attempts remain counted.",
      );
  }
  async context(
    projectId: string,
    scenarioId: string,
    authenticate: Auth,
    sessionHash: string,
  ): Promise<MediaContext> {
    const captured = await this.store.read(
      (s) => {
        const identity = authenticate(s),
          p = findProject(
            s,
            identity.organization.id,
            projectId,
            identity.user.id,
            [...roles],
          );
        const scenario = p.project.scenarios.find((s) => s.id === scenarioId);
        if (!scenario) throw fail(404, "NOT_FOUND", "Scenario not found.");
        return { p, scenario, identity };
      },
      {
        auth: { sessionHash },
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
      },
    );
    const cached = [...this.contexts.values()].find(
      (c) =>
        c.userId === captured.identity.user.id &&
        c.projectId === projectId &&
        c.expiresAt > Date.now() &&
        c.scene.binding.projectVersion === captured.p.version &&
        c.scene.binding.scenarioId === scenarioId,
    );
    let scene = cached?.scene;
    if (!scene) {
      if (this.preparing)
        throw fail(
          429,
          "MEDIA_PREVIEW_BUSY",
          "A media preview is being prepared. Try again shortly.",
        );
      this.preparing = true;
      this.preparationController = new AbortController();
      try {
        assertMediaPrivateExport(
          captured.p.project,
          captured.p.baseline,
          captured.scenario,
        );
        this.preparation = prepareMediaSceneInWorker(
          {
            projectId,
            projectVersion: captured.p.version,
            place: captured.p.baseline,
            scenario: captured.scenario,
            ...(captured.p.project.fiscalStudy
              ? { fiscalStudy: captured.p.project.fiscalStudy }
              : {}),
            ...(captured.scenario.flood
              ? {
                  floodDatasets: {
                    [captured.scenario.flood.datasetHash]:
                      captured.p.project.floodDatasets![
                        captured.scenario.flood.datasetHash
                      ],
                  },
                }
              : {}),
            createdAt: now(),
          },
          { signal: this.preparationController.signal },
        );
        scene = await this.preparation;
        const bytes = Buffer.byteLength(canonicalJSON(scene));
        if (bytes > 32 * 1024 ** 2)
          throw fail(
            413,
            "MEDIA_SCENE_TOO_LARGE",
            "The frozen scene exceeds the 32 MiB media input limit.",
          );
        for (const [key, c] of this.contexts)
          if (c.expiresAt <= Date.now()) this.contexts.delete(key);
        while (
          this.contexts.size >= 8 ||
          [...this.contexts.values()].reduce((n, c) => n + c.bytes, 0) + bytes >
            64 * 1024 ** 2
        )
          this.contexts.delete(this.contexts.keys().next().value!);
        this.contexts.set(
          `${captured.identity.organization.id}:${captured.identity.user.id}:${scene.sceneHash}`,
          {
            scene,
            userId: captured.identity.user.id,
            organizationId: captured.identity.organization.id,
            projectId,
            bytes,
            expiresAt: Date.now() + 5 * 60_000,
          },
        );
      } finally {
        this.preparing = false;
        this.preparation = undefined;
        this.preparationController = undefined;
      }
    }
    await this.store.read(
      (s) => {
        const i = authenticate(s),
          p = findProjectHeader(s, i.organization.id, projectId, i.user.id, [
            ...roles,
          ]);
        version(p, {
          scenarioId,
          expectedVersion: captured.p.version,
          expectedRevision: captured.scenario.revision,
        });
      },
      this.callerScope(projectId, sessionHash),
    );
    return {
      capabilities: await this.capabilities(),
      projectVersion: captured.p.version,
      scenarioRevision: captured.scenario.revision,
      scene: structuredClone(scene),
      sceneHash: scene.sceneHash,
      defaultRecipe: defaultMediaExportRecipe(scene),
    };
  }
  private matches(j: MediaJobRecord, i: MediaSubmission) {
    return (
      j.scenarioId === i.scenarioId &&
      j.projectVersion === i.expectedVersion &&
      j.scenarioRevision === i.expectedRevision &&
      j.sceneHash === i.sceneHash &&
      canonicalJSON(j.recipe) === canonicalJSON(i.recipe)
    );
  }
  async enqueue(
    projectId: string,
    input: MediaSubmission,
    authenticate: Auth,
    sessionHash: string,
  ) {
    const pre = await this.store.read(
      (s) => {
        const i = authenticate(s),
          p = findProjectHeader(s, i.organization.id, projectId, i.user.id, [
            ...roles,
          ]),
          old = s.mediaJobs.find(
            (j) =>
              j.projectId === projectId &&
              j.userId === i.user.id &&
              j.requestKeys.includes(input.idempotencyKey),
          );
        if (old) {
          if (!this.matches(old, input))
            throw fail(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This key belongs to different media inputs.",
            );
          return { old, i };
        }
        version(p, input);
        admission(s, this.options.capacity);
        this.queue(s, i.user.id);
        return { i };
      },
      this.callerScope(projectId, sessionHash, true),
    );
    if (pre.old) return publicMediaJob(pre.old);
    this.enabled();
    const c = this.contexts.get(
      `${pre.i.organization.id}:${pre.i.user.id}:${input.sceneHash}`,
    );
    if (
      !c ||
      c.expiresAt <= Date.now() ||
      c.userId !== pre.i.user.id ||
      c.organizationId !== pre.i.organization.id ||
      c.projectId !== projectId
    )
      throw fail(
        409,
        "MEDIA_CONTEXT_EXPIRED",
        "The prepared media preview expired. Refresh it before submitting.",
      );
    version(
      {
        version: c.scene.binding.projectVersion,
        project: {
          scenarios: [
            {
              id: c.scene.binding.scenarioId,
              revision: c.scene.binding.scenarioRevision,
            },
          ],
        },
      },
      input,
    );

    input = { ...input, recipe: validatedRecipe(c.scene, input.recipe) };
    const totalFrames = mediaFrameCount(input.recipe);
    const runtimeIdentity = await this.options.executor!.identity();
    validIdentity(runtimeIdentity);
    const requestHash = hash(
      canonicalJSON({
        sceneHash: input.sceneHash,
        recipe: input.recipe,
        runtimeIdentity,
      }),
    );
    await this.archive.assertCapacity();
    const publication = await this.archive.stage(
      { organizationId: pre.i.organization.id, projectId },
      {
        "scene.json": Buffer.from(canonicalJSON(c.scene)),
        "recipe.json": Buffer.from(canonicalJSON(input.recipe)),
      },
    );
    let retained = false;
    try {
      const job = await this.store.transaction(
        (s) => {
          const i = authenticate(s),
            p = findProjectHeader(s, i.organization.id, projectId, i.user.id, [
              ...roles,
            ]);
          const old = s.mediaJobs.find(
            (j) =>
              j.projectId === projectId &&
              j.userId === i.user.id &&
              j.requestKeys.includes(input.idempotencyKey),
          );
          if (old) {
            if (!this.matches(old, input))
              throw fail(
                409,
                "IDEMPOTENCY_CONFLICT",
                "This key belongs to different media inputs.",
              );
            return old;
          }
          version(p, input);
          admission(s, this.options.capacity);
          this.queue(s, i.user.id);
          const at = now();
          const j: MediaJobRecord = {
            id: randomUUID(),
            organizationId: i.organization.id,
            userId: i.user.id,
            projectId,
            scenarioId: input.scenarioId,
            projectVersion: input.expectedVersion,
            scenarioRevision: input.expectedRevision,
            baselineHash: c.scene.binding.baselineHash,
            sceneHash: input.sceneHash,
            recipe: structuredClone(input.recipe),
            requestHash,
            runtimeIdentity,
            input: publication.reference,
            idempotencyKey: input.idempotencyKey,
            requestKeys: [input.idempotencyKey],
            version: 1,
            status: "queued",
            stage: "queued",
            completedFrames: 0,
            totalFrames,
            attempt: 0,
            attempts: [],
            createdAt: at,
            updatedAt: at,
            cancelRequested: false,
          };
          s.mediaJobs.push(j);
          addAudit(s, {
            organizationId: j.organizationId,
            projectId,
            actorId: i.user.id,
            action: "media.submitted",
            details: { jobId: j.id, sceneHash: j.sceneHash, requestHash },
          });
          return j;
        },
        this.callerScope(projectId, sessionHash, true),
      );
      retained = job.input.sha256 === publication.reference.sha256;
      this.wake();
      return publicMediaJob(job);
    } finally {
      if (!retained)
        retained = await this.referenced(publication.reference.sha256);
      await publication.settle(retained);
    }
  }
  private async referenced(sha256: string) {
    try {
      return await this.store.read(
        (s) =>
          s.mediaJobs.some((j) => j.input.sha256 === sha256) ||
          s.mediaArtifacts.some((a) => a.archive.sha256 === sha256),
        {
          security: worker,
          mediaJobs: { all: true },
          mediaArtifacts: { all: true },
        },
      );
    } catch {
      return true;
    }
  }
  async cancel(
    projectId: string,
    id: string,
    expected: number,
    authenticate: Auth,
    sessionHash: string,
  ) {
    const j = await this.store.transaction(
      (s) => {
        const i = authenticate(s);
        findProjectHeader(s, i.organization.id, projectId, i.user.id, [
          ...roles,
        ]);
        const j = s.mediaJobs.find(
          (j) => j.id === id && j.projectId === projectId,
        );
        if (!j) throw fail(404, "NOT_FOUND", "Media job not found.");
        if (j.cancelRequested || j.status === "cancelled") return j;
        if (j.version !== expected)
          throw fail(
            409,
            "MEDIA_JOB_CHANGED",
            "Refresh the changed media job before cancelling.",
          );
        if (!pending(j))
          throw fail(
            409,
            "MEDIA_FINISHED",
            "This export has already finished.",
          );
        j.cancelRequested = true;
        j.version++;
        j.updatedAt = now();
        if (j.status === "queued") j.status = "cancelled";
        return j;
      },
      this.callerScope(projectId, sessionHash),
    );
    if (this.activeId === id) this.controller?.abort();
    return publicMediaJob(j);
  }
  async retry(
    projectId: string,
    id: string,
    expected: number,
    key: string,
    authenticate: Auth,
    sessionHash: string,
  ) {
    this.enabled();
    await this.archive.assertCapacity();
    const j = await this.store.transaction(
      (s) => {
        const i = authenticate(s);
        findProjectHeader(s, i.organization.id, projectId, i.user.id, [
          ...roles,
        ]);
        const j = s.mediaJobs.find(
          (j) => j.id === id && j.projectId === projectId,
        );
        if (!j) throw fail(404, "NOT_FOUND", "Media job not found.");
        if (j.requestKeys.includes(key)) return j;
        if (
          s.mediaJobs.some(
            (other) =>
              other.projectId === projectId &&
              other.userId === j.userId &&
              other.requestKeys.includes(key),
          )
        )
          throw fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key belongs to another job.",
          );
        if (j.version !== expected)
          throw fail(
            409,
            "MEDIA_JOB_CHANGED",
            "Refresh the changed media job before retrying.",
          );
        if (
          !["failed", "cancelled"].includes(j.status) ||
          j.attempt >= 3 ||
          j.error?.retryable === false
        )
          throw fail(
            409,
            "MEDIA_NOT_RETRYABLE",
            "This export cannot be retried.",
          );
        if (!creatorCanEdit(s, j))
          throw fail(
            403,
            "MEDIA_REQUESTER_REVOKED",
            "The original requester no longer has edit access.",
          );
        admission(s, this.options.capacity);
        this.queue(s, j.userId, j.id);
        j.requestKeys.push(key);
        j.status = "queued";
        j.stage = "queued";
        j.completedFrames = 0;
        j.cancelRequested = false;
        j.version++;
        j.updatedAt = now();
        delete j.error;
        return j;
      },
      {
        ...this.callerScope(projectId, sessionHash, true),
        memberships: {
          where: [{ userId: { from: "mediaJobs", field: "userId" } }],
        },
      },
    );
    this.wake();
    return publicMediaJob(j);
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
    }, 2000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    this.preparationController?.abort();
    await this.preparation?.catch(() => {});
    await this.active;
    this.contexts.clear();
  }
  async runOne() {
    if (
      this.stopped ||
      !this.options.enabled ||
      !this.options.executor ||
      !this.options.capacity
    )
      return;
    const j = await this.store.transaction((s) => {
      for (const old of s.mediaJobs.filter(
        (j) =>
          j.status === "running" &&
          Date.parse(j.leaseExpiresAt ?? "") <= Date.now(),
      )) {
        old.status = old.cancelRequested ? "cancelled" : "failed";
        old.version++;
        old.updatedAt = now();
        old.error = {
          code: "MEDIA_INTERRUPTED",
          message:
            "The prior renderer stopped. Retry explicitly after confirmed process termination.",
          retryable: old.attempt < 3,
        };
        const a = old.attempts.at(-1);
        if (a) {
          a.endedAt = now();
          a.outcome = "interrupted";
        }
        if (
          old.capacityToken &&
          s.nativeCapacity.slot?.token === old.capacityToken
        )
          quarantineNativeCapacity(
            s,
            old.capacityToken,
            "The media worker lost its durable lease. Confirm all rendering and encoding processes stopped.",
          );
        delete old.workerId;
        delete old.leaseExpiresAt;
      }
      if (s.mediaJobs.some((j) => j.status === "running")) return;
      const j = s.mediaJobs.find(
        (j) => j.status === "queued" && !j.cancelRequested,
      );
      if (!j) return;
      if (!creatorCanEdit(s, j)) {
        j.status = "failed";
        j.version++;
        j.updatedAt = now();
        j.error = {
          code: "MEDIA_REQUESTER_REVOKED",
          message:
            "The requester no longer has project edit access. No rendering started.",
          retryable: false,
        };
        return;
      }
      let cost;
      try {
        this.queue(s, j.userId, j.id);
        cost = admission(s, this.options.capacity);
      } catch (e) {
        j.error = failure(e);
        return;
      }
      const lease = acquireNativeCapacity(s, {
        kind: "media",
        jobId: j.id,
        workerId: this.workerId,
        runMilliseconds: MEDIA_JOB_LIMITS.runSeconds * 1000,
      });
      if (!lease) return;
      j.capacityToken = lease.token;
      j.status = "running";
      j.stage = "validating";
      j.attempt++;
      j.version++;
      j.updatedAt = now();
      j.workerId = this.workerId;
      j.leaseExpiresAt = new Date(Date.now() + 180000).toISOString();
      j.attempts.push({ number: j.attempt, startedAt: now(), admission: cost });
      delete j.error;
      return structuredClone(j);
    }, this.workerScope());
    if (!j) return;
    const controller = new AbortController();
    this.controller = controller;
    this.activeId = j.id;
    const began = performance.now(),
      timeout = setTimeout(
        () => controller.abort(),
        MEDIA_JOB_LIMITS.runSeconds * 1000,
      );
    timeout.unref();
    let checkActive = false;
    const check = async (stage?: MediaJob["stage"], completedFrames?: number) =>
      this.store.transaction((s) => {
        const live = s.mediaJobs.find((x) => x.id === j.id);
        if (
          !live ||
          live.status !== "running" ||
          live.workerId !== this.workerId ||
          live.cancelRequested ||
          !creatorCanEdit(s, live)
        )
          throw abortError();
        heartbeatNativeCapacity(s, j.capacityToken!);
        live.leaseExpiresAt = new Date(Date.now() + 180000).toISOString();
        if (stage) live.stage = stage;
        if (completedFrames !== undefined) {
          if (
            !Number.isSafeInteger(completedFrames) ||
            completedFrames < live.completedFrames ||
            completedFrames > live.totalFrames
          )
            throw fail(
              422,
              "MEDIA_PROGRESS_INVALID",
              "The renderer reported invalid frame progress.",
            );
          live.completedFrames = completedFrames;
        }
        live.updatedAt = now();
      }, this.workerScope(j.id));
    const heartbeat = setInterval(() => {
      if (checkActive) return;
      checkActive = true;
      void check()
        .catch(() => controller.abort())
        .finally(() => {
          checkActive = false;
        });
    }, 15000);
    heartbeat.unref();
    let publication: Awaited<ReturnType<MediaArchive["stage"]>> | undefined;
    let retained = false,
      cleanupUnconfirmed = false;
    try {
      await check();
      await this.archive.assertCapacity();
      const identity = await this.options.executor.identity();
      if (canonicalJSON(identity) !== canonicalJSON(j.runtimeIdentity))
        throw fail(
          422,
          "MEDIA_RUNTIME_CHANGED",
          "The admitted renderer changed. Submit a new preview rather than substituting a runtime.",
        );
      await this.archive.verify(j, j.input);
      const scene = JSON.parse(
        (await this.archive.read(j, j.input, "scene.json")).toString(),
      ) as MediaScene;
      const recipe = JSON.parse(
        (await this.archive.read(j, j.input, "recipe.json")).toString(),
      ) as MediaExportRecipe;
      // Exact archive bytes were validated by the bounded preparation worker; the native executor independently verifies its cloned scene.
      validatedRecipe(scene, recipe);
      if (
        scene.sceneHash !== j.sceneHash ||
        canonicalJSON(recipe) !== canonicalJSON(j.recipe) ||
        hash(
          canonicalJSON({
            sceneHash: scene.sceneHash,
            recipe,
            runtimeIdentity: identity,
          }),
        ) !== j.requestHash
      )
        throw fail(
          422,
          "MEDIA_INPUT_CHANGED",
          "The frozen media input does not match its admitted identity.",
        );
      if (controller.signal.aborted) throw abortError();
      const output = await this.options.executor.execute({
        runtimeIdentity: j.runtimeIdentity,
        scene,
        recipe,
        signal: controller.signal,
        onProgress: check,
      });
      if (controller.signal.aborted) throw abortError();
      await check("saving");
      const inventory = validateOutput(output, j, scene);
      const files = Object.fromEntries(
        Object.entries(output.files).map(([n, b]) => [n, Buffer.from(b)]),
      );
      files["scene.json"] = Buffer.from(canonicalJSON(scene));
      files["recipe.json"] = Buffer.from(canonicalJSON(recipe));
      publication = await this.archive.stage(j, files);
      const reference = publication.reference;
      await this.store.transaction(
        (s) => {
          const live = s.mediaJobs.find((x) => x.id === j.id);
          if (
            !live ||
            live.status !== "running" ||
            live.workerId !== this.workerId ||
            live.cancelRequested ||
            !creatorCanEdit(s, live)
          )
            throw abortError();
          const slot = s.nativeCapacity.slot;
          if (
            !slot ||
            slot.token !== j.capacityToken ||
            slot.status !== "running" ||
            Date.parse(slot.hardDeadlineAt) <= Date.now()
          )
            throw abortError();
          const artifact: MediaArtifactRecord = {
            id: randomUUID(),
            organizationId: j.organizationId,
            projectId: j.projectId,
            userId: j.userId,
            jobId: j.id,
            createdAt: now(),
            sceneHash: j.sceneHash,
            requestHash: j.requestHash,
            runtimeIdentity: j.runtimeIdentity,
            archive: reference,
            files: inventory,
          };
          s.mediaArtifacts.push(artifact);
          live.result = {
            artifactId: artifact.id,
            archiveHash: reference.sha256,
            files: inventory,
          };
          live.status = "completed";
          live.stage = "complete";
          live.completedFrames = live.totalFrames;
          live.version++;
          live.updatedAt = now();
          const a = live.attempts.at(-1)!;
          a.endedAt = now();
          a.outcome = "completed";
          a.elapsedMilliseconds = Math.round(performance.now() - began);
          delete live.workerId;
          delete live.leaseExpiresAt;
          releaseNativeCapacity(s, j.capacityToken!, { reason: "completed" });
        },
        { ...this.workerScope(j.id), mediaArtifacts: { append: true } },
      );
      retained = true;
    } catch (e) {
      cleanupUnconfirmed =
        e instanceof ApiError && e.code === "NATIVE_CLEANUP_UNCONFIRMED";
      await this.store.transaction((s) => {
        const live = s.mediaJobs.find((x) => x.id === j.id);
        if (
          !live ||
          live.status !== "running" ||
          live.workerId !== this.workerId
        )
          return;
        live.status =
          live.cancelRequested || controller.signal.aborted
            ? "cancelled"
            : "failed";
        live.error = failure(e);
        live.version++;
        live.updatedAt = now();
        const a = live.attempts.at(-1)!;
        a.endedAt = now();
        a.outcome = live.status;
        a.elapsedMilliseconds = Math.round(performance.now() - began);
        delete live.workerId;
        delete live.leaseExpiresAt;
        const slot = s.nativeCapacity.slot;
        if (!slot || slot.token !== j.capacityToken) return;
        if (cleanupUnconfirmed || slot.status === "quarantined")
          quarantineNativeCapacity(
            s,
            j.capacityToken!,
            "The media runtime could not confirm every rendering/encoding process stopped.",
          );
        else
          releaseNativeCapacity(s, j.capacityToken!, {
            reason: "confirmed-stopped",
          });
      }, this.workerScope(j.id));
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (publication) {
        if (!retained)
          retained = await this.referenced(publication.reference.sha256);
        await publication.settle(retained);
      }
      this.controller = undefined;
      this.activeId = undefined;
    }
  }
}
function validateOutput(
  output: Awaited<ReturnType<MediaExecutor["execute"]>>,
  job: MediaJobRecord,
  scene: MediaScene,
): MediaFile[] {
  const allow: Record<string, string> = {
    "output.png": "image/png",
    "output.mp4": "video/mp4",
    "manifest.json": "application/json",
    "transcript.txt": "text/plain; charset=utf-8",
    "captions.vtt": "text/vtt; charset=utf-8",
    "thumbnail.png": "image/png",
    "frames.json": "application/json",
  };
  const main = job.recipe.format === "png" ? "output.png" : "output.mp4";
  if (
    !output.files[main] ||
    !output.files["manifest.json"] ||
    Object.keys(output.files).length > 7
  )
    throw fail(
      422,
      "MEDIA_OUTPUT_INVALID",
      "The renderer did not return its complete media and provenance.",
    );
  let total = 0;
  const inventory = Object.entries(output.files).map(([name, body]) => {
    if (
      !allow[name] ||
      output.contentTypes[name] !== allow[name] ||
      !(body instanceof Uint8Array) ||
      !body.byteLength
    )
      throw fail(
        422,
        "MEDIA_OUTPUT_INVALID",
        "Unexpected media artifact file or content type.",
      );
    total += body.byteLength;
    if (total > MEDIA_ARCHIVE_LIMITS.bundleBytes - 32 * 1024 ** 2)
      throw fail(
        413,
        "MEDIA_OUTPUT_TOO_LARGE",
        "The media output exceeds its bounded archive capacity.",
      );
    return {
      name,
      contentType: allow[name],
      sha256: hash(body),
      bytes: body.byteLength,
    };
  });
  const manifest = JSON.parse(
    Buffer.from(output.files["manifest.json"]).toString(),
  ) as MediaExportManifest;
  if (
    manifest.runtime.profileVersion !== job.runtimeIdentity.profileVersion ||
    manifest.runtime.hash !== job.runtimeIdentity.runtimeHash ||
    manifest.renderer.profileHash !== job.runtimeIdentity.rendererHash
  )
    throw fail(
      422,
      "MEDIA_RUNTIME_CHANGED",
      "The artifact runtime does not match the admitted renderer.",
    );
  assertMediaExportManifest(
    scene,
    job.recipe,
    manifest,
    JSON.parse(Buffer.from(output.files["frames.json"] ?? []).toString()),
  );
  if (
    canonicalJSON(
      [...manifest.files].sort((a, b) => a.name.localeCompare(b.name)),
    ) !==
    canonicalJSON(
      inventory
        .filter((f) => f.name !== "manifest.json")
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
  )
    throw fail(
      422,
      "MEDIA_OUTPUT_INVALID",
      "The media manifest does not match every returned output file.",
    );
  if (
    !output.files["frames.json"] ||
    hash(output.files["frames.json"]) !== manifest.frameReceiptsHash ||
    Buffer.from(output.files["transcript.txt"] ?? []).toString() !==
      mediaTranscript(scene, job.recipe) ||
    Buffer.from(output.files["captions.vtt"] ?? []).toString() !==
      mediaWebVtt(scene, job.recipe)
  )
    throw fail(
      422,
      "MEDIA_OUTPUT_INVALID",
      "The media frame receipts or complete authored text changed.",
    );
  return inventory;
}
