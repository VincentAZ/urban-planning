import { trafficNativeSettings } from "./native-settings.js";
import {
  assertTrafficSignalEffects,
  assertSignalStateOutput,
  trafficSignalTimingEligibility,
} from "./signal-effects.js";
import { createHash } from "node:crypto";
import {
  canonicalJSON,
  TRAFFIC_METHOD_VERSION,
  createTrafficScenario,
  trafficContentHash,
  validateTrafficNetwork,
  type Place,
  type Scenario,
  type TrafficCapture,
  type TrafficNetwork,
  type TrafficScenario,
} from "@urban/core";
import { compareTrafficRuns, evaluateTrafficCalibration } from "@urban/models";
import {
  verifyPlanningRequest,
  planningProposalMetadata,
} from "./planning-review.js";
import { assertTrafficOverlayEffects } from "./overlay-effects.js";
import { assertTrafficEndpointEffects } from "./endpoint-effects.js";
import { verifyArchivedTrafficCommute } from "./commute-evidence.js";
import { ApiError } from "../errors.js";
import { TrafficArchive, type TrafficArchiveReference } from "./archive.js";
import {
  prepareTrafficExperiment,
  type CapturedTrafficExperiment,
} from "./experiment.js";
import type { PreparedTrafficNetwork } from "./types.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const equal = (a: unknown, b: unknown) => canonicalJSON(a) === canonicalJSON(b);
const invalid = () =>
  new ApiError(
    422,
    "TRAFFIC_CAPTURE_IDENTITY",
    "The archived traffic experiment does not match its frozen network, request or result identity. No evidence was adopted.",
  );

/** Precision is an executed converter setting, independent of manual versus derived inputs. */
export function retainedTrafficSpeedPrecision(
  network: TrafficNetwork,
  requiresSix = false,
): 2 | 6 {
  let precision: 2 | 6 = 2;
  const options = network.manifest.conversion.options;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option !== "--precision" && !option.startsWith("--precision="))
      continue;
    const value =
      option === "--precision"
        ? options[++index]
        : option.slice("--precision=".length);
    if (value !== "2" && value !== "6") throw invalid();
    precision = value === "6" ? 6 : 2;
  }
  if (requiresSix && precision !== 6) throw invalid();
  return precision;
}

/** Private archive verification is mandatory. The receipt is only a future authority lookup;
 * callers must atomically retain the returned capture in their project-owned artifact registry. */
export async function createTrafficScenarioFromArchive(input: {
  archive: TrafficArchive;
  reference: TrafficArchiveReference;
  scope: { organizationId: string; projectId: string };
  network: PreparedTrafficNetwork;
  experiment: CapturedTrafficExperiment;
  place: Place;
  scenario: Scenario;
  receipt: TrafficScenario["receipt"];
}): Promise<TrafficScenario> {
  if (input.scope.projectId !== input.receipt.projectId) throw invalid();
  const manifest = await input.archive.verify(input.scope, input.reference);
  const read = async (name: string) =>
    JSON.parse(
      (await input.archive.read(input.scope, input.reference, name)).toString(
        "utf8",
      ),
    );
  const [experiment, baselineNetwork, proposalNetwork] = await Promise.all([
    read("experiment.json") as Promise<CapturedTrafficExperiment>,
    read("baseline-network.json") as Promise<TrafficNetwork>,
    read("proposal-network.json") as Promise<TrafficNetwork>,
  ]);
  if (
    !equal(experiment, input.experiment) ||
    !equal(baselineNetwork, input.network.network)
  )
    throw invalid();
  validateTrafficNetwork(baselineNetwork);
  validateTrafficNetwork(proposalNetwork);
  const nativeFile = (name: string) =>
    manifest.files.find((file) => file.name === name);
  if (
    experiment.comparison.methodVersion !== TRAFFIC_METHOD_VERSION ||
    experiment.version !== 1 ||
    experiment.analysisScope !== "explicit-network-experiment" ||
    sha(input.network.networkXml) !==
      baselineNetwork.manifest.networkFileSha256 ||
    nativeFile("baseline.net.xml")?.sha256 !==
      experiment.recipe.baselineNetworkHash ||
    baselineNetwork.manifest.networkFileSha256 !==
      experiment.recipe.baselineNetworkHash ||
    proposalNetwork.manifest.networkFileSha256 !==
      experiment.recipe.proposalNetworkHash ||
    (nativeFile("proposal.net.xml") ?? nativeFile("baseline.net.xml"))
      ?.sha256 !== experiment.recipe.proposalNetworkHash
  )
    throw invalid();
  const prepared = await prepareTrafficExperiment(
    input.network,
    experiment.request,
  );
  await verifyPlanningRequest(experiment.request, {
    place: input.place,
    scenario: input.scenario,
    network: baselineNetwork,
  });
  assertTrafficOverlayEffects(
    baselineNetwork,
    proposalNetwork,
    experiment.request.overlays,
    retainedTrafficSpeedPrecision(
      proposalNetwork,
      (!!experiment.request.planningRoads &&
        experiment.request.overlays.length > 0) ||
        (!!experiment.request.signalTimings?.length &&
          experiment.request.overlays.length > 0),
    ),
    experiment.request.signalTimings,
  );
  if (
    experiment.request.signalTimings !== undefined ||
    prepared.allocation.vehicles.some((v) => v.endpoints) ||
    nativeFile("native-settings.json") ||
    nativeFile("signal-timing.tll.xml")
  ) {
    const settings = await read("native-settings.json");
    const worker = await input.archive.read(
      input.scope,
      input.reference,
      "worker.py",
    );
    const expected = trafficNativeSettings({
      workerSha256: sha(worker),
      overlays: experiment.request.overlays,
      ...(experiment.request.signalTimings !== undefined
        ? { signalTimings: experiment.request.signalTimings }
        : {}),
      submittedVehiclesHash: await trafficContentHash(
        prepared.allocation.vehicles,
      ),
      mappedCountsHash: await trafficContentHash(prepared.counts),
      ...(prepared.allocation.vehicles.some((v) => v.endpoints)
        ? { explicitEndpoints: true }
        : {}),
    });
    if (
      !equal(settings, expected) ||
      (await trafficContentHash(expected)) !== experiment.recipe.settingsHash
    )
      throw invalid();
  }
  assertTrafficEndpointEffects(
    baselineNetwork,
    proposalNetwork,
    prepared.allocation.vehicles,
  );
  const signalTimings = await assertTrafficSignalEffects(
    baselineNetwork,
    proposalNetwork,
    experiment.request.signalTimings ?? [],
  );
  if (signalTimings.length) {
    const proposalXml = await input.archive.read(
      input.scope,
      input.reference,
      "proposal.net.xml",
    );
    const eligibility = await trafficSignalTimingEligibility({
      ...input.network,
      network: proposalNetwork,
      networkXml: proposalXml,
    });
    for (const [index, timing] of signalTimings.entries()) {
      if (
        !eligibility.programs.find(
          (p) => p.signalId === timing.control.signalId,
        )?.eligible
      )
        throw invalid();
      for (const side of ["baseline", "proposal"] as const)
        assertSignalStateOutput(
          await input.archive.read(
            input.scope,
            input.reference,
            `${side}-signal-${index}.xml`,
          ),
          timing[side],
          experiment.recipe.period,
        );
    }
  }
  const selectedIds = prepared.counts.map((count) => count.id);
  const comparison = await compareTrafficRuns(
    experiment.baseline,
    experiment.proposal,
    experiment.recipe,
  );
  const plan = experiment.request.calibrationPlan;
  const calibration = plan
    ? evaluateTrafficCalibration(
        experiment.request.countPack,
        experiment.baseline.predictions,
        plan,
        baselineNetwork,
        experiment.request.period,
      )
    : null;
  if (
    prepared.requestHash !== experiment.requestHash ||
    prepared.networkDescriptionHash !== experiment.networkDescriptionHash ||
    prepared.demandHash !== experiment.recipe.demandHash ||
    prepared.countPackHash !== experiment.recipe.countPackHash ||
    experiment.recipe.seed !== experiment.request.seed ||
    !equal(experiment.recipe.period, experiment.request.period) ||
    experiment.recipeHash !== comparison.recipeHash ||
    !equal(comparison, experiment.comparison) ||
    !equal(calibration, experiment.calibration) ||
    !equal(experiment.allocation, {
      vehicleCount: prepared.allocation.vehicles.length,
      vehiclesHash: await trafficContentHash(prepared.allocation.vehicles),
      routeCounts: prepared.allocation.routeCounts,
      notes: prepared.allocation.notes,
    }) ||
    !equal(experiment.countSelection, {
      retained: experiment.request.countPack.counts.length,
      inAnalysisWindow: selectedIds.length,
      outsideAnalysisWindow:
        experiment.request.countPack.counts.length - selectedIds.length,
      selectedIds,
      hash: await trafficContentHash(selectedIds),
    })
  )
    throw invalid();
  const selectionHash = plan
    ? await trafficContentHash({
        calibrationCountIds: plan.calibrationCountIds,
        holdoutCountIds: plan.holdoutCountIds,
      })
    : null;
  const sourceIds = (sources: { id: string }[]) =>
    sources.length
      ? sources.map((source) => source.id)
      : ["sumo-native-evidence"];
  const mapped = experiment.request.countPack.counts.filter(
    (count) => count.target !== null,
  ).length;
  const commute = await verifyArchivedTrafficCommute({
    archive: input.archive,
    reference: input.reference,
    scope: input.scope,
    request: experiment.request,
    network: baselineNetwork,
  });
  const capture: TrafficCapture = {
    capturedAt: experiment.capturedAt,
    methodVersion: TRAFFIC_METHOD_VERSION,
    analysisScope: "explicit-network-experiment",
    privateArchive: structuredClone(input.reference),
    recipe: structuredClone(experiment.recipe),
    comparison: structuredClone(experiment.comparison),
    calibration:
      calibration && plan && selectionHash
        ? {
            status: calibration.status,
            scope: calibration.scope,
            calibration: calibration.calibration,
            holdout: calibration.holdout,
            criteria: plan.criteria,
            criteriaSourceIds: plan.sourceIds,
            criteriaDescription: plan.description,
            selectionHash,
            notes: calibration.notes,
          }
        : null,
    runs: {
      baseline: {
        diagnostics: experiment.baseline.diagnostics,
        assignedRoutesHash: experiment.baseline.assignedRoutesHash,
      },
      proposal: {
        diagnostics: experiment.proposal.diagnostics,
        assignedRoutesHash: experiment.proposal.assignedRoutesHash,
      },
    },
    network: {
      id: baselineNetwork.id,
      engine: baselineNetwork.manifest.engine,
      baselineFileSha256: experiment.recipe.baselineNetworkHash,
      proposalFileSha256: experiment.recipe.proposalNetworkHash,
      bounds: baselineNetwork.manifest.bounds,
      sourceFiles: baselineNetwork.manifest.sourceFiles,
      conversion: baselineNetwork.manifest.conversion,
      notes: baselineNetwork.manifest.notes,
    },
    originalDemand: {
      hash: experiment.recipe.demandHash,
      vehicleCount: experiment.allocation.vehicleCount,
      description: commute
        ? "Source-derived drive-alone commute subset from retained ACS joint departure estimates and LODES primary-job destination shares. Fractional unresolved, routing and window mass remains explicit; native vehicles are a deterministic integer realization, not observed dated OD or total local traffic."
        : "Explicit entered origin–destination vehicle totals and candidate routes, deterministically allocated with the retained seed. These are not observed OD movements or automatic building trip generation.",
      sourceIds: sourceIds(experiment.request.demand.sources),
      ...(commute ? { commute } : {}),
    },
    countEvidence: {
      packHash: experiment.recipe.countPackHash,
      mappedCountCount: mapped,
      unmappedCountCount: experiment.request.countPack.counts.length - mapped,
      selectionHash,
      sourceIds: sourceIds(experiment.request.countPack.sources),
    },
    proposal: {
      overlays: experiment.request.overlays,
      ...(experiment.request.signalTimings !== undefined
        ? { signalTimings }
        : {}),
      planningRoadMapping: planningProposalMetadata(
        experiment.request,
        input.scenario,
      ),
    },
    sources: experiment.sources,
    files: manifest.files.map((file) => ({
      sourceId: "sumo-native-evidence",
      url: `urn:urban:traffic:archive:${input.reference.sha256}:${file.name}`,
      sha256: file.sha256,
      bytes: file.bytes,
      retrievedAt: experiment.capturedAt,
    })),
    notes: [
      ...experiment.notes,
      ...experiment.allocation.notes,
      ...experiment.request.demand.notes,
      ...experiment.request.countPack.notes,
      `Observation selection: ${experiment.countSelection.inAnalysisWindow} in the analysis window; ${experiment.countSelection.outsideAnalysisWindow} outside it. All ${experiment.countSelection.retained} original observations remain in the private archive.`,
    ],
  };
  return createTrafficScenario({
    place: input.place,
    scenario: input.scenario,
    receipt: input.receipt,
    capture,
  });
}
