/** Synthetic test-only traffic experiment; no observed/calibrated traffic claims or native execution. */
import {
  createTrafficScenario,
  trafficContentHash,
  trafficPairRecipeHash,
  type TrafficCapture,
  type Place,
} from "@urban/core";
import {
  createProject,
  compareTrafficRuns,
  evaluateTrafficCalibration,
} from "@urban/models";
import {
  trafficNetworkFixture,
  trafficCountFixture,
  trafficCalibrationFixture,
  trafficResultFixture,
  trafficRecipeFixture,
  trafficFixtureSource,
} from "../../packages/core/src/traffic-fixture";
export const trafficPlaceFixture: Place = {
  id: "traffic-fixture-place",
  name: "Synthetic traffic fixture",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [-112, 33],
  bounds: [-112.02, 32.98, -111.98, 33.02],
  boundary: [
    [-112.02, 32.98],
    [-111.98, 32.98],
    [-111.98, 33.02],
    [-112.02, 33.02],
    [-112.02, 32.98],
  ],
  buildings: [],
  roads: [
    {
      id: "planning-road",
      name: "Synthetic road",
      coordinates: [
        [-112.001, 33],
        [-112, 33],
      ],
      lanes: 1,
      speedMph: 25,
      oneWay: true,
      kind: "residential",
      sourceId: trafficFixtureSource.id,
    },
  ],
  sources: [trafficFixtureSource],
  coverage: [],
  loadedAt: "2026-01-12T00:00:00Z",
  extentLabel: "Synthetic test extent",
};
export async function trafficScenarioFixture() {
  const place = structuredClone(trafficPlaceFixture),
    project = createProject(place),
    scenario = project.scenarios[1],
    network = trafficNetworkFixture(),
    recipe = trafficRecipeFixture(),
    baseline = trafficResultFixture(),
    proposal = trafficResultFixture("proposal");
  baseline.recipeHash = proposal.recipeHash =
    await trafficPairRecipeHash(recipe);
  const comparison = await compareTrafficRuns(baseline, proposal, recipe),
    plan = trafficCalibrationFixture(),
    counts = trafficCountFixture(),
    fit = evaluateTrafficCalibration(
      counts,
      [
        { countId: "count-0", vehicles: 3, status: "available" },
        { countId: "count-1", vehicles: 4, status: "available" },
      ],
      plan,
      network,
      recipe.period,
    ),
    selectionHash = await trafficContentHash({
      calibrationCountIds: plan.calibrationCountIds,
      holdoutCountIds: plan.holdoutCountIds,
    });
  const capture: TrafficCapture = {
    capturedAt: "2026-01-12T10:00:00Z",
    methodVersion: "1.0.0",
    analysisScope: "explicit-network-experiment",
    privateArchive: { sha256: "7".repeat(64), bytes: 1000, fileCount: 3 },
    recipe,
    comparison,
    calibration: {
      status: fit.status,
      scope: fit.scope,
      calibration: fit.calibration,
      holdout: fit.holdout,
      criteria: plan.criteria,
      criteriaSourceIds: plan.sourceIds,
      criteriaDescription: plan.description,
      selectionHash,
      notes: fit.notes,
    },
    runs: {
      baseline: {
        diagnostics: baseline.diagnostics,
        assignedRoutesHash: baseline.assignedRoutesHash,
      },
      proposal: {
        diagnostics: proposal.diagnostics,
        assignedRoutesHash: proposal.assignedRoutesHash,
      },
    },
    network: {
      id: network.id,
      engine: network.manifest.engine,
      baselineFileSha256: recipe.baselineNetworkHash,
      proposalFileSha256: recipe.proposalNetworkHash,
      bounds: network.manifest.bounds,
      sourceFiles: network.manifest.sourceFiles,
      conversion: network.manifest.conversion,
      notes: network.manifest.notes,
    },
    originalDemand: {
      hash: recipe.demandHash,
      vehicleCount: 2,
      description: "Two explicit synthetic one-way vehicle trips.",
      sourceIds: [trafficFixtureSource.id],
    },
    countEvidence: {
      packHash: recipe.countPackHash,
      mappedCountCount: 2,
      unmappedCountCount: 0,
      selectionHash,
      sourceIds: [trafficFixtureSource.id],
    },
    proposal: {
      overlays: [],
      planningRoadMapping: {
        status: "unmapped",
        reviewedLinks: [],
        unrepresentedRoadIds: [],
        notes: [],
      },
    },
    sources: [trafficFixtureSource],
    files: [
      {
        sourceId: trafficFixtureSource.id,
        url: "urn:urban:traffic:fixture",
        sha256: "8".repeat(64),
        bytes: 1000,
        retrievedAt: "2026-01-12T10:00:00Z",
      },
    ],
    notes: ["Synthetic fixture only."],
  };
  const traffic = await createTrafficScenario({
    place,
    scenario,
    capture,
    receipt: {
      projectId: project.id,
      jobId: "fixture-job",
      captureId: "fixture-capture",
    },
  });
  return { place, project, scenario, capture, traffic, baseline, proposal };
}
