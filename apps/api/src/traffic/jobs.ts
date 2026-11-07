import { verifyPlanningRequest } from "./planning-review.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  baselineIdentity,
  canonicalJSON,
  trafficContentHash,
  trafficRoadEditsHash,
  type Place,
} from "@urban/core";
import { ApiError } from "../errors.js";
import { verifyPreparedCommuteRequest } from "./commute-evidence.js";
import { TRAFFIC_ARCHIVE_LIMITS } from "./archive.js";
import { assertBudgetCostEvidence, budgetDashboard } from "../budget.js";
import { addAudit, type DataState } from "../store.js";
import { findProjectHeader, projectAccess } from "../project-access.js";
import type { StoreScope } from "../store-scope.js";
import {
  acquireNativeCapacity,
  assertNativeCapacityAvailable,
  heartbeatNativeCapacity,
  quarantineNativeCapacity,
  releaseNativeCapacity,
} from "../native-capacity.js";
import {
  TrafficConfigurations,
  trafficCallerScope,
  trafficWriterRoles,
  type TrafficAuthenticate,
} from "./configurations.js";
import {
  prepareTrafficExperiment,
  runTrafficExperiment,
} from "./experiment.js";
import { createTrafficScenarioFromArchive } from "./capture.js";
import type { TrafficArchivePublication } from "./archive.js";
import type {
  TrafficCapabilities,
  TrafficCapacityDeclaration,
  TrafficConfigurationRecord,
  TrafficJob,
  TrafficJobRecord,
  TrafficArtifactRecord,
} from "./jobs-types.js";

export const TRAFFIC_JOB_LIMITS = Object.freeze({
  queued: 10,
  pendingPerAccount: 1,
  startsPerAccountPerDay: 3,
  attempts: 3,
  concurrency: 1 as const,
  runSeconds: 360,
  uploadBytes: 5 * 1024 ** 2,
  configurationBytes: 8 * 1024 ** 2,
  retainedJobs: 10000,
});
export const trafficStartSchema = z
  .object({
    configurationId: z.string().min(1).max(160),
    expectedVersion: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(8).max(160),
  })
  .strict();
type Start = z.infer<typeof trafficStartSchema>;
const worker = { mode: "worker", purpose: "traffic" } as const;
const nowISO = () => new Date().toISOString();
const same = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const pending = (j: TrafficJobRecord) =>
  j.status === "queued" || j.status === "running";
const cancelled = () =>
  new ApiError(
    499,
    "TRAFFIC_CANCELLED",
    "Traffic processing was cancelled or its project access was revoked.",
  );
export function publicTrafficJob(record: TrafficJobRecord): TrafficJob {
  const {
    organizationId: _o,
    userId: _u,
    idempotencyKey: _i,
    requestKeys: _r,
    workerId: _w,
    leaseExpiresAt: _l,
    capacityToken: _c,
    ...value
  } = record;
  return structuredClone(value);
}
function creatorCanEdit(state: DataState, job: TrafficJobRecord) {
  const project = state.projectHeaders.find(
      (p) =>
        p.project.id === job.projectId &&
        p.organizationId === job.organizationId,
    ),
    member = state.memberships.find(
      (m) => m.userId === job.userId && m.organizationId === job.organizationId,
    );
  return !!(
    project &&
    member &&
    projectAccess(project, job.userId, member)?.canEdit &&
    project.project.scenarios.some((s) => s.id === job.scenarioId)
  );
}
function admission(
  state: DataState,
  declaration: TrafficCapacityDeclaration | undefined,
) {
  if (
    !declaration ||
    declaration.mode !== "fixed-capacity" ||
    declaration.statement.trim().length < 12
  )
    throw new ApiError(
      503,
      "TRAFFIC_COST_MODEL_UNCONFIGURED",
      "An operator must declare the existing fixed traffic-processing capacity before runs can start.",
    );
  const budget = budgetDashboard(state.budget);
  if (state.budget.policy.paidOperationsPaused)
    throw new ApiError(
      503,
      "TRAFFIC_CAPACITY_PAUSED",
      "Costly processing is paused by the platform administrator. Queued runs will not start.",
    );
  assertBudgetCostEvidence(state.budget);
  if (budget.totals.availableCents <= 0)
    throw new ApiError(
      429,
      "TRAFFIC_BUDGET_EXHAUSTED",
      "The operating budget has no safe headroom for another traffic attempt.",
    );
  if (
    declaration.environment === "deployment" &&
    state.budget.policy.fixedCostReserveCents <= 0 &&
    budget.totals.recordedFixedCents <= 0
  )
    throw new ApiError(
      503,
      "TRAFFIC_FIXED_COST_UNRECORDED",
      "Record or reserve the deployment's fixed hosting cost before admitting traffic runs.",
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
    code: safe ? error.code : "TRAFFIC_FAILED",
    message: safe
      ? error.message
      : "The captured traffic evidence could not be completed or verified. No partial result was published.",
    retryable:
      retryable &&
      !(
        safe &&
        ([400, 413, 422].includes(error.statusCode) ||
          ["TRAFFIC_SOURCE_CHANGED", "TRAFFIC_CONFIGURATION_STALE"].includes(
            error.code,
          ))
      ),
  };
}
function assertConfigVersion(
  config: TrafficConfigurationRecord,
  project: {
    version: number;
    project: { scenarios: { id: string; revision: number }[] };
  },
  input: Start,
) {
  const scenario = project.project.scenarios.find(
    (s) => s.id === config.scenarioId,
  );
  if (
    !scenario ||
    scenario.id === "baseline" ||
    project.version !== input.expectedVersion ||
    scenario.revision !== input.expectedRevision
  )
    throw new ApiError(
      409,
      "TRAFFIC_CONFIGURATION_STALE",
      "The saved project changed while this run was requested. Reopen its current version before continuing.",
    );
}
export class TrafficJobService extends TrafficConfigurations {
  private workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private controller?: AbortController;
  private activeJobId?: string;
  private stopped = false;
  async capabilities(
    place: Place,
    preparedId?: string,
  ): Promise<TrafficCapabilities> {
    let prepared: TrafficCapabilities["prepared"] = null,
      reason: string | null = null;
    const configured = !!(
      this.options.catalog &&
      this.options.runtime &&
      this.options.capacity
    );
    if (!this.options.enabled)
      reason =
        "New traffic runs are disabled on this server. Saved configurations and evidence remain available.";
    else if (!configured)
      reason =
        "The operator has not configured a verified study-area graph, native runtime and fixed-capacity declaration.";
    if (this.options.catalog)
      try {
        prepared = (await this.options.catalog.forPlace(place, preparedId))
          .identity;
      } catch (error) {
        reason = failure(error).message;
      }
    if (!reason)
      try {
        await this.store.read(
          (state) => {
            admission(state, this.options.capacity);
            assertNativeCapacityAvailable(state);
          },
          { security: worker, budget: true, nativeCapacity: true },
        );
        if (!(await this.options.runtime!.available()).available)
          reason =
            "The pinned native traffic runtime is unavailable. No run was started.";
      } catch (error) {
        reason = failure(error).message;
      }
    return {
      enabled: this.options.enabled && configured && !reason,
      configured,
      reason,
      prepared,
      limits: TRAFFIC_JOB_LIMITS,
      cost: {
        model: this.options.capacity ?? null,
        perRunProviderChargeCents: this.options.capacity ? 0 : null,
        externalChargesCapped: false,
        notes: [
          "Traffic runs use operator-declared fixed capacity with no paid per-run provider. The platform budget is rechecked when each attempt starts.",
          "CPU, memory and elapsed time are evidence, not automatically measured hosting charges. External bills are not capped by this application.",
          ...(this.options.capacity?.environment === "local-development"
            ? [
                "Existing local development capacity is declared explicitly; this is not production cost validation.",
              ]
            : []),
        ],
      },
      supported: {
        closures: true,
        directionalLanes: true,
        speed: true,
        geometry: false,
        signalTiming: true,
        turnRestrictions: false,
        pedestrians: false,
      },
    };
  }
  private enabled() {
    if (!this.options.enabled)
      throw new ApiError(
        503,
        "TRAFFIC_DISABLED",
        "New traffic runs are disabled on this server.",
      );
    this.configured();
    if (!this.options.runtime)
      throw new ApiError(
        503,
        "TRAFFIC_RUNTIME_UNAVAILABLE",
        "No verified native traffic runtime is configured.",
      );
  }
  private callerJobs(
    projectId: string,
    sessionHash: string,
    global = false,
  ): StoreScope {
    return {
      ...trafficCallerScope(projectId, sessionHash),
      ...(global ? { security: worker, budget: true } : {}),
      trafficJobs: global ? { all: true } : { where: [{ projectId }] },
    };
  }
  private queueCapacity(state: DataState, userId: string, exceptId?: string) {
    if (
      !exceptId &&
      state.trafficJobs.length >= TRAFFIC_JOB_LIMITS.retainedJobs
    )
      throw new ApiError(
        503,
        "TRAFFIC_HISTORY_LIMIT",
        "Retained traffic-job history needs operator archival before accepting more work.",
      );
    const queued = state.trafficJobs.filter(
      (j) => pending(j) && j.id !== exceptId,
    );
    if (queued.some((j) => j.userId === userId))
      throw new ApiError(
        429,
        "TRAFFIC_ALREADY_PENDING",
        "This account already has a queued or running traffic request.",
      );
    if (queued.length >= TRAFFIC_JOB_LIMITS.queued)
      throw new ApiError(
        429,
        "TRAFFIC_QUEUE_FULL",
        "The bounded traffic queue is full. Try again later.",
      );
    const day = nowISO().slice(0, 10),
      starts = state.trafficJobs
        .filter((j) => j.userId === userId)
        .flatMap((j) => j.attempts)
        .filter((a) => a.startedAt.startsWith(day)).length;
    if (starts >= TRAFFIC_JOB_LIMITS.startsPerAccountPerDay)
      throw new ApiError(
        429,
        "TRAFFIC_DAILY_LIMIT",
        "This account has used its three traffic attempts for this UTC day. Cancelled and failed attempts remain counted.",
      );
  }
  async enqueue(
    projectId: string,
    input: Start,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
  ) {
    const scope = {
      ...this.callerJobs(projectId, sessionHash),
      projects: {
        where: [
          {
            id: projectId,
            organizationId: { auth: "organizationId" as const },
          },
        ],
      },
      trafficConfigs: { where: [{ id: input.configurationId, projectId }] },
      trafficConfigHeaders: { where: [{ projectId }] },
    } satisfies StoreScope;
    const captured = await this.store.read((state) => {
      const identity = authenticate(state);
      findProjectHeader(
        state,
        identity.organization.id,
        projectId,
        identity.user.id,
        [...trafficWriterRoles],
      );
      const existing = state.trafficJobs.find(
        (j) =>
          j.userId === identity.user.id &&
          j.projectId === projectId &&
          j.requestKeys.includes(input.idempotencyKey),
      );
      if (existing) {
        if (
          existing.configurationId !== input.configurationId ||
          existing.projectVersion !== input.expectedVersion ||
          existing.scenarioRevision !== input.expectedRevision
        )
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This run request key belongs to different saved inputs.",
          );
        return { existing };
      }
      const config = state.trafficConfigs.find(
          (c) => c.id === input.configurationId && c.projectId === projectId,
        ),
        record = state.projects.find((p) => p.project.id === projectId)!;
      if (!config)
        throw new ApiError(
          404,
          "NOT_FOUND",
          "The saved traffic configuration was not found.",
        );
      if (
        state.trafficConfigHeaders
          .filter(
            (c) =>
              c.scenarioId === config.scenarioId && c.projectId === projectId,
          )
          .at(-1)?.id !== config.id
      )
        throw new ApiError(
          409,
          "TRAFFIC_CONFIGURATION_CHANGED",
          "Review the most recently saved configuration before starting a new run.",
        );
      assertConfigVersion(config, record, input);
      return { config, record };
    }, scope);
    if (captured.existing) return publicTrafficJob(captured.existing);
    this.enabled();
    const { config, record } = captured as Required<
        Pick<typeof captured, "config" | "record">
      >,
      prepared = await this.configured().forPlace(
        record.baseline,
        config.prepared.id,
      );
    if (!same(prepared.identity, config.prepared))
      throw new ApiError(
        409,
        "TRAFFIC_SOURCE_CHANGED",
        "The prepared graph or worker changed. Save a newly reviewed configuration.",
      );
    const scenario = record.project.scenarios.find(
      (s) => s.id === config.scenarioId,
    )!;
    if (
      (await baselineIdentity(record.baseline)).sha256 !==
        config.baselineHash ||
      (await trafficRoadEditsHash(record.baseline, scenario)) !==
        config.roadEditsHash
    )
      throw new ApiError(
        409,
        "TRAFFIC_CONFIGURATION_STALE",
        "The baseline or planning-road context changed after this configuration was reviewed. Save a current traffic configuration before starting a new run.",
      );
    await prepareTrafficExperiment(prepared.network, config.request);
    await verifyPreparedCommuteRequest(
      config.request,
      prepared.network.network,
      config.request.commute
        ? ((await this.configured().commutePresets?.(
            record.baseline,
            config.prepared.id,
            true,
          )) ?? [])
        : [],
    );
    await this.archive.assertCapacity();
    const job = await this.store.transaction(
      (state) => {
        const identity = authenticate(state),
          project = findProjectHeader(
            state,
            identity.organization.id,
            projectId,
            identity.user.id,
            [...trafficWriterRoles],
          );
        const existing = state.trafficJobs.find(
          (j) =>
            j.userId === identity.user.id &&
            j.projectId === projectId &&
            j.requestKeys.includes(input.idempotencyKey),
        );
        if (existing) {
          if (
            existing.configurationId !== config.id ||
            existing.projectVersion !== input.expectedVersion ||
            existing.scenarioRevision !== input.expectedRevision
          )
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This run request key belongs to different saved inputs.",
            );
          return existing;
        }
        assertConfigVersion(config, project, input);
        if (
          state.trafficConfigHeaders
            .filter(
              (c) =>
                c.projectId === projectId && c.scenarioId === config.scenarioId,
            )
            .at(-1)?.id !== config.id
        )
          throw new ApiError(
            409,
            "TRAFFIC_CONFIGURATION_CHANGED",
            "A newer traffic configuration was saved while this request was being checked.",
          );
        admission(state, this.options.capacity);
        this.queueCapacity(state, identity.user.id);
        const now = nowISO(),
          job: TrafficJobRecord = {
            id: randomUUID(),
            projectId,
            organizationId: identity.organization.id,
            userId: identity.user.id,
            scenarioId: config.scenarioId,
            configurationId: config.id,
            projectVersion: input.expectedVersion,
            scenarioRevision: input.expectedRevision,
            baselineHash: config.baselineHash,
            roadEditsHash: config.roadEditsHash,
            requestHash: config.requestHash,
            prepared: config.prepared,
            version: 1,
            status: "queued",
            stage: "queued",
            progress: 0,
            attempt: 0,
            attempts: [],
            createdAt: now,
            updatedAt: now,
            cancelRequested: false,
            idempotencyKey: input.idempotencyKey,
            requestKeys: [input.idempotencyKey],
          };
        state.trafficJobs.push(job);
        addAudit(state, {
          organizationId: job.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "traffic.submitted",
          details: {
            jobId: job.id,
            configurationId: config.id,
            requestHash: config.requestHash,
          },
        });
        return job;
      },
      {
        ...this.callerJobs(projectId, sessionHash, true),
        trafficConfigHeaders: { where: [{ projectId }] },
      },
    );
    this.wake();
    return publicTrafficJob(job);
  }
  async cancel(
    projectId: string,
    id: string,
    expectedJobVersion: number,
    authenticate: TrafficAuthenticate,
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
          [...trafficWriterRoles],
        );
        const job = state.trafficJobs.find(
          (j) => j.id === id && j.projectId === projectId,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Traffic job not found.");
        if (job.status === "cancelled" || job.cancelRequested) return job;
        if (job.version !== expectedJobVersion)
          throw new ApiError(
            409,
            "TRAFFIC_JOB_CHANGED",
            "The traffic job changed. Refresh before cancelling.",
          );
        if (!pending(job))
          throw new ApiError(
            409,
            "TRAFFIC_JOB_FINISHED",
            "This traffic run has already finished.",
          );
        job.cancelRequested = true;
        job.version++;
        job.updatedAt = nowISO();
        if (job.status === "queued") job.status = "cancelled";
        addAudit(state, {
          organizationId: job.organizationId,
          projectId,
          actorId: identity.user.id,
          action: "traffic.cancelled",
          details: { jobId: id, attempt: job.attempt },
        });
        return job;
      },
      this.callerJobs(projectId, sessionHash),
    );
    if (this.activeJobId === id) this.controller?.abort();
    return publicTrafficJob(job);
  }
  async retry(
    projectId: string,
    id: string,
    expectedJobVersion: number,
    key: string,
    authenticate: TrafficAuthenticate,
    sessionHash: string,
  ) {
    const scope = {
      ...this.callerJobs(projectId, sessionHash, true),
      memberships: {
        where: [
          {
            userId: { from: "trafficJobs" as const, field: "userId" as const },
          },
        ],
      },
    };
    const accepted = await this.store.read((state) => {
      const identity = authenticate(state);
      findProjectHeader(
        state,
        identity.organization.id,
        projectId,
        identity.user.id,
        [...trafficWriterRoles],
      );
      const job = state.trafficJobs.find(
        (j) => j.id === id && j.projectId === projectId,
      );
      if (!job) throw new ApiError(404, "NOT_FOUND", "Traffic job not found.");
      return job.requestKeys.includes(key) ? job : undefined;
    }, scope);
    if (accepted) return publicTrafficJob(accepted);
    this.enabled();
    await this.archive.assertCapacity();
    const job = await this.store.transaction((state) => {
      const identity = authenticate(state);
      findProjectHeader(
        state,
        identity.organization.id,
        projectId,
        identity.user.id,
        [...trafficWriterRoles],
      );
      const job = state.trafficJobs.find(
        (j) => j.id === id && j.projectId === projectId,
      );
      if (!job) throw new ApiError(404, "NOT_FOUND", "Traffic job not found.");
      if (job.requestKeys.includes(key)) return job;
      if (
        state.trafficJobs.some(
          (j) =>
            j.projectId === projectId &&
            j.userId === identity.user.id &&
            j.requestKeys.includes(key),
        )
      )
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This retry key belongs to another traffic job.",
        );
      if (job.version !== expectedJobVersion)
        throw new ApiError(
          409,
          "TRAFFIC_JOB_CHANGED",
          "The traffic job changed. Refresh before retrying.",
        );
      if (
        !["failed", "cancelled"].includes(job.status) ||
        job.attempt >= TRAFFIC_JOB_LIMITS.attempts ||
        job.error?.retryable === false
      )
        throw new ApiError(
          409,
          "TRAFFIC_NOT_RETRYABLE",
          "This run cannot be retried. Resolve its evidence problem and submit a new reviewed configuration.",
        );
      if (!creatorCanEdit(state, job))
        throw new ApiError(
          403,
          "TRAFFIC_REQUESTER_REVOKED",
          "The original requester no longer has edit access. Submit a new request as an authorized editor.",
        );
      admission(state, this.options.capacity);
      this.queueCapacity(state, job.userId, job.id);
      job.requestKeys.push(key);
      job.status = "queued";
      job.stage = "queued";
      job.progress = 0;
      job.cancelRequested = false;
      job.version++;
      job.updatedAt = nowISO();
      delete job.error;
      addAudit(state, {
        organizationId: job.organizationId,
        projectId,
        actorId: identity.user.id,
        action: "traffic.retried",
        details: { jobId: id, consumedAttempts: job.attempt },
      });
      return job;
    }, scope);
    this.wake();
    return publicTrafficJob(job);
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
      budget: true,
      trafficJobs: id ? { where: [{ id }] } : { all: true },
      projectHeaders: {
        where: [{ id: { from: "trafficJobs", field: "projectId" } }],
      },
      memberships: {
        where: [{ userId: { from: "trafficJobs", field: "userId" } }],
      },
    };
  }
  /** Durable claim plus the common native slot serializes traffic, GIS and workforce workers. */
  async runOne(): Promise<void> {
    if (
      this.stopped ||
      !this.options.enabled ||
      !this.options.catalog ||
      !this.options.runtime ||
      !this.options.capacity
    )
      return;
    const job = await this.store.transaction((state) => {
      const now = nowISO();
      for (const stale of state.trafficJobs.filter(
        (j) =>
          j.status === "running" &&
          Date.parse(j.leaseExpiresAt ?? "") <= Date.now(),
      )) {
        stale.status = stale.cancelRequested ? "cancelled" : "failed";
        stale.version++;
        stale.updatedAt = now;
        stale.error = {
          code: "TRAFFIC_INTERRUPTED",
          message:
            "The previous traffic worker stopped. Its attempt remains counted; retry explicitly after native termination is confirmed.",
          retryable: stale.attempt < TRAFFIC_JOB_LIMITS.attempts,
        };
        const last = stale.attempts.at(-1);
        if (last) {
          last.endedAt = now;
          last.outcome = "interrupted";
        }
        if (state.nativeCapacity.slot?.token === stale.capacityToken)
          quarantineNativeCapacity(
            state,
            stale.capacityToken!,
            "A traffic worker lost its lease. Confirm native termination before processing more work.",
          );
        delete stale.workerId;
        delete stale.leaseExpiresAt;
      }
      if (state.trafficJobs.some((j) => j.status === "running")) return;
      const next = state.trafficJobs.find(
        (j) => j.status === "queued" && !j.cancelRequested,
      );
      if (!next) return;
      if (!creatorCanEdit(state, next)) {
        next.status = "failed";
        next.version++;
        next.updatedAt = now;
        next.error = {
          code: "TRAFFIC_REQUESTER_REVOKED",
          message:
            "The requester no longer has project edit access or the scenario was removed. No native run started.",
          retryable: false,
        };
        return;
      }
      try {
        this.queueCapacity(state, next.userId, next.id);
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
        const detail = failure(error);
        if (next.error?.code !== detail.code) {
          next.error = detail;
          next.version++;
          next.updatedAt = now;
        }
        return;
      }
      const lease = acquireNativeCapacity(state, {
        kind: "traffic",
        jobId: next.id,
        workerId: this.workerId,
        runMilliseconds: TRAFFIC_JOB_LIMITS.runSeconds * 1000,
      });
      if (!lease) {
        if (state.nativeCapacity.slot?.status === "quarantined") {
          const message =
            state.nativeCapacity.slot.reason ??
            "Shared native processing needs confirmed operator recovery before queued work can start.";
          if (
            next.error?.code !== "NATIVE_CAPACITY_QUARANTINED" ||
            next.error.message !== message
          ) {
            next.error = {
              code: "NATIVE_CAPACITY_QUARANTINED",
              message,
              retryable: true,
            };
            next.version++;
            next.updatedAt = now;
          }
        } else if (next.error) {
          delete next.error;
          next.version++;
          next.updatedAt = now;
        }
        return;
      }
      next.capacityToken = lease.token;
      next.status = "running";
      next.stage = "validating";
      next.progress = 5;
      next.attempt++;
      next.version++;
      next.updatedAt = now;
      next.workerId = this.workerId;
      next.leaseExpiresAt = new Date(Date.now() + 60000).toISOString();
      next.attempts.push({
        number: next.attempt,
        startedAt: now,
        admission: cost,
      });
      delete next.error;
      return structuredClone(next);
    }, this.workerScope());
    if (!job) return;
    const started = performance.now(),
      controller = new AbortController();
    this.controller = controller;
    this.activeJobId = job.id;
    const timeout = setTimeout(
      () => controller.abort(),
      TRAFFIC_JOB_LIMITS.runSeconds * 1000,
    );
    timeout.unref();
    let heartbeatActive = false,
      progress = Promise.resolve(),
      publication: TrafficArchivePublication | undefined,
      retain = true,
      cleanupUncertain = false;
    const check = async (stage?: TrafficJob["stage"]) =>
      this.store.transaction((state) => {
        const current = state.trafficJobs.find((j) => j.id === job.id);
        if (
          !current ||
          current.workerId !== this.workerId ||
          current.status !== "running" ||
          current.cancelRequested ||
          !creatorCanEdit(state, current) ||
          controller.signal.aborted
        )
          throw cancelled();
        heartbeatNativeCapacity(state, job.capacityToken!);
        current.leaseExpiresAt = new Date(Date.now() + 60000).toISOString();
        if (stage && stage !== current.stage) {
          current.stage = stage;
          current.progress = {
            queued: 0,
            validating: 5,
            simulating: 15,
            evaluating: 85,
            saving: 95,
            complete: 100,
          }[stage];
          current.version++;
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
    }, 15000);
    heartbeat.unref();
    try {
      const frozen = await this.store.read(
        (state) => {
          const record = state.projects.find(
              (p) =>
                p.project.id === job.projectId &&
                p.organizationId === job.organizationId,
            ),
            config = state.trafficConfigs.find(
              (c) =>
                c.id === job.configurationId && c.projectId === job.projectId,
            ),
            scenario = record?.project.scenarios.find(
              (s) => s.id === job.scenarioId,
            );
          if (!record || !config || !scenario)
            throw new ApiError(
              409,
              "TRAFFIC_CONFIGURATION_STALE",
              "The saved project or frozen traffic configuration is unavailable.",
            );
          return { record, config, scenario };
        },
        {
          ...this.workerScope(job.id),
          projects: {
            where: [{ id: { from: "trafficJobs", field: "projectId" } }],
          },
          trafficConfigs: {
            where: [{ id: job.configurationId, projectId: job.projectId }],
          },
        },
      );
      const prepared = await this.options.catalog.forPlace(
        frozen.record.baseline,
        frozen.config.prepared.id,
      );
      if (
        !same(prepared.identity, job.prepared) ||
        frozen.config.requestHash !== job.requestHash ||
        (await trafficContentHash(frozen.config.request)) !== job.requestHash
      )
        throw new ApiError(
          409,
          "TRAFFIC_SOURCE_CHANGED",
          "The captured graph, worker or configuration changed. Submit a newly reviewed configuration.",
        );
      if (
        (await baselineIdentity(frozen.record.baseline)).sha256 !==
          job.baselineHash ||
        (await trafficRoadEditsHash(
          frozen.record.baseline,
          frozen.scenario,
        )) !== job.roadEditsHash
      )
        throw new ApiError(
          409,
          "TRAFFIC_CONFIGURATION_STALE",
          "The saved baseline or planning-road context changed before this run started. Save and review a new configuration.",
        );
      await verifyPlanningRequest(frozen.config.request, {
        place: frozen.record.baseline,
        scenario: frozen.scenario,
        network: prepared.network.network,
      });
      const commute = await verifyPreparedCommuteRequest(
        frozen.config.request,
        prepared.network.network,
        frozen.config.request.commute
          ? ((await this.options.catalog.commutePresets?.(
              frozen.record.baseline,
              frozen.config.prepared.id,
              true,
            )) ?? [])
          : [],
      );
      await this.archive.assertCapacity();
      await check("validating");
      const output = await runTrafficExperiment(
        prepared.network,
        frozen.config.request,
        this.options.runtime,
        {
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
        },
      );
      await progress;
      await check("saving");
      if (
        output.capture.requestHash !== job.requestHash ||
        createHash("sha256")
          .update(output.files["worker.py"] ?? Buffer.alloc(0))
          .digest("hex") !== job.prepared.workerHash
      )
        throw new ApiError(
          502,
          "TRAFFIC_RESULT_MISMATCH",
          "The native output does not match the admitted request and exact worker source.",
        );
      if (commute) {
        for (const [name, raw] of Object.entries(commute.archiveFiles)) {
          if (Object.hasOwn(output.files, name))
            throw new ApiError(
              502,
              "TRAFFIC_RESULT_MISMATCH",
              "Native output collided with the retained commute evidence.",
            );
          output.files[name] = raw;
        }
        if (
          Object.keys(output.files).length > TRAFFIC_ARCHIVE_LIMITS.files ||
          Object.values(output.files).reduce(
            (total, raw) => total + raw.length,
            0,
          ) > TRAFFIC_ARCHIVE_LIMITS.bundleBytes
        )
          throw new ApiError(
            413,
            "TRAFFIC_ARCHIVE_LIMIT",
            "The complete native and commute evidence exceeds the fixed archive bound; no ledger was omitted.",
          );
      }
      publication = await this.archive.stage(job, output.files);
      const artifactId = randomUUID(),
        traffic = await createTrafficScenarioFromArchive({
          archive: this.archive,
          reference: publication.reference,
          scope: job,
          network: prepared.network,
          experiment: output.capture,
          place: frozen.record.baseline,
          scenario: frozen.scenario,
          receipt: {
            projectId: job.projectId,
            jobId: job.id,
            captureId: artifactId,
          },
        });
      await check("saving");
      await this.store.transaction(
        (state) => {
          const current = state.trafficJobs.find((j) => j.id === job.id);
          if (
            !current ||
            current.workerId !== this.workerId ||
            current.status !== "running" ||
            current.cancelRequested ||
            !creatorCanEdit(state, current) ||
            controller.signal.aborted
          )
            throw cancelled();
          const now = nowISO(),
            artifact: TrafficArtifactRecord = {
              id: artifactId,
              organizationId: job.organizationId,
              projectId: job.projectId,
              scenarioId: job.scenarioId,
              jobId: job.id,
              configurationId: job.configurationId,
              createdAt: now,
              traffic,
            };
          state.trafficArtifacts.push(artifact);
          current.result = {
            artifactId,
            captureHash: traffic.captureHash,
            archive: publication!.reference,
          };
          current.status = "completed";
          current.stage = "complete";
          current.progress = 100;
          current.version++;
          current.updatedAt = now;
          delete current.error;
          delete current.workerId;
          delete current.leaseExpiresAt;
          Object.assign(current.attempts.at(-1)!, {
            endedAt: now,
            outcome: "completed",
            elapsedMilliseconds: performance.now() - started,
          });
          releaseNativeCapacity(state, job.capacityToken!, {
            reason: "completed",
          });
        },
        { ...this.workerScope(job.id), trafficArtifacts: { append: true } },
      );
    } catch (error) {
      cleanupUncertain =
        error instanceof ApiError &&
        error.code === "NATIVE_CLEANUP_UNCONFIRMED";
      if (publication)
        try {
          retain = await this.store.read(
            (state) =>
              state.trafficJobs.some(
                (j) =>
                  j.id === job.id &&
                  same(j.result?.archive, publication!.reference),
              ),
            this.workerScope(job.id),
          );
        } catch {
          retain = true;
        }
      await this.store.transaction((state) => {
        const current = state.trafficJobs.find((j) => j.id === job.id);
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
          current.attempt < TRAFFIC_JOB_LIMITS.attempts,
        );
        if (this.stopped)
          current.error = {
            code: "TRAFFIC_INTERRUPTED",
            message:
              "The server stopped during this attempt. Retry explicitly; consumed capacity remains recorded.",
            retryable: current.attempt < TRAFFIC_JOB_LIMITS.attempts,
          };
        delete current.workerId;
        delete current.leaseExpiresAt;
        Object.assign(current.attempts.at(-1)!, {
          endedAt: now,
          outcome: current.status === "cancelled" ? "cancelled" : "failed",
          elapsedMilliseconds: performance.now() - started,
        });
        if (state.nativeCapacity.slot?.token === job.capacityToken) {
          if (cleanupUncertain)
            quarantineNativeCapacity(
              state,
              job.capacityToken!,
              "Native container termination could not be confirmed. An operator must confirm cleanup before capacity is reused.",
            );
          else if (state.nativeCapacity.slot?.status === "running")
            releaseNativeCapacity(state, job.capacityToken!, {
              reason: "confirmed-stopped",
            });
        }
      }, this.workerScope(job.id));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      this.controller = undefined;
      this.activeJobId = undefined;
      if (publication) await publication.settle(retain);
      // A database failure leaves the lease occupied. Another worker can only quarantine it, never infer native termination.
    }
  }
}
