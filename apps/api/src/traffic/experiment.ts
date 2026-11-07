import { z } from "zod";
import {
  canonicalJSON,
  trafficSignalTimingsSchema,
  type TrafficSignalTiming,
  applyTrafficSignalTiming,
  trafficPlanningRoadMappingSchema,
  type TrafficPlanningRoadMapping,
  trafficContentHash,
  trafficCommuteBindingSchema,
  verifyTrafficCommuteBinding,
  type TrafficCommuteBinding,
  trafficPeriodSchema,
  trafficCountPackSchema,
  trafficDemandSchema,
  trafficOverlaySchema,
  trafficCalibrationPlanSchema,
  validateTrafficCountPack,
  validateTrafficDemand,
  validateTrafficNetwork,
  type Source,
  type TrafficPeriod,
  type TrafficCountPack,
  type TrafficDemand,
  type TrafficOverlay,
  type TrafficCalibrationPlan,
  type TrafficPairRecipe,
  type TrafficSimulationResult,
} from "@urban/core";
import {
  allocateTrafficVehicles,
  compareTrafficRuns,
  evaluateTrafficCalibration,
  type TrafficComparison,
  type TrafficCalibrationResult,
} from "@urban/models";
import { ApiError } from "../errors.js";
import type {
  PreparedTrafficNetwork,
  TrafficNativePairRequest,
  TrafficNativePair,
  TrafficNativeResources,
} from "./types.js";
import { assertPlanningControls } from "./planning-review.js";
import { assertNativeSignalTimings } from "./signal-effects.js";
import { TRAFFIC_NATIVE_LIMITS } from "./types.js";

export interface TrafficExperimentRequest {
  version: 1;
  networkHash: string;
  countPack: TrafficCountPack;
  demand: TrafficDemand;
  period: TrafficPeriod;
  seed: number;
  overlays: TrafficOverlay[];
  /** Optional server-reviewed planning correspondence; absence preserves legacy request hashes. */
  planningRoads?: TrafficPlanningRoadMapping;
  signalTimings?: TrafficSignalTiming[];
  /** Server-resolved immutable compilation; editing its demand/clock requires explicit detachment. */
  commute?: TrafficCommuteBinding;
  calibrationPlan: TrafficCalibrationPlan | null;
  /** Changes that the caller is claiming to simulate, not unrelated planning edits. */
  unsupportedChanges: string[];
}
export const trafficExperimentRequestSchema: z.ZodType<TrafficExperimentRequest> =
  z
    .object({
      version: z.literal(1),
      networkHash: z.string().regex(/^[a-f0-9]{64}$/),
      countPack: trafficCountPackSchema,
      demand: trafficDemandSchema,
      period: trafficPeriodSchema,
      seed: z.number().int().min(0).max(0x7fffffff),
      overlays: z.array(trafficOverlaySchema).max(TRAFFIC_NATIVE_LIMITS.edges),
      planningRoads: trafficPlanningRoadMappingSchema.optional(),
      signalTimings: trafficSignalTimingsSchema.optional(),
      commute: trafficCommuteBindingSchema.optional(),
      calibrationPlan: trafficCalibrationPlanSchema.nullable(),
      unsupportedChanges: z.array(z.string().min(1).max(1000)).max(100),
    })
    .strict();
export interface CapturedTrafficExperiment {
  version: 1;
  analysisScope: "explicit-network-experiment";
  capturedAt: string;
  request: TrafficExperimentRequest;
  requestHash: string;
  networkDescriptionHash: string;
  allocation: {
    vehicleCount: number;
    vehiclesHash: string;
    routeCounts: { odId: string; routeId: string; vehicles: number }[];
    notes: string[];
  };
  countSelection: {
    retained: number;
    inAnalysisWindow: number;
    outsideAnalysisWindow: number;
    selectedIds: string[];
    hash: string;
  };
  recipe: TrafficPairRecipe;
  recipeHash: string;
  comparison: TrafficComparison;
  /** Observed baseline count fit only; proposal differences are predictions, not recalibration. */
  calibration: TrafficCalibrationResult | null;
  baseline: TrafficSimulationResult;
  proposal: TrafficSimulationResult;
  resources: TrafficNativeResources;
  sources: Source[];
  notes: string[];
}
type NativeExecutor = {
  runPair: (request: TrafficNativePairRequest) => Promise<TrafficNativePair>;
};
const reject = (message: string) => {
  throw new ApiError(422, "TRAFFIC_INPUT_INVALID", message);
};
function mergedSources(groups: Source[][]): Source[] {
  const sources = new Map<string, Source>();
  for (const source of groups.flat()) {
    const previous = sources.get(source.id);
    if (previous && canonicalJSON(previous) !== canonicalJSON(source))
      reject(
        `Traffic source ${source.id} has conflicting declarations. Preserve each original source identity.`,
      );
    sources.set(source.id, source);
  }
  return [...sources.values()];
}
/** Admission validation, with no native execution or source downloads. */
export async function prepareTrafficExperiment(
  network: PreparedTrafficNetwork,
  value: TrafficExperimentRequest,
) {
  const request = trafficExperimentRequestSchema.parse(value);
  validateTrafficNetwork(network.network);
  if (request.networkHash !== network.network.manifest.networkFileSha256)
    reject(
      "The prepared traffic network changed. Review the current graph before submitting this experiment.",
    );
  if (request.commute) {
    try {
      await verifyTrafficCommuteBinding(request.commute, {
        demand: request.demand,
        period: request.period,
        network: network.network,
      });
    } catch {
      reject(
        "The prepared commute demand, clock or graph differs from its retained compilation. Explicitly detach before editing assumptions.",
      );
    }
  }
  await assertNativeSignalTimings(
    network,
    request.signalTimings ?? [],
    request.overlays,
    request.period,
  );
  if (request.signalTimings?.length) {
    const signalEvidence = request.signalTimings.map((control) => {
      const baseline = network.network.signals.find(
        (s) => s.id === control.signalId,
      )!;
      return {
        control,
        baseline,
        proposal: applyTrafficSignalTiming(baseline, control),
      };
    });
    if (
      Buffer.byteLength(
        JSON.stringify({
          overlays: request.overlays,
          planningRoads: request.planningRoads,
          signalTimings: signalEvidence,
        }),
      ) >
      96 * 1024
    )
      throw new ApiError(
        413,
        "TRAFFIC_CONTROL_CAPTURE_LIMIT",
        "Combined native control evidence exceeds the 96 KiB capture allowance. No native work started; reduce the selected controls.",
      );
  }
  if (request.planningRoads) {
    if (
      request.planningRoads.networkHash !== request.networkHash ||
      request.planningRoads.inventoryHash !==
        (await trafficContentHash(network.network))
    )
      reject(
        "Planning correspondence belongs to a different native graph or inventory.",
      );
    assertPlanningControls(request.overlays, request.planningRoads);
  }
  if (request.unsupportedChanges.length)
    reject(
      "This runtime cannot apply the declared geometry, turn, direction, or signal-control changes. No declared change was ignored.",
    );
  validateTrafficCountPack(request.countPack, network.network);
  validateTrafficDemand(request.demand, network.network, request.period);
  if (
    request.period.endSeconds +
      request.period.cooldownSeconds -
      (request.period.beginSeconds - request.period.warmupSeconds) >
    TRAFFIC_NATIVE_LIMITS.simulationSeconds
  )
    reject(
      "Warm-up, measurement and drain time together exceed the three-hour native limit.",
    );
  const edges = new Set(network.network.edges.map((edge) => edge.id));
  if (
    new Set(request.overlays.map((overlay) => overlay.edgeId)).size !==
      request.overlays.length ||
    request.overlays.some((overlay) => !edges.has(overlay.edgeId))
  )
    reject(
      "Proposal overlays must identify distinct directed edges in the prepared network.",
    );
  const sources = mergedSources([
    network.network.manifest.sources,
    request.countPack.sources,
    request.demand.sources,
  ]);
  if (sources.some((source) => source.id === "sumo-native-evidence"))
    reject(
      "The native evidence source ID is reserved; retain a distinct identity for supplied traffic evidence.",
    );
  const counts = request.countPack.counts.filter(
    (count) =>
      count.date === request.period.date &&
      count.timeZone === request.period.timeZone &&
      count.utcOffsetMinutes === request.period.utcOffsetMinutes &&
      count.beginSeconds >= request.period.beginSeconds &&
      count.endSeconds <= request.period.endSeconds,
  );
  if (counts.length > TRAFFIC_NATIVE_LIMITS.counts)
    reject(
      "The selected analysis window contains more than 1,000 count intervals. Choose a smaller explicit study; no observations were truncated.",
    );
  if (request.calibrationPlan) {
    const selected = new Set(counts.map((count) => count.id));
    if (
      [
        ...request.calibrationPlan.calibrationCountIds,
        ...request.calibrationPlan.holdoutCountIds,
      ].some((id) => !selected.has(id))
    )
      reject(
        "Every calibration and held-out observation must lie wholly inside the exact analysis date, time zone, and window.",
      );
    // This checks attribution, unique/disjoint selections and observation overlap before native work.
    evaluateTrafficCalibration(
      request.countPack,
      [],
      request.calibrationPlan,
      network.network,
      request.period,
    );
  }
  const requestedVehicles = request.demand.rows.reduce(
    (sum, row) => sum + row.vehicles,
    0,
  );
  const longestRoutes = new Map<string, number>();
  for (const route of request.demand.candidateRoutes)
    if (route.weight > 0)
      longestRoutes.set(
        route.odId,
        Math.max(longestRoutes.get(route.odId) ?? 0, route.edges.length),
      );
  const maximumSegments = request.demand.rows.reduce(
    (sum, row) => sum + row.vehicles * (longestRoutes.get(row.id) ?? 0),
    0,
  );
  if (
    requestedVehicles > TRAFFIC_NATIVE_LIMITS.vehicles ||
    maximumSegments > 1_000_000
  )
    reject(
      "The requested vehicle count or maximum candidate-route expansion exceeds native capacity. Reduce the explicit study before allocating vehicles; no requested trips were dropped.",
    );
  const allocation = allocateTrafficVehicles(
    request.demand,
    network.network,
    request.seed,
    request.period,
  );
  if (!allocation.vehicles.length)
    reject(
      "Supply explicit nonzero origin–destination demand and valid candidate routes before requesting a traffic run.",
    );
  if (
    allocation.vehicles.length > TRAFFIC_NATIVE_LIMITS.vehicles ||
    allocation.vehicles.reduce(
      (sum, vehicle) => sum + vehicle.edges.length,
      0,
    ) > 1_000_000
  )
    reject(
      "Explicit demand exceeds the bounded native vehicle or route-segment capacity. No requested trips were dropped.",
    );
  if (
    allocation.vehicles.some((vehicle) => vehicle.vehicleClass === "pedestrian")
  )
    reject(
      "Pedestrian demand needs a separate person-route runtime and cannot be converted to cars.",
    );
  return {
    request,
    requestHash: await trafficContentHash(request),
    networkDescriptionHash: await trafficContentHash(network.network),
    counts,
    allocation,
    sources,
    demandHash: await trafficContentHash(request.demand),
    countPackHash: await trafficContentHash(request.countPack),
  };
}

/** Complete deterministic input → native pair → count-fit evaluation → archive payload. */
export async function runTrafficExperiment(
  network: PreparedTrafficNetwork,
  value: TrafficExperimentRequest,
  executor: NativeExecutor,
  options: {
    signal?: AbortSignal;
    progress?: (
      stage: "validating" | "simulating" | "evaluating" | "saving",
    ) => void;
  } = {},
) {
  options.signal?.throwIfAborted();
  options.progress?.("validating");
  const input = await prepareTrafficExperiment(network, value);
  options.signal?.throwIfAborted();
  options.progress?.("simulating");
  const pair = await executor.runPair({
    network,
    period: input.request.period,
    seed: input.request.seed,
    vehicles: input.allocation.vehicles,
    counts: input.counts,
    overlays: input.request.overlays,
    ...(input.request.signalTimings !== undefined
      ? { signalTimings: input.request.signalTimings }
      : {}),
    demandHash: input.demandHash,
    countPackHash: input.countPackHash,
    unsupportedChanges: input.request.unsupportedChanges,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  if (
    pair.recipe.baselineNetworkHash !== input.request.networkHash ||
    pair.recipe.demandHash !== input.demandHash ||
    pair.recipe.countPackHash !== input.countPackHash ||
    pair.recipe.seed !== input.request.seed ||
    canonicalJSON(pair.recipe.period) !== canonicalJSON(input.request.period)
  )
    reject(
      "The returned simulation did not retain the submitted network, original demand, counts, seed, and period.",
    );
  options.progress?.("evaluating");
  const comparison = await compareTrafficRuns(
    pair.baseline,
    pair.proposal,
    pair.recipe,
  );
  if (comparison.recipeHash !== pair.recipeHash)
    reject("The returned paired recipe identity could not be verified.");
  const selectedIds = input.counts.map((count) => count.id);
  const capture: CapturedTrafficExperiment = {
    version: 1,
    analysisScope: "explicit-network-experiment",
    capturedAt: new Date().toISOString(),
    request: input.request,
    requestHash: input.requestHash,
    networkDescriptionHash: input.networkDescriptionHash,
    allocation: {
      vehicleCount: input.allocation.vehicles.length,
      vehiclesHash: await trafficContentHash(input.allocation.vehicles),
      routeCounts: input.allocation.routeCounts,
      notes: input.allocation.notes,
    },
    countSelection: {
      retained: input.request.countPack.counts.length,
      inAnalysisWindow: selectedIds.length,
      outsideAnalysisWindow:
        input.request.countPack.counts.length - selectedIds.length,
      selectedIds,
      hash: await trafficContentHash(selectedIds),
    },
    recipe: pair.recipe,
    recipeHash: pair.recipeHash,
    comparison,
    calibration: input.request.calibrationPlan
      ? evaluateTrafficCalibration(
          input.request.countPack,
          pair.baseline.predictions,
          input.request.calibrationPlan,
          network.network,
          input.request.period,
        )
      : null,
    baseline: pair.baseline,
    proposal: pair.proposal,
    resources: pair.resources,
    sources: input.sources,
    notes: [
      "This is an explicit traffic-network experiment with independently supplied demand. Building, population, and planning-road edits do not enter the simulation automatically.",
      "Only counts wholly within the selected local-clock window are evaluated. All original observations and unmapped evidence remain in the retained request.",
      "SUMO time loss is not HCM intersection control delay or level of service. Count fit alone does not validate a forecast.",
      ...(input.request.calibrationPlan
        ? []
        : [
            "No calibration or independent holdout criteria were supplied; count fit has not been assessed.",
          ]),
      ...pair.notes,
    ],
  };
  const nativeSource: Source = {
    id: "sumo-native-evidence",
    name: "SUMO captured paired traffic experiment",
    url: "https://sumo.dlr.de/docs/",
    vintage: capture.capturedAt,
    license:
      "Generated simulation evidence; original network and demand source terms still apply.",
    kind: "inferred",
    description: `SUMO ${network.network.manifest.engine.version}. Reproducible modeled outcomes, not observed traffic.`,
  };
  capture.sources = mergedSources([capture.sources, [nativeSource]]);
  const files = { ...pair.files };
  for (const [name, content] of Object.entries({
    "experiment.json": capture,
    "baseline-network.json": pair.baselineNetwork,
    "proposal-network.json": pair.proposalNetwork,
  })) {
    if (Object.hasOwn(files, name))
      reject("Native output collided with a reserved capture file.");
    files[name] = Buffer.from(canonicalJSON(content));
  }
  options.progress?.("saving");
  return { capture, files };
}
