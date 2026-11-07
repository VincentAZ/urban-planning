import { randomUUID } from "node:crypto";
import { area, polygon } from "@turf/turf";
import {
  baselineIdentity,
  studyAreaAnchor,
  studyAreaBounds,
  studyAreaPolygons,
  studyAreaSqm,
  validatePlace,
  validateBuildingEdit,
  lineWithinStudyArea,
  pointInStudyArea,
  type Place,
  type Position,
  type BaselineIdentity,
} from "@urban/core";
import type {
  PreparationJob,
  NationalPreparationCapabilities,
} from "../../../packages/core/src/national.js";
import { ApiError } from "./errors.js";
import { assertBudgetCostEvidence, budgetDashboard } from "./budget.js";
import { authorize, type Store, type DataState } from "./store.js";
import type { StoreScope } from "./store-scope.js";
import {
  CensusPlaces,
  ZCTA_LAYER,
  type ZctaFeature,
} from "./data/census-places.js";
import { fetchOsm, convertOsm } from "./data/osm.js";
import { OSM_INFERENCE_DESCRIPTION } from "./data/osm-inference.js";
import { enrichPlaceDemographics } from "./data/acs.js";
import { enrichPlaceVehicleAvailability } from "./data/acs-vehicles.js";
import { studyAreaSchema } from "../../../packages/core/src/validation.js";
import type { StudyAreaGeometry } from "../../../packages/core/src/study-area.js";

export interface PreparationRecord extends PreparationJob {
  userId: string;
  organizationId: string;
  idempotencyKey: string;
  requestKeys: string[];
  cancelRequested: boolean;
  workerId?: string;
  leaseExpiresAt?: string;
  costAdmissions?: PreparationCostAdmission[];
}
export interface PreparationCapacityDeclaration {
  mode: "fixed-capacity";
  environment: "local-development" | "deployment";
  statement: string;
}
interface PreparationCostAdmission {
  at: string;
  period: string;
  budgetPolicyVersion: number;
  incrementalExternalCents: 0;
  costModel: PreparationCapacityDeclaration;
}
function preparationAdmission(
  state: DataState,
  capacity: PreparationCapacityDeclaration | undefined,
  now = new Date(),
): PreparationCostAdmission {
  if (
    !capacity ||
    capacity.mode !== "fixed-capacity" ||
    !["local-development", "deployment"].includes(capacity.environment) ||
    capacity.statement.trim().length < 12 ||
    capacity.statement.length > 1000
  )
    throw new ApiError(
      503,
      "PREPARATION_COST_MODEL_UNCONFIGURED",
      "An operator must declare existing fixed preparation capacity before new source processing can start. Prepared places remain available.",
    );
  if (state.budget.policy.paidOperationsPaused)
    throw new ApiError(
      503,
      "PREPARATION_CAPACITY_PAUSED",
      "New place preparation is paused by the platform administrator. Prepared places remain available.",
    );
  assertBudgetCostEvidence(state.budget, now);
  const budget = budgetDashboard(state.budget, now);
  if (budget.totals.availableCents <= 0)
    throw new ApiError(
      429,
      "PREPARATION_BUDGET_EXHAUSTED",
      "The operating budget has no safe headroom for another preparation attempt. Prepared places remain available.",
    );
  if (
    capacity.environment === "deployment" &&
    state.budget.policy.fixedCostReserveCents <= 0 &&
    budget.totals.recordedFixedCents <= 0
  )
    throw new ApiError(
      503,
      "PREPARATION_FIXED_COST_UNRECORDED",
      "Record or reserve fixed deployment hosting costs before admitting place preparation.",
    );
  return {
    at: now.toISOString(),
    period: budget.period,
    budgetPolicyVersion: state.budget.policy.version,
    incrementalExternalCents: 0,
    costModel: structuredClone(capacity),
  };
}
export interface PreparationControl {
  requests: { at: string; userId: string }[];
  lastSourceRequestAt: string | null;
}
const workerSecurity = { mode: "worker", purpose: "prep" } as const;
/** HTTP callers supply their real session; omitted sessions are trusted worker/test calls only. */
function preparationCaller(
  state: DataState,
  userId: string,
  sessionHash?: string,
  organizationId?: string,
) {
  if (!sessionHash) return;
  const identity = authorize(state, sessionHash);
  if (
    identity.user.id !== userId ||
    (organizationId && identity.organization.id !== organizationId)
  )
    throw new ApiError(
      403,
      "PREPARATION_IDENTITY_CHANGED",
      "Your account workspace changed. Refresh before requesting preparation.",
    );
}
function callerScope(
  sessionHash: string | undefined,
  jobs: StoreScope["preparationJobs"],
  globalAdmission = false,
): StoreScope {
  return {
    ...(sessionHash ? { auth: { sessionHash } } : {}),
    ...(!sessionHash || globalAdmission ? { security: workerSecurity } : {}),
    ...(globalAdmission ? { budget: true as const } : {}),
    preparationJobs: jobs,
  };
}
export interface WritableCatalog {
  list(): Promise<Place[]>;
  get(id: string): Promise<Place>;
  put?(place: Place, source: unknown): Promise<BaselineIdentity>;
}
export const PREPARATION_LIMITS = {
  maxStudyAreaKm2: 50,
  maxFetchBoundsKm2: 75,
  maxElements: 40_000,
  maxResponseBytes: 25_000_000,
  jobsPerUserPerDay: 3,
  sourceRequestsPerDay: 10,
  concurrency: 1 as const,
};
export function preparationCapabilities(
  enabled: boolean,
): NationalPreparationCapabilities {
  return {
    enabled,
    mode: "bounded-public-preview",
    reason: enabled
      ? "A bounded public-source pilot: exact Census ZCTAs within the worker limits can be prepared. Larger areas and national scale require regional preprocessing."
      : "New preparation is disabled on this server. Prepared places remain free to explore; a platform operator can enable a bounded pilot or configure regional ingestion.",
    search: {
      zip: true,
      city: true,
      address: true,
      mapPoint: true,
      autocomplete: false,
    },
    limits: PREPARATION_LIMITS,
    nationalCoverageComplete: false,
    paidProviders: [],
  };
}
export function publicPreparation(record: PreparationRecord): PreparationJob {
  const {
    userId,
    organizationId,
    idempotencyKey,
    requestKeys,
    cancelRequested,
    workerId,
    leaseExpiresAt,
    costAdmissions,
    ...publicJob
  } = record;
  return publicJob;
}
const complete = (
  record: PreparationRecord,
  place: Place,
  identity: BaselineIdentity,
  now: string,
) => {
  record.status = "completed";
  record.stage = "complete";
  record.progress = 100;
  record.updatedAt = now;
  record.placeId = place.id;
  record.baselineIdentity = identity;
  delete record.error;
  delete record.workerId;
  delete record.leaseExpiresAt;
};
const aborted = () => new DOMException("Preparation cancelled", "AbortError");

export async function prepareZcta(
  zip: string,
  options: {
    census: CensusPlaces;
    signal: AbortSignal;
    progress: (
      stage: PreparationJob["stage"],
      progress: number,
    ) => Promise<void>;
    osmFetcher?: typeof fetch;
  },
): Promise<{ place: Place; warnings: string[]; source: unknown }> {
  await options.progress("boundary", 10);
  const boundary = await options.census.zcta(zip, options.signal);
  const parsedBoundary = studyAreaSchema.safeParse(boundary.geometry);
  if (!parsedBoundary.success)
    throw new ApiError(
      422,
      "CENSUS_GEOMETRY_UNSUPPORTED",
      "The complete Census boundary exceeds this worker’s geometry limits or contains unsupported topology. No boundary was simplified or dropped.",
    );
  const exact = parsedBoundary.data as StudyAreaGeometry;
  const size = studyAreaSqm(exact) / 1_000_000;
  if (size > PREPARATION_LIMITS.maxStudyAreaKm2)
    throw new ApiError(
      422,
      "STUDY_AREA_TOO_LARGE",
      `This ZCTA is ${size.toFixed(1)} km². The initial worker supports up to 50 km²; a regional preprocessing service is required for this area.`,
    );
  const bounds = studyAreaBounds(exact);
  const center = studyAreaAnchor(exact);
  const longitudePadding =
    0.1 / (111.32 * Math.max(0.1, Math.cos((center[1] * Math.PI) / 180)));
  const latitudePadding = 0.1 / 110.574;
  const fetchBounds: [number, number, number, number] = [
    Math.max(-180, bounds[0] - longitudePadding),
    Math.max(-90, bounds[1] - latitudePadding),
    Math.min(180, bounds[2] + longitudePadding),
    Math.min(90, bounds[3] + latitudePadding),
  ];
  const [west, south, east, north] = fetchBounds;
  const fetchArea =
    area(
      polygon([
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ]),
    ) / 1_000_000;
  if (fetchArea > PREPARATION_LIMITS.maxFetchBoundsKm2)
    throw new ApiError(
      422,
      "FETCH_AREA_TOO_LARGE",
      `The complete ZCTA requires a ${fetchArea.toFixed(1)} km² source envelope, above this worker’s 75 km² limit. Its disconnected pieces were not dropped.`,
    );
  const outer = [...studyAreaPolygons(exact)].sort(
    (a, b) => area(polygon([b[0]])) - area(polygon([a[0]])),
  )[0][0];
  const loadedAt = new Date().toISOString();
  const place: Place = {
    id: `zcta-${zip}-2020`,
    name: `ZIP area ${zip}`,
    city: "Census ZIP area",
    state: "US",
    zip,
    center,
    bounds,
    boundary: outer,
    studyArea: exact,
    geography: { type: "zcta", code: zip, boundaryVintage: "2020" },
    buildings: [],
    roads: [],
    sources: [
      {
        id: `census-zcta-${zip}-2020`,
        name: "U.S. Census Bureau — 2020 ZIP Code Tabulation Areas",
        url: ZCTA_LAYER,
        vintage: "2020",
        license: "U.S. Census Bureau public data",
        kind: "observed",
        description: `Exact Polygon/MultiPolygon boundary retrieved ${loadedAt}. ZCTAs approximate ZIP delivery areas; this is not a USPS service boundary. Roads are clipped to this geometry; the 100 m source-fetch buffer does not enlarge the study area.`,
      },
    ],
    coverage: [],
    loadedAt,
    extentLabel: `Census 2020 ZCTA ${zip} · exact statistical ZIP area`,
  };
  await options.progress("osm", 25);
  options.signal.throwIfAborted();
  const osm = await fetchOsm(fetchBounds, options.signal, options.osmFetcher);
  options.signal.throwIfAborted();
  const geometrySourceId = `osm-zcta-${zip}`;
  const attributeSourceId = `inference-zcta-${zip}`;
  const converted = convertOsm(
    osm.data,
    place,
    geometrySourceId,
    attributeSourceId,
  );
  place.buildings = converted.buildings;
  place.roads = converted.roads;
  const vintage = osm.data.osm3s.timestamp_osm_base;
  place.sources.push(
    {
      id: geometrySourceId,
      name: "OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      vintage,
      license: "ODbL 1.0",
      kind: "observed",
      description: `Mapped way geometry retrieved from ${osm.endpoint}. Coverage is incomplete; complex building/park relations are not yet represented. ${converted.warnings.join(" ")}`,
    },
    {
      id: attributeSourceId,
      name: "Urban Planning illustrative attribute inference v1.1",
      url: "https://www.openstreetmap.org",
      vintage,
      license: "Application-derived estimates",
      kind: "inferred",
      description: OSM_INFERENCE_DESCRIPTION,
    },
  );
  place.coverage = [
    {
      layer: "Exact ZIP statistical boundary",
      status: "available",
      description: `Complete 2020 Census ZCTA ${zip}; all polygon components and holes retained.`,
    },
    {
      layer: "Building footprints",
      status: "available",
      description: `${place.buildings.length} supported mapped building/park ways inside the exact boundary. ${converted.warnings.join(" ")}`,
    },
    {
      layer: "Street network",
      status: "available",
      description: `${place.roads.length} mapped street/path pieces clipped to the exact ZCTA; lane/speed gaps use labeled estimates.`,
    },
    {
      layer: "Building attributes & capacity",
      status: "estimated",
      description: OSM_INFERENCE_DESCRIPTION,
    },
    {
      layer: "Parcels & zoning",
      status: "unavailable",
      description: "Authoritative parcel and zoning data are not included.",
    },
    {
      layer: "Traffic & transit",
      status: "unavailable",
      description:
        "No calibrated traffic counts, intersection LOS, regional routing, or GTFS transit is included.",
    },
    {
      layer: "Employment & hazards",
      status: "unavailable",
      description:
        "No LODES employment, flood/hazard, or premium licensed data are included.",
    },
  ];
  await options.progress("demographics", 75);
  options.signal.throwIfAborted();
  const enriched = await enrichPlaceVehicleAvailability(
    await enrichPlaceDemographics(place, options.signal),
  );
  options.signal.throwIfAborted();
  try {
    validatePlace(enriched);
  } catch (error) {
    const badBuildings = enriched.buildings
      .filter((b) => !validateBuildingEdit(b, enriched).valid)
      .map((b) => b.id);
    const badRoads = enriched.roads
      .filter((r) => !lineWithinStudyArea(r.coordinates, enriched))
      .map((r) => r.id);
    throw new ApiError(
      422,
      "PREPARED_GEOMETRY_INVALID",
      "The prepared map failed its exact-boundary verification. No partial baseline was published.",
      {
        reason: error instanceof Error ? error.message : String(error),
        centerInside: pointInStudyArea(enriched.center, enriched),
        badBuildings: badBuildings.slice(0, 10),
        badRoads: badRoads.slice(0, 10),
      },
    );
  }
  return {
    place: enriched,
    warnings: [
      ...converted.warnings,
      ...enriched.coverage
        .filter((c) => c.status === "unavailable" && c.layer.includes("Census"))
        .map((c) => c.description),
    ],
    source: {
      schemaVersion: 1,
      zip,
      boundary: {
        endpoint: ZCTA_LAYER,
        vintage: "2020",
        retrievedAt: loadedAt,
        feature: boundary,
      },
      fetchBufferMeters: 100,
      fetchBounds,
      osm,
    },
  };
}

export class NationalPreparationService {
  private workerId = randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller?: AbortController;
  private activeJobId?: string;
  private stopped = false;
  constructor(
    private store: Store,
    private catalog: WritableCatalog,
    readonly census = new CensusPlaces(),
    readonly enabled = true,
    private prepare = prepareZcta,
    private minimumIntervalMs = 60_000,
    private capacity?: PreparationCapacityDeclaration,
  ) {}
  get capacityConfigured() {
    return Boolean(
      this.capacity &&
        this.capacity.mode === "fixed-capacity" &&
        ["local-development", "deployment"].includes(
          this.capacity.environment,
        ) &&
        this.capacity.statement.trim().length >= 12 &&
        this.capacity.statement.length <= 1000,
    );
  }
  start() {
    this.stopped = false;
    this.wake();
  }
  private wake() {
    if (
      this.stopped ||
      this.active ||
      this.timer ||
      !this.enabled ||
      !this.catalog.put
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.runOne().then(
        (again) => {
          this.active = undefined;
          if (again) this.wake();
        },
        () => {
          this.active = undefined;
          this.wake();
        },
      );
    }, 1000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }
  async enqueue(
    zip: string,
    key: string,
    userId: string,
    organizationId: string,
    sessionHash?: string,
  ) {
    let cached: Place | undefined;
    try {
      cached = await this.catalog.get(`zcta-${zip}-2020`);
    } catch (error) {
      if (!(error instanceof ApiError && error.statusCode === 404)) throw error;
    }
    const identity = cached ? await baselineIdentity(cached) : undefined;
    const job = await this.store.transaction(
      (state) => {
        preparationCaller(state, userId, sessionHash, organizationId);
        const existing = state.preparationJobs.find(
          (j) => j.userId === userId && j.requestKeys.includes(key),
        );
        if (existing) {
          if (existing.zip !== zip)
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This preparation request key already belongs to a different ZIP.",
            );
          return existing;
        }
        const pending = state.preparationJobs.find(
          (j) =>
            j.userId === userId &&
            j.zip === zip &&
            ["queued", "running"].includes(j.status),
        );
        if (pending) {
          pending.requestKeys.push(key);
          return pending;
        }
        if (!cached && (!this.enabled || !this.catalog.put))
          throw new ApiError(
            503,
            "PREPARATION_DISABLED",
            preparationCapabilities(false).reason,
          );
        const now = new Date().toISOString();
        const admission = cached
          ? undefined
          : preparationAdmission(state, this.capacity, new Date(now));
        const day = now.slice(0, 10);
        if (
          !cached &&
          state.preparationJobs.filter(
            (j) => j.userId === userId && j.createdAt.slice(0, 10) === day,
          ).length >= 3
        )
          throw new ApiError(
            429,
            "PREPARATION_USER_LIMIT",
            "The pilot allows three new ZIP preparation requests per account per UTC day. Prepared places stay available.",
          );
        if (
          !cached &&
          state.preparationJobs.some(
            (j) =>
              j.userId === userId && ["queued", "running"].includes(j.status),
          )
        )
          throw new ApiError(
            429,
            "PREPARATION_ALREADY_QUEUED",
            "Finish or cancel your current preparation before starting another.",
          );
        if (
          !cached &&
          state.preparationJobs.filter((j) =>
            ["queued", "running"].includes(j.status),
          ).length >= 20
        )
          throw new ApiError(
            429,
            "PREPARATION_QUEUE_FULL",
            "The preparation queue is full. Try again later.",
          );
        const record: PreparationRecord = {
          id: randomUUID(),
          zip,
          userId,
          organizationId,
          idempotencyKey: key,
          requestKeys: [key],
          cancelRequested: false,
          status: "queued",
          stage: "queued",
          progress: 0,
          attempt: 0,
          createdAt: now,
          updatedAt: now,
          warnings: [],
          ...(admission ? { costAdmissions: [admission] } : {}),
        };
        if (cached && identity) complete(record, cached, identity, now);
        state.preparationJobs.push(record);
        return record;
      },
      callerScope(sessionHash, { all: true }, true),
    );
    this.wake();
    return publicPreparation(job);
  }
  async cancel(id: string, userId: string, sessionHash?: string) {
    const result = await this.store.transaction(
      (state) => {
        preparationCaller(state, userId, sessionHash);
        const job = state.preparationJobs.find(
          (j) => j.id === id && j.userId === userId,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Preparation not found.");
        if (["completed", "failed", "cancelled"].includes(job.status))
          return publicPreparation(job);
        job.cancelRequested = true;
        job.updatedAt = new Date().toISOString();
        if (job.status === "queued") job.status = "cancelled";
        return publicPreparation(job);
      },
      callerScope(sessionHash, { where: [{ userId }] }),
    );
    if (this.activeJobId === id && result.status === "running")
      this.controller?.abort();
    return result;
  }
  async retry(id: string, key: string, userId: string, sessionHash?: string) {
    const job = await this.store.transaction(
      (state) => {
        preparationCaller(state, userId, sessionHash);
        const job = state.preparationJobs.find(
          (j) => j.id === id && j.userId === userId,
        );
        if (!job)
          throw new ApiError(404, "NOT_FOUND", "Preparation not found.");
        if (job.requestKeys.includes(key)) return job;
        if (!this.enabled || !this.catalog.put)
          throw new ApiError(
            503,
            "PREPARATION_DISABLED",
            preparationCapabilities(false).reason,
          );
        if (
          !["failed", "cancelled"].includes(job.status) ||
          job.attempt >= 3 ||
          (job.error && !job.error.retryable)
        )
          throw new ApiError(
            409,
            "PREPARATION_NOT_RETRYABLE",
            "This preparation cannot be retried. Check its source/size explanation.",
          );
        if (
          state.preparationJobs.some(
            (j) =>
              j.id !== id &&
              j.userId === userId &&
              ["queued", "running"].includes(j.status),
          )
        )
          throw new ApiError(
            429,
            "PREPARATION_ALREADY_QUEUED",
            "Another preparation is already pending.",
          );
        if (
          state.preparationJobs.some(
            (j) =>
              j.id !== id && j.userId === userId && j.requestKeys.includes(key),
          )
        )
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This request key belongs to another preparation.",
          );
        job.requestKeys.push(key);
        const admission = preparationAdmission(state, this.capacity);
        job.costAdmissions = [...(job.costAdmissions ?? []), admission];
        job.status = "queued";
        job.stage = "queued";
        job.progress = 0;
        job.cancelRequested = false;
        delete job.error;
        job.updatedAt = new Date().toISOString();
        return job;
      },
      callerScope(sessionHash, { where: [{ userId }] }, true),
    );
    this.wake();
    return publicPreparation(job);
  }
  private async runOne() {
    const gate = await this.store.read(
      (state) => ({
        pending: state.preparationJobs.some((j) =>
          ["queued", "running"].includes(j.status),
        ),
        runningUntil: state.preparationJobs.find((j) => j.status === "running")
          ?.leaseExpiresAt,
        lastRequest: state.preparationControl.lastSourceRequestAt,
      }),
      {
        security: workerSecurity,
        preparationJobs: { all: true },
        preparationControl: true,
      },
    );
    if (!gate.pending) return false;
    if (gate.runningUntil && Date.parse(gate.runningUntil) > Date.now())
      return true;
    if (
      gate.lastRequest &&
      Date.now() - Date.parse(gate.lastRequest) < this.minimumIntervalMs
    )
      return true;
    const now = new Date();
    const job = await this.store.transaction(
      (state) => {
        for (const stale of state.preparationJobs.filter(
          (j) =>
            j.status === "running" && new Date(j.leaseExpiresAt ?? 0) <= now,
        )) {
          stale.status = stale.cancelRequested
            ? "cancelled"
            : stale.attempt >= 3
              ? "failed"
              : "queued";
          stale.updatedAt = now.toISOString();
          stale.error = {
            code: "WORKER_INTERRUPTED",
            message:
              "The worker stopped before publishing a complete place. The durable request was recovered.",
            retryable: stale.attempt < 3,
          };
          delete stale.workerId;
          delete stale.leaseExpiresAt;
        }
        if (state.preparationJobs.some((j) => j.status === "running"))
          return undefined;
        if (
          state.preparationControl.lastSourceRequestAt &&
          now.getTime() -
            Date.parse(state.preparationControl.lastSourceRequestAt) <
            this.minimumIntervalMs
        )
          return undefined;
        const next = state.preparationJobs.find(
          (j) => j.status === "queued" && !j.cancelRequested,
        );
        if (!next) return undefined;
        try {
          const admission = preparationAdmission(state, this.capacity, now);
          next.costAdmissions = [...(next.costAdmissions ?? []), admission];
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          next.status = "failed";
          next.error = {
            code: error.code,
            message: error.message,
            retryable: true,
          };
          next.updatedAt = now.toISOString();
          return undefined;
        }
        const day = now.toISOString().slice(0, 10);
        const today = state.preparationControl.requests.filter(
          (r) => r.at.slice(0, 10) === day,
        );
        if (today.length >= PREPARATION_LIMITS.sourceRequestsPerDay) {
          next.status = "failed";
          next.error = {
            code: "PREPARATION_DAILY_LIMIT",
            message:
              "The pilot’s daily source-request allowance is exhausted. Retry on the next UTC day.",
            retryable: true,
          };
          next.updatedAt = now.toISOString();
          return undefined;
        }
        state.preparationControl.requests = [
          ...today,
          { at: now.toISOString(), userId: next.userId },
        ];
        state.preparationControl.lastSourceRequestAt = now.toISOString();
        next.status = "running";
        next.stage = "boundary";
        next.progress = 5;
        next.attempt++;
        next.updatedAt = now.toISOString();
        next.workerId = this.workerId;
        next.leaseExpiresAt = new Date(now.getTime() + 180_000).toISOString();
        return next;
      },
      {
        security: workerSecurity,
        preparationJobs: { all: true },
        preparationControl: true,
        budget: true,
      },
    );
    if (!job) return true;
    const controller = new AbortController();
    this.controller = controller;
    this.activeJobId = job.id;
    const heartbeat = setInterval(() => {
      void this.store
        .transaction(
          (state) => {
            const current = state.preparationJobs.find((j) => j.id === job.id);
            if (
              !current ||
              current.workerId !== this.workerId ||
              current.cancelRequested
            ) {
              controller.abort();
              return;
            }
            current.leaseExpiresAt = new Date(
              Date.now() + 180_000,
            ).toISOString();
          },
          {
            security: workerSecurity,
            preparationJobs: { where: [{ id: job.id }] },
          },
        )
        .catch(() => controller.abort());
    }, 15_000);
    heartbeat.unref();
    const progress = async (stage: PreparationJob["stage"], amount: number) => {
      await this.store.transaction(
        (state) => {
          const current = state.preparationJobs.find((j) => j.id === job.id);
          if (
            !current ||
            current.workerId !== this.workerId ||
            current.cancelRequested
          )
            throw aborted();
          current.stage = stage;
          current.progress = amount;
          current.updatedAt = new Date().toISOString();
        },
        {
          security: workerSecurity,
          preparationJobs: { where: [{ id: job.id }] },
        },
      );
    };
    try {
      let cached: Place | undefined;
      try {
        cached = await this.catalog.get(`zcta-${job.zip}-2020`);
      } catch (error) {
        if (!(error instanceof ApiError && error.statusCode === 404))
          throw error;
      }
      const result = cached
        ? { place: cached, warnings: [], source: null }
        : await this.prepare(job.zip, {
            census: this.census,
            signal: controller.signal,
            progress,
          });
      await progress("saving", 90);
      controller.signal.throwIfAborted();
      const identity = cached
        ? await baselineIdentity(cached)
        : await this.catalog.put!(result.place, result.source);
      await this.store.transaction(
        (state) => {
          const current = state.preparationJobs.find((j) => j.id === job.id);
          if (!current || current.workerId !== this.workerId) return;
          current.warnings = result.warnings;
          complete(current, result.place, identity, new Date().toISOString());
        },
        {
          security: workerSecurity,
          preparationJobs: { where: [{ id: job.id }] },
        },
      );
    } catch (error) {
      await this.store.transaction(
        (state) => {
          const current = state.preparationJobs.find((j) => j.id === job.id);
          if (!current || current.workerId !== this.workerId) return;
          current.updatedAt = new Date().toISOString();
          delete current.workerId;
          delete current.leaseExpiresAt;
          if (current.cancelRequested) {
            current.status = "cancelled";
            return;
          }
          if (this.stopped) {
            current.status = "queued";
            current.stage = "queued";
            return;
          }
          current.status = "failed";
          current.error = {
            code: error instanceof ApiError ? error.code : "PREPARATION_FAILED",
            message:
              error instanceof ApiError
                ? error.message
                : "The source request was interrupted or the prepared data could not be verified. No partial baseline was published.",
            retryable:
              current.attempt < 3 &&
              !(
                error instanceof ApiError &&
                [400, 404, 422].includes(error.statusCode)
              ),
          };
        },
        {
          security: workerSecurity,
          preparationJobs: { where: [{ id: job.id }] },
        },
      );
    } finally {
      clearInterval(heartbeat);
      this.controller = undefined;
      this.activeJobId = undefined;
    }
    return true;
  }
}
