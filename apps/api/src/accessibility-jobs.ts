import {
  acquireNativeCapacity,
  assertNativeCapacityAvailable,
  heartbeatNativeCapacity,
  releaseNativeCapacity,
  quarantineNativeCapacity,
} from "./native-capacity.js";
import { randomUUID } from "node:crypto";
import {
  baselineIdentity,
  canonicalJSON,
  accessibilityContentHash,
  accessibilityRequestSchema,
  type AccessibilityRequest,
} from "@urban/core";
import { z } from "zod";
import { ApiError } from "./errors.js";
import {
  addAudit,
  findProject,
  type DataState,
  type Store,
  type authorize,
} from "./store.js";
import { findProjectHeader, projectAccess } from "./project-access.js";
import type { StoreScope } from "./store-scope.js";
import { assertBudgetCostEvidence, budgetDashboard } from "./budget.js";
import { RoutingError } from "./routing/index.js";
import { AccessibilityArchive } from "./accessibility-artifacts.js";
import type { AccessibilityExecutor } from "./accessibility-executor.js";
import type {
  AccessibilityJob,
  AccessibilityJobRecord,
  AccessibilityCapacityDeclaration,
  AccessibilityCapabilities,
  AccessibilityArtifactRecord,
} from "./accessibility-jobs-types.js";

export const ACCESSIBILITY_JOB_LIMITS = Object.freeze({
  queued: 10,
  pendingPerAccount: 1,
  startsPerAccountPerDay: 3,
  attempts: 3,
  concurrency: 1 as const,
  runSeconds: 660,
  retainedJobs: 10_000,
});
export const accessibilitySubmissionSchema = z
  .object({
    scenarioId: z.string().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(160),
    request: accessibilityRequestSchema,
  })
  .strict();
export type AccessibilitySubmission = z.infer<
  typeof accessibilitySubmissionSchema
>;
type Authenticate = (state: DataState) => ReturnType<typeof authorize>;
const worker = { mode: "worker", purpose: "accessibility" } as const;
const roles = ["owner", "editor"] as const;
const pending = (job: AccessibilityJobRecord) =>
  job.status === "queued" || job.status === "running";
const nowISO = () => new Date().toISOString();
const cancelled = () =>
  new ApiError(
    499,
    "ACCESSIBILITY_CANCELLED",
    "Accessibility routing was cancelled.",
  );
export function publicAccessibilityJob(
  record: AccessibilityJobRecord,
): AccessibilityJob {
  const {
    organizationId: _o,
    userId: _u,
    idempotencyKey: _k,
    requestKeys: _r,
    workerId: _w,
    leaseExpiresAt: _l,
    capacityToken: _c,
    ...job
  } = record;
  return structuredClone({
    ...job,
    attempts: job.attempts.map((attempt) => {
      const { availableCents: _privateBudget, ...admission } =
        attempt.admission as typeof attempt.admission & {
          availableCents?: number;
        };
      return { ...attempt, admission };
    }),
  });
}
function currentCreatorCanEdit(state: DataState, job: AccessibilityJobRecord) {
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
  input: AccessibilitySubmission,
) {
  const scenario = record.project.scenarios.find(
    (s) => s.id === input.scenarioId,
  );
  if (!scenario || scenario.id === "baseline")
    throw new ApiError(
      400,
      "ACCESSIBILITY_SCENARIO_REQUIRED",
      "Choose a saved editable proposal scenario.",
    );
  if (
    record.version !== input.expectedVersion ||
    scenario.revision !== input.expectedRevision
  )
    throw new ApiError(
      409,
      "REVISION_CONFLICT",
      "The saved project or scenario changed. Save or reopen it before requesting accessibility routing.",
    );
  return scenario;
}
function admission(
  state: DataState,
  declaration: AccessibilityCapacityDeclaration | undefined,
) {
  if (
    !declaration ||
    declaration.mode !== "fixed-capacity" ||
    declaration.statement.trim().length < 12
  )
    throw new ApiError(
      503,
      "ACCESSIBILITY_COST_MODEL_UNCONFIGURED",
      "An operator must explicitly declare the existing fixed routing capacity before jobs can start.",
    );
  const budget = budgetDashboard(state.budget);
  if (state.budget.policy.paidOperationsPaused)
    throw new ApiError(
      503,
      "ACCESSIBILITY_CAPACITY_PAUSED",
      "Costly processing is paused by the platform administrator. Queued work will not start.",
    );
  assertBudgetCostEvidence(state.budget);
  if (budget.totals.availableCents <= 0)
    throw new ApiError(
      429,
      "ACCESSIBILITY_BUDGET_EXHAUSTED",
      "The operating budget has no safe headroom for another routing attempt.",
    );
  if (
    declaration.environment === "deployment" &&
    state.budget.policy.fixedCostReserveCents <= 0 &&
    budget.totals.recordedFixedCents <= 0
  )
    throw new ApiError(
      503,
      "ACCESSIBILITY_FIXED_COST_UNRECORDED",
      "Record or reserve the deployment's fixed hosting cost before admitting routing jobs.",
    );
  return {
    budgetPolicyVersion: state.budget.policy.version,
    period: budget.period,
    incrementalExternalCents: 0 as const,
    costModel: structuredClone(declaration),
  };
}
function failure(error: unknown, retryable = true) {
  const safe = error instanceof ApiError || error instanceof RoutingError;
  return {
    code: safe ? error.code : "ACCESSIBILITY_FAILED",
    message: safe
      ? error.message
      : "The captured routing evidence could not be completed or verified. No partial result was published.",
    retryable:
      retryable &&
      !(
        safe &&
        ([400, 413, 422].includes(error.statusCode) ||
          error.code === "ACCESSIBILITY_SOURCE_CHANGED" ||
          error.code === "ROUTING_SITE_UNSNAPPABLE")
      ),
  };
}
function identityMatches(
  job: AccessibilityJobRecord,
  input: AccessibilitySubmission,
) {
  return (
    job.scenarioId === input.scenarioId &&
    job.projectVersion === input.expectedVersion &&
    job.scenarioRevision === input.expectedRevision &&
    canonicalJSON(job.request) === canonicalJSON(input.request)
  );
}

export class AccessibilityJobService {
  private workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private controller?: AbortController;
  private activeJobId?: string;
  private stopped = false;
  readonly archive: AccessibilityArchive;
  constructor(
    readonly store: Store,
    readonly options: {
      enabled: boolean;
      executor?: AccessibilityExecutor;
      archiveDirectory: string;
      capacity?: AccessibilityCapacityDeclaration;
      automaticWorker?: boolean;
    },
  ) {
    this.archive = new AccessibilityArchive(options.archiveDirectory);
  }
  async capabilities(): Promise<AccessibilityCapabilities> {
    let region: AccessibilityCapabilities["region"] = null;
    let reason: string | null = null;
    let source: Pick<AccessibilityCapabilities, "source" | "sourceIdentities"> =
      { source: null, sourceIdentities: null };
    const configured = Boolean(this.options.executor && this.options.capacity);
    if (!this.options.enabled)
      reason =
        "Regional accessibility jobs are disabled on this server. Saved evidence remains available.";
    else if (!configured)
      reason =
        "The operator has not configured a verified source pack, routing graph, and fixed-capacity cost declaration.";
    else
      try {
        region = await this.options.executor!.describe();
        source = (await this.options.executor!.sourceMetadata?.()) ?? source;
        await this.store.read(
          (state) => {
            assertNativeCapacityAvailable(state);
            return admission(state, this.options.capacity);
          },
          { security: worker, budget: true, nativeCapacity: true },
        );
      } catch (error) {
        reason = failure(error).message;
      }
    return {
      enabled: this.options.enabled && configured && !reason,
      configured,
      reason,
      region,
      ...source,
      modes: {
        car: Boolean(region && !reason),
        walk: Boolean(region && !reason),
        transit: false,
      },
      direction: "outbound",
      thresholdsMinutes: [15, 30, 45],
      limits: ACCESSIBILITY_JOB_LIMITS,
      cost: {
        model: this.options.capacity ?? null,
        perQueryProviderChargeCents: this.options.capacity ? 0 : null,
        metered: false,
        externalChargesCapped: false,
        notes: [
          "Routing uses operator-declared existing fixed capacity; there is no paid per-query provider.",
          "CPU and elapsed time are recorded separately from dollars. Hosting bills and other external charges are not automatically measured or capped.",
          ...(this.options.capacity?.environment === "local-development"
            ? [
                "Existing local development capacity is declared explicitly. This is not production cost validation.",
              ]
            : []),
        ],
      },
    };
  }
  private enabled() {
    if (!this.options.enabled)
      throw new ApiError(
        503,
        "ACCESSIBILITY_DISABLED",
        "New regional accessibility runs are disabled on this server.",
      );
    if (!this.options.executor)
      throw new ApiError(
        503,
        "ACCESSIBILITY_SOURCES_UNAVAILABLE",
        "No verified regional source pack and routing graph are configured.",
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
      accessibilityJobs: global ? { all: true } : { where: [{ projectId }] },
      audit: { append: true },
    };
  }
  async enqueue(
    projectId: string,
    input: AccessibilitySubmission,
    authenticate: Authenticate,
    sessionHash: string,
  ) {
    const captured = await this.store.read(
      (state) => {
        const identity = authenticate(state);
        const project = findProject(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          [...roles],
        );
        const existing = state.accessibilityJobs.find(
          (j) =>
            j.userId === identity.user.id &&
            j.projectId === projectId &&
            j.requestKeys.includes(input.idempotencyKey),
        );
        if (existing) {
          if (!identityMatches(existing, input))
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This request key already belongs to different accessibility inputs.",
            );
          return { existing };
        }
        assertVersion(project, input);
        return { project, identity };
      },
      {
        auth: { sessionHash },
        projects: {
          where: [
            { id: projectId, organizationId: { auth: "organizationId" } },
          ],
        },
        accessibilityJobs: { where: [{ projectId }] },
      },
    );
    if (captured.existing) return publicAccessibilityJob(captured.existing);
    this.enabled();
    const baselineHash = (await baselineIdentity(captured.project!.baseline))
      .sha256;
    const sourceIdentity = await this.options.executor!.preflight(
      input.request,
    );
    await this.archive.assertCapacity();
    const queryHash = await accessibilityContentHash({
      projectId,
      scenarioId: input.scenarioId,
      baselineHash,
      request: input.request,
      sourceIdentity,
    });
    const job = await this.store.transaction(
      (state) => {
        const identity = authenticate(state);
        const project = findProjectHeader(
          state,
          identity.organization.id,
          projectId,
          identity.user.id,
          [...roles],
        );
        const existing = state.accessibilityJobs.find(
          (j) =>
            j.userId === identity.user.id &&
            j.projectId === projectId &&
            j.requestKeys.includes(input.idempotencyKey),
        );
        if (existing) {
          if (!identityMatches(existing, input))
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This request key already belongs to different accessibility inputs.",
            );
          return existing;
        }
        assertVersion(project, input);
        admission(state, this.options.capacity);
        this.assertQueueCapacity(state, identity.user.id);
        const now = nowISO();
        const record: AccessibilityJobRecord = {
          id: randomUUID(),
          projectId,
          organizationId: identity.organization.id,
          userId: identity.user.id,
          scenarioId: input.scenarioId,
          projectVersion: input.expectedVersion,
          scenarioRevision: input.expectedRevision,
          placeId: project.project.placeId,
          baselineHash,
          request: structuredClone(input.request),
          sourceIdentity,
          queryHash,
          idempotencyKey: input.idempotencyKey,
          requestKeys: [input.idempotencyKey],
          version: 1,
          status: "queued",
          stage: "queued",
          progress: 0,
          attempt: 0,
          attempts: [],
          cancelRequested: false,
          createdAt: now,
          updatedAt: now,
        };
        state.accessibilityJobs.push(record);
        addAudit(state, {
          organizationId: record.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "accessibility.submitted",
          details: {
            jobId: record.id,
            scenarioId: record.scenarioId,
            queryHash,
            projectVersion: record.projectVersion,
            scenarioRevision: record.scenarioRevision,
          },
        });
        return record;
      },
      this.callerScope(projectId, sessionHash, true),
    );
    this.wake();
    return publicAccessibilityJob(job);
  }
  private assertQueueCapacity(
    state: DataState,
    userId: string,
    exceptId?: string,
  ) {
    if (
      !exceptId &&
      state.accessibilityJobs.length >= ACCESSIBILITY_JOB_LIMITS.retainedJobs
    )
      throw new ApiError(
        503,
        "ACCESSIBILITY_HISTORY_LIMIT",
        "The retained routing-job history needs operator archival before accepting new work.",
      );
    const queued = state.accessibilityJobs.filter(
      (j) => pending(j) && j.id !== exceptId,
    );
    if (queued.some((j) => j.userId === userId))
      throw new ApiError(
        429,
        "ACCESSIBILITY_ALREADY_PENDING",
        "This account already has a queued or running accessibility request.",
      );
    if (queued.length >= ACCESSIBILITY_JOB_LIMITS.queued)
      throw new ApiError(
        429,
        "ACCESSIBILITY_QUEUE_FULL",
        "The bounded accessibility queue is full. Try again later.",
      );
    const day = nowISO().slice(0, 10);
    const starts = state.accessibilityJobs
      .filter((j) => j.userId === userId)
      .flatMap((j) => j.attempts)
      .filter((a) => a.startedAt.startsWith(day)).length;
    if (starts >= ACCESSIBILITY_JOB_LIMITS.startsPerAccountPerDay)
      throw new ApiError(
        429,
        "ACCESSIBILITY_DAILY_LIMIT",
        "This account has used its three routing attempts for this UTC day. Cancelled and failed attempts remain counted.",
      );
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
        const job = state.accessibilityJobs.find(
          (j) => j.id === id && j.projectId === projectId,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Accessibility job not found.");
        if (job.status === "cancelled" || job.cancelRequested) return job;
        if (job.version !== expectedJobVersion)
          throw new ApiError(
            409,
            "ACCESSIBILITY_JOB_CHANGED",
            "The accessibility job changed. Refresh its status before cancelling.",
          );
        if (!pending(job))
          throw new ApiError(
            409,
            "ACCESSIBILITY_JOB_FINISHED",
            "This job has already finished.",
          );
        job.cancelRequested = true;
        job.version++;
        job.updatedAt = nowISO();
        if (job.status === "queued") job.status = "cancelled";
        addAudit(state, {
          organizationId: job.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "accessibility.cancelled",
          details: { jobId: id, attempt: job.attempt },
        });
        return job;
      },
      this.callerScope(projectId, sessionHash),
    );
    if (this.activeJobId === id) this.controller?.abort();
    return publicAccessibilityJob(job);
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
        const existing = state.accessibilityJobs.find(
          (job) => job.id === id && job.projectId === projectId,
        );
        if (!existing)
          throw new ApiError(404, "NOT_FOUND", "Accessibility job not found.");
        return existing.requestKeys.includes(key) ? existing : undefined;
      },
      this.callerScope(projectId, sessionHash),
    );
    if (accepted) return publicAccessibilityJob(accepted);
    this.enabled();
    await this.archive.assertCapacity();
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
        const job = state.accessibilityJobs.find(
          (j) => j.id === id && j.projectId === projectId,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Accessibility job not found.");
        if (job.requestKeys.includes(key)) return job;
        if (
          state.accessibilityJobs.some(
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
            "ACCESSIBILITY_JOB_CHANGED",
            "The job changed. Refresh before retrying.",
          );
        if (
          !["failed", "cancelled"].includes(job.status) ||
          job.attempt >= ACCESSIBILITY_JOB_LIMITS.attempts ||
          job.error?.retryable === false
        )
          throw new ApiError(
            409,
            "ACCESSIBILITY_NOT_RETRYABLE",
            "This job cannot be retried. Start a new saved request after resolving its source or coverage problem.",
          );
        // The original submitting account continues to own fair-use consumption; collaborators cannot reset it.
        if (!currentCreatorCanEdit(state, job))
          throw new ApiError(
            403,
            "ACCESSIBILITY_REQUESTER_REVOKED",
            "The original requester no longer has edit access. Submit a new request as an authorized editor.",
          );
        admission(state, this.options.capacity);
        this.assertQueueCapacity(state, job.userId, job.id);
        job.requestKeys.push(key);
        job.version++;
        job.status = "queued";
        job.stage = "queued";
        job.progress = 0;
        job.cancelRequested = false;
        job.updatedAt = nowISO();
        delete job.error;
        addAudit(state, {
          organizationId: job.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "accessibility.retried",
          details: { jobId: id, consumedAttempts: job.attempt },
        });
        return job;
      },
      {
        ...this.callerScope(projectId, sessionHash, true),
        memberships: {
          where: [{ userId: { from: "accessibilityJobs", field: "userId" } }],
        },
      },
    );
    this.wake();
    return publicAccessibilityJob(job);
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
    await this.active;
  }
  private workerScope(id?: string): StoreScope {
    return {
      security: worker,
      nativeCapacity: true,
      accessibilityJobs: id ? { where: [{ id }] } : { all: true },
      projectHeaders: {
        where: [{ id: { from: "accessibilityJobs", field: "projectId" } }],
      },
      memberships: {
        where: [{ userId: { from: "accessibilityJobs", field: "userId" } }],
      },
      budget: true,
    };
  }
  /** Explicit deterministic entry point for isolated tests/operators. The durable claim serializes multiple worker instances. */
  async runOne(): Promise<void> {
    if (
      this.stopped ||
      !this.options.enabled ||
      !this.options.executor ||
      !this.options.capacity
    )
      return;
    const job = await this.store.transaction((state) => {
      const now = nowISO();
      for (const stale of state.accessibilityJobs.filter(
        (j) =>
          j.status === "running" &&
          Date.parse(j.leaseExpiresAt ?? "") <= Date.now(),
      )) {
        stale.status = stale.cancelRequested ? "cancelled" : "failed";
        stale.error = {
          code: "ACCESSIBILITY_INTERRUPTED",
          message:
            "The previous worker stopped. Its consumed attempt is retained; retry explicitly to run again.",
          retryable: stale.attempt < ACCESSIBILITY_JOB_LIMITS.attempts,
        };
        stale.updatedAt = now;
        stale.version++;
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
      if (state.accessibilityJobs.some((j) => j.status === "running")) return;
      const next = state.accessibilityJobs.find(
        (j) => j.status === "queued" && !j.cancelRequested,
      );
      if (!next) return;
      if (!currentCreatorCanEdit(state, next)) {
        next.status = "failed";
        next.version++;
        next.updatedAt = now;
        next.error = {
          code: "ACCESSIBILITY_REQUESTER_REVOKED",
          message:
            "The requester no longer has project edit access, or the scenario was removed. No routing was started.",
          retryable: false,
        };
        return;
      }
      try {
        this.assertQueueCapacity(state, next.userId, next.id);
      } catch (error) {
        next.status = "failed";
        next.version++;
        next.updatedAt = now;
        next.error = failure(error);
        return;
      }
      let cost;
      try {
        cost = admission(state, this.options.capacity);
      } catch (error) {
        const e = failure(error);
        if (next.error?.code !== e.code) {
          next.error = e;
          next.updatedAt = now;
        }
        return;
      }
      const capacityLease = acquireNativeCapacity(state, {
        kind: "accessibility",
        jobId: next.id,
        workerId: this.workerId,
        runMilliseconds: ACCESSIBILITY_JOB_LIMITS.runSeconds * 1000,
      });
      if (!capacityLease) return;
      next.capacityToken = capacityLease.token;
      next.status = "running";
      next.stage = "validating";
      next.progress = 5;
      next.attempt++;
      next.version++;
      next.updatedAt = now;
      next.workerId = this.workerId;
      next.leaseExpiresAt = new Date(Date.now() + 180_000).toISOString();
      next.attempts.push({
        number: next.attempt,
        startedAt: now,
        admission: cost,
      });
      delete next.error;
      return structuredClone(next);
    }, this.workerScope());
    if (!job) return;
    const started = performance.now();
    const controller = new AbortController();
    this.controller = controller;
    this.activeJobId = job.id;
    const timeout = setTimeout(
      () => controller.abort(),
      ACCESSIBILITY_JOB_LIMITS.runSeconds * 1000,
    );
    timeout.unref();
    let heartbeatActive = false;
    const check = async (stage?: AccessibilityJobRecord["stage"]) =>
      this.store.transaction((state) => {
        const current = state.accessibilityJobs.find((j) => j.id === job.id);
        if (
          !current ||
          current.workerId !== this.workerId ||
          current.status !== "running" ||
          current.cancelRequested ||
          !currentCreatorCanEdit(state, current)
        )
          throw cancelled();
        heartbeatNativeCapacity(state, job.capacityToken!);
        current.leaseExpiresAt = new Date(Date.now() + 180_000).toISOString();
        if (stage) {
          current.stage = stage;
          current.progress = {
            validating: 5,
            routing: 10,
            aggregating: 75,
            contours: 85,
            saving: 95,
            complete: 100,
            queued: 0,
          }[stage];
          current.updatedAt = nowISO();
        }
      }, this.workerScope(job.id));
    const heartbeat = setInterval(() => {
      if (heartbeatActive) return;
      heartbeatActive = true;
      void check()
        .catch(() => controller.abort())
        .finally(() => {
          heartbeatActive = false;
        });
    }, 15_000);
    heartbeat.unref();
    let progress = Promise.resolve();
    let nativeStarted = false,
      nativeFinished = false;
    try {
      await this.archive.assertCapacity();
      const identity = await this.options.executor.preflight(job.request);
      if (canonicalJSON(identity) !== canonicalJSON(job.sourceIdentity))
        throw new ApiError(
          409,
          "ACCESSIBILITY_SOURCE_CHANGED",
          "The configured regional source or profile changed. Submit a new request so its evidence is explicit.",
        );
      await check("validating");
      controller.signal.throwIfAborted();
      nativeStarted = true;
      const result = await this.options.executor.execute({
        request: job.request,
        binding: { placeId: job.placeId, baselineHash: job.baselineHash },
        receipt: { jobId: job.id, projectId: job.projectId },
        signal: controller.signal,
        progress: (stage) => {
          progress = progress
            .then(() => check(stage))
            .catch((error) => {
              controller.abort();
              throw error;
            });
          void progress.catch(() => {});
        },
      });
      nativeFinished = true;
      await progress;
      await check("saving");
      controller.signal.throwIfAborted();
      if (
        canonicalJSON(result.accessibility.capture.request) !==
          canonicalJSON(job.request) ||
        result.accessibility.capture.jobsPackHash !==
          job.sourceIdentity.jobsPackHash ||
        result.accessibility.capture.network.graphHash !==
          job.sourceIdentity.graphHash ||
        result.accessibility.capture.network.profileHash !==
          job.sourceIdentity.profileHash ||
        result.accessibility.capture.network.id !==
          job.sourceIdentity.manifestId ||
        result.accessibility.capture.methodVersion !==
          job.sourceIdentity.methodVersion ||
        result.accessibility.capture.coverage.destinations.boundaryHash !==
          job.sourceIdentity.boundaryHash ||
        result.accessibility.binding.baselineHash !== job.baselineHash ||
        result.accessibility.binding.placeId !== job.placeId ||
        result.accessibility.receipt.projectId !== job.projectId ||
        result.accessibility.receipt.jobId !== job.id
      )
        throw new ApiError(
          502,
          "ACCESSIBILITY_RESULT_MISMATCH",
          "The worker result does not match the admitted project, source, and request.",
        );
      const raw = await this.archive.put(result.artifact);
      if (raw.hash !== result.accessibility.capture.artifactHash)
        throw new ApiError(
          502,
          "ACCESSIBILITY_RESULT_MISMATCH",
          "The private artifact hash does not match its captured summary.",
        );
      await this.store.transaction(
        (state) => {
          const current = state.accessibilityJobs.find((j) => j.id === job.id);
          if (
            !current ||
            current.workerId !== this.workerId ||
            current.status !== "running" ||
            current.cancelRequested ||
            !currentCreatorCanEdit(state, current) ||
            controller.signal.aborted
          )
            throw cancelled();
          const now = nowISO(),
            id = randomUUID();
          const artifact: AccessibilityArtifactRecord = {
            scenarioId: job.scenarioId,
            id,
            organizationId: job.organizationId,
            projectId: job.projectId,
            jobId: job.id,
            createdAt: now,
            accessibility: result.accessibility,
            contour: result.artifact.contour,
            siteSnapMeters: result.artifact.provider.siteSnapMeters,
            rawFileHash: raw.hash,
            rawFileBytes: raw.bytes,
          };
          state.accessibilityArtifacts.push(artifact);
          current.result = {
            artifactId: id,
            resultHash: result.accessibility.capture.resultHash,
            inputHash: result.accessibility.capture.inputHash,
            captureHash: result.accessibility.captureHash,
          };
          current.status = "completed";
          current.stage = "complete";
          current.progress = 100;
          current.version++;
          current.updatedAt = now;
          delete current.workerId;
          delete current.leaseExpiresAt;
          delete current.error;
          const attempt = current.attempts.at(-1)!;
          attempt.endedAt = now;
          attempt.outcome = "completed";
          attempt.elapsedMilliseconds = performance.now() - started;
        },
        {
          ...this.workerScope(job.id),
          accessibilityArtifacts: { append: true },
        },
      );
    } catch (error) {
      await this.store.transaction((state) => {
        const current = state.accessibilityJobs.find((j) => j.id === job.id);
        if (
          !current ||
          current.workerId !== this.workerId ||
          current.status !== "running"
        )
          return;
        const now = nowISO();
        current.status = current.cancelRequested ? "cancelled" : "failed";
        current.version++;
        current.updatedAt = now;
        current.error = failure(
          error,
          current.attempt < ACCESSIBILITY_JOB_LIMITS.attempts,
        );
        if (this.stopped)
          current.error = {
            code: "ACCESSIBILITY_INTERRUPTED",
            message:
              "The server stopped during this attempt. Retry explicitly; consumed capacity remains recorded.",
            retryable: current.attempt < ACCESSIBILITY_JOB_LIMITS.attempts,
          };
        delete current.workerId;
        delete current.leaseExpiresAt;
        const attempt = current.attempts.at(-1);
        if (attempt) {
          attempt.endedAt = now;
          attempt.outcome =
            current.status === "cancelled" ? "cancelled" : "failed";
          attempt.elapsedMilliseconds = performance.now() - started;
        }
      }, this.workerScope(job.id));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
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
          if (!nativeStarted || nativeFinished)
            releaseNativeCapacity(state, job.capacityToken!, {
              reason: nativeFinished ? "completed" : "not-started",
            });
          else
            quarantineNativeCapacity(
              state,
              job.capacityToken!,
              "The routing request ended without proof that the native service stopped. A trusted operator must confirm termination before capacity is reused.",
            );
        },
        { security: worker, nativeCapacity: true },
      );
    }
  }
}
